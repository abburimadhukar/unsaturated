-- Take the write RPC away from the public internet.
--
-- `record_exclusions` is SECURITY DEFINER — it runs as `postgres` and bypasses
-- row level security entirely — and Postgres grants EXECUTE to PUBLIC on every
-- new function by default. The original migration granted it to service_role
-- and, reasonably enough, assumed that was the grant. It was an ADDITION to a
-- default that already let everyone in.
--
--   record_exclusions  security_definer=true  anon=X/postgres
--
-- PostgREST exposes everything in `public`, so that grant means anyone holding
-- the publishable key can POST to /rest/v1/rpc/record_exclusions and write rows
-- into the exclusions table. The publishable key is not a secret: it ships in
-- the site's JavaScript, which is the whole point of it.
--
-- Verified against production on 24 Sep with an EMPTY array, which the function
-- filters to zero rows, so the check wrote nothing:
--
--   curl -X POST .../rpc/record_exclusions -d '{"p_rows":[]}'  ->  HTTP 200
--
-- The damage is not data theft — the table is already publicly readable and
-- holds no personal data. It is WRITE. The rows are (reason, title) text with
-- no length bound beyond the app's own normalisation, which an attacker is not
-- obliged to use, and the database has a 500 MB ceiling it spent this week
-- bouncing off. Filling that table is a way to take the site read-only.
--
-- `enforce_seat_limit` goes too. It is a trigger function, so calling it
-- directly raises an error rather than doing anything useful, but a trigger
-- body has no business being reachable over HTTP at all.
--
-- WHAT STAYS EXECUTABLE, AND WHY
--
--   feed_page, feed_facets  the site's own reads, called with the publishable
--                           key on every page view. Read-only.
--   seats_taken             called by src/state/auth.ts through the publishable
--                           key before sign-in. Returns a count, writes nothing.
--
-- service_role keeps its explicit grant, so the crawler is unaffected.
--
-- Safe to re-run.

revoke execute on function public.record_exclusions(jsonb) from public, anon, authenticated;
revoke execute on function public.enforce_seat_limit() from public, anon, authenticated;

-- A function used inside an index expression must resolve the same way for
-- every caller, forever. `stack_of` is the expression behind jobs_stack_idx and
-- had a mutable search_path, so what it resolved to depended on who called it —
-- which for an indexed expression is a correctness hazard, not just a hardening
-- note. Pinned to the schema it was written against.
alter function public.stack_of(text[]) set search_path to 'public';
