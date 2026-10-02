-- Make the exclusions tally cheap WITHOUT losing a single rejected title,
-- and shut the door that lets anyone on the internet write to it.
--
-- TWO PROBLEMS, ONE TABLE. Measured against production on 2 Oct 2026.
--
-- 1. COST. `record_exclusions` is the single most expensive thing in this
--    database that nobody reads:
--
--      record_exclusions   6,613 calls   mean 1,477 ms   max 7,954 ms
--                          9,769 s total = 16% OF ALL DATABASE TIME
--
--    (pg_stat_statements, 34-day window since 2026-08-29.) For comparison the
--    whole website — feed_facets at 12% and feed_page at 7% — is 19%.
--
--    And it is 49 MB of a 231 MB database living in a 224 MB shared_buffers.
--    Every page of it held in cache is a page of `jobs` evicted, and a `jobs`
--    page read from disk instead of cache is the difference between 16 ms and
--    508 ms on the same count.
--
-- 2. GRANT. `record_exclusions` is SECURITY DEFINER and `anon` can still
--    execute it. Verified on 2 Oct:
--
--      has_function_privilege('anon', 'public.record_exclusions(jsonb)', 'EXECUTE')  ->  true
--
--    2026-09-24-revoke-write-rpc.sql was written to close exactly this and did
--    not take on this function — `enforce_seat_limit` came back false, so the
--    file was applied partially or the function was recreated afterwards
--    (DROP + CREATE resets the ACL to PUBLIC; CREATE OR REPLACE does not).
--    The hole is open right now: the publishable key ships in the site's
--    JavaScript, so anyone can POST unbounded (reason, title) rows into the
--    table that is already 21% of the database — a way to push a 500 MB
--    database over its ceiling and take the site read-only.
--
-- WHERE THE COST ACTUALLY IS, AND WHY THE OBVIOUS FIX WAS WRONG
--
-- The first version of this migration wrote the whole tally once a day instead
-- of once per crawl. That is the wrong trade, and the numbers say so:
--
--      exclusions, 34 days:   394,026 rows INSERTED
--                          16,841,852 rows UPDATED
--
--    98% of the cost is re-writing rows that already exist. Adding a genuinely
--    new title is almost free.
--
--    And the rare titles are the whole point. 232,505 pairs are stored, 197,158
--    of them seen ten times or more — a settled list. But 5,251 have been seen
--    ONCE, and a rule with a bug in it usually drops an uncommon title. Writing
--    one crawl in five would have missed about four out of five of those, which
--    quietly weakens the only instrument that catches a broken rule. That
--    matters most exactly when a new family is added to the taxonomy.
--
-- SO: TWO SPEEDS.
--
--   Every crawl      ON CONFLICT DO NOTHING — new (reason, title) pairs only.
--                    No row is ever missed. Existing rows are probed against
--                    the primary key and skipped: no heap write, no index
--                    write, no WAL. This is the 98% that disappears.
--
--   Once per window  ON CONFLICT DO UPDATE — the full pass that accumulates
--                    `n`, refreshes `last_seen_at` and backfills a missing
--                    `sample_company`. A window opens when the last one is 20
--                    hours old and stays open 30 minutes, so every shard and
--                    every chunk of one crawl lands inside it.
--
-- What this costs you: `n` accumulates once a day rather than five times, so
-- the absolute figure is roughly a fifth of what it would have been. It was
-- never a count of real postings — it is a cumulative total across every crawl
-- ever run, already reading 38.5 million — and because every rule is sampled on
-- the same days the RELATIVE proportions, which is what the report sorts and
-- percentages by, are unchanged. `last_seen_at` moves daily rather than hourly.
--
-- The crawler is UNCHANGED. It still calls this RPC on every run and still gets
-- an integer back; on a non-window crawl that integer is the number of NEW
-- titles, which is a more useful thing to log than "we rewrote everything".
--
-- Nothing is deleted and nothing is dropped. Retention is deliberately NOT
-- added here — trimming rows is the owner's call, taken separately.
--
-- Safe to re-run.

