-- What the crawl throws away, so the 93% discard rate can be checked.
--
-- Each hourly crawl reads ~240,000 postings and keeps ~16,000. The rest were
-- discarded with no record, which made two very different outcomes look
-- identical: a Registered Nurse correctly rejected, and a Cloud Operations
-- Engineer rejected by a rule with a bug in it.
--
-- Not hypothetical. Sampling 120 boards by hand found four rules that matched
-- nothing at all — a word-boundary error meant `systems? admin` could never
-- match "Systems Administrator"; "Solutions Architect" only counted with
-- "cloud" in front; "Applications Engineer" only matched the plural; and
-- Forward Deployed Engineer and AI Engineer, ~170 live postings, matched no
-- rule whatsoever. That took an afternoon and covered 1% of the registry.
--
-- Counts, not rows. 224,000 rows an hour is neither worth storing nor worth
-- reading; the crawl folds them in memory first, so a run writes a few thousand
-- totals of the form "rule X rejected 340 things called Cloud Operations
-- Engineer" — which is the shape the question is actually asked in.
--
-- Safe to re-run.

create table if not exists public.exclusions (
  -- Which rule dropped it: an exclusion label such as 'sales' or 'manual', or
  -- 'no family matched' when nothing excluded it and no family claimed it. The
  -- second is the interesting case and was previously indistinguishable from
  -- the first.
  reason         text not null,
  -- Normalised in the application: lowercased, bracketed noise and trailing
  -- location qualifiers stripped, whitespace squeezed. Nothing that changes
  -- which words are present — the point is to read the words back.
  title          text not null,
  n              bigint not null default 0,
  sample_company text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  primary key (reason, title)
);

-- The only question this table is asked: "what are we rejecting most of?"
create index if not exists exclusions_reason_n_idx
  on public.exclusions (reason, n desc);
create index if not exists exclusions_n_idx
  on public.exclusions (n desc);

-- ---------------------------------------------------------------------------
-- record_exclusions — add a crawl's tally to the running totals
--
-- An RPC rather than an upsert from the client, because PostgREST cannot
-- express `set n = n + excluded.n`: an upsert would REPLACE each count with the
-- latest crawl's, so a title rejected 300 times an hour would sit at 300
-- forever and the totals would mean nothing.
--
-- The input is grouped before insert. Postgres rejects an ON CONFLICT that
-- touches the same row twice in one statement, and two postings normalising to
-- the same title in one crawl is the common case, not the edge case.
-- ---------------------------------------------------------------------------
create or replace function public.record_exclusions(p_rows jsonb)
returns integer
language sql
security definer
set search_path to 'public'
as $function$
  with input as (
    select reason, title, sum(n) as n, min(sample_company) as sample_company
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
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
          -- Kept only if we never had one; the first example is as good as the
          -- hundredth and rewriting it every hour is a pointless write.
          sample_company = coalesce(e.sample_company, excluded.sample_company)
    returning 1
  )
  select count(*)::int from upserted;
$function$;

-- Readable by anyone, writable only by the crawler holding the secret key —
-- the same rule the rest of the schema follows.
alter table public.exclusions enable row level security;

drop policy if exists "exclusions are publicly readable" on public.exclusions;
create policy "exclusions are publicly readable" on public.exclusions
  for select to anon, authenticated using (true);

grant execute on function public.record_exclusions(jsonb) to service_role;
