-- Institutional employers: universities, hospitals, charities, public bodies.
--
-- These employers are structurally short of technical staff. 66% of health-IT
-- professionals report persistent shortages, and university technology leaders
-- lose candidates to tech firms on pay and flexibility. That is a standing
-- condition rather than a cycle, so their postings draw fewer applicants for
-- reasons that will not change.
--
-- WHY THIS COLUMN HAS TO EXIST AT ALL
--
-- Every identifier already in this database fails to find them. Measured:
--
--   employer name ("University of…")      18 of 33,061 jobs   0.1%
--   employer website domain (.edu, .org)  569 of 23,958 boards, ZERO .edu
--   pattern-matching the ATS token        4.6% of boards, and the wrong ones
--
-- `company` is not a company name, it is the ATS slug: Harvard is "harvard",
-- Michigan is "umich", Ace Hardware is "ACE1002CORP". UKG — the system US
-- hospitals and school districts actually run on — returns no employer name at
-- all, confirmed against its live API.
--
-- And slug matching is confidently wrong: searching "health" and "foundation"
-- returned alpacahealth, bayesianhealth, ambiencehealthcare and aptosfoundation
-- — venture-funded startups and a crypto foundation.
--
-- The answer is the advert's own language, which only exists during the crawl
-- because descriptions are never stored. So it is decided there and the verdict
-- is kept here. Validated against live boards: 6 of 6 Cornell postings correct,
-- and 17 of 17 health-tech startup postings correctly refused.
--
-- A plain column, and deliberately no function change. Adding a parameter to
-- feed_page means dropping and recreating it, because Postgres treats an added
-- default parameter as an overload and calls with the old argument count then
-- become ambiguous. Nothing here touches a function, so the existing feed
-- cannot change behaviour.
--
-- Fills in over the next few crawls rather than at once: a row is only rewritten
-- when its board is next read. Until then the value is null, which the page
-- reports honestly as "not yet assessed" rather than as "not an institution".
--
-- Safe to re-run.

begin;

alter table public.jobs add column if not exists sector text;

-- Partial, and ordered the way the page reads it: one sector, newest first,
-- open roles only. Null is the overwhelming majority and is never queried, so
-- it is excluded from the index entirely.
create index if not exists jobs_sector_idx
  on public.jobs (sector, posted_at desc)
  where closed_at is null and sector is not null;

commit;