begin;

-- When the current full-pass window opened. One row, like facet_snapshot.
create table if not exists public.exclusions_run (
  id                boolean primary key default true check (id),
  window_started_at timestamptz not null default now()
);

-- RLS on with no policies, matching every other table here. The function below
-- is SECURITY DEFINER and runs as the owner, which bypasses RLS, so the crawl
-- is unaffected while the table stays unreachable over PostgREST.
alter table public.exclusions_run enable row level security;

-- Seeded far in the past so the very next crawl runs a full pass rather than
-- waiting 20 hours for the first one.
insert into public.exclusions_run (id, window_started_at)
values (true, '1970-01-01T00:00:00Z')
on conflict (id) do nothing;

-- CREATE OR REPLACE, never DROP + CREATE: replacing preserves the grants, and
-- dropping would hand EXECUTE back to PUBLIC — which is the most likely way
-- this function lost its revoke in the first place.
create or replace function public.record_exclusions(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now     timestamptz := now();
  v_started timestamptz;
  v_full    boolean := false;
  v_written int;
begin
  -- Nothing to record. Returns before touching the marker, so an empty call
  -- cannot burn a window the real tally is about to need.
  if p_rows is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select window_started_at into v_started from public.exclusions_run where id;

  if v_started is null or v_now - v_started >= interval '20 hours' then
    -- Due: open a window. The other shards and the remaining chunks of this
    -- crawl fall into the branch below and are part of the same full pass.
    update public.exclusions_run set window_started_at = v_now where id;
    v_full := true;
  elsif v_now - v_started <= interval '30 minutes' then
    -- Still inside the open window.
    v_full := true;
  end if;

  if v_full then
    -- The full pass: counts accumulate, last_seen_at moves, a missing sample
    -- company is backfilled. Once a day.
    with input as (
      select reason, title, sum(n) as n, min(sample_company) as sample_company
      from jsonb_to_recordset(p_rows)
        as x(reason text, title text, n bigint, sample_company text)
      where reason is not null and title is not null and title <> ''
      group by reason, title
    ),
    upserted as (
      insert into public.exclusions as e (reason, title, n, sample_company)
      select reason, title, n, sample_company from input
      on conflict (reason, title) do update
        set n            = e.n + excluded.n,
            last_seen_at = now(),
            -- Kept only if we never had one; the first example is as good as
            -- the hundredth and rewriting it every hour is a pointless write.
            sample_company = coalesce(e.sample_company, excluded.sample_company)
      returning 1
    )
    select count(*)::int into v_written from upserted;
  else
    -- Every other crawl: record titles we have never seen, and touch nothing
    -- else. A conflicting row is probed against the primary key and skipped —
    -- no heap write, no index write, no WAL. This is where the 16% goes.
    --
    -- A new row takes its `n` from this crawl and its timestamps from the
    -- column defaults, so a title first seen here is complete and correct; it
    -- simply does not accumulate again until the next full pass.
    with input as (
      select reason, title, sum(n) as n, min(sample_company) as sample_company
      from jsonb_to_recordset(p_rows)
        as x(reason text, title text, n bigint, sample_company text)
      where reason is not null and title is not null and title <> ''
      group by reason, title
    ),
    inserted as (
      insert into public.exclusions as e (reason, title, n, sample_company)
      select reason, title, n, sample_company from input
      on conflict (reason, title) do nothing
      returning 1
    )
    select count(*)::int into v_written from inserted;
  end if;

  return coalesce(v_written, 0);
end;
$function$;

-- The grant, re-applied. PostgREST exposes everything in `public`, so without
-- this a SECURITY DEFINER write function is reachable with the publishable key.
-- service_role keeps its grant, so the crawler is unaffected.
revoke execute on function public.record_exclusions(jsonb) from public, anon, authenticated;
grant execute on function public.record_exclusions(jsonb) to service_role;

commit;
