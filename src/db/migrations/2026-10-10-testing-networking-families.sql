-- Testing and Networking become families of their own.
--
-- Until 10 Oct 2026 "QA / Test Automation" was a specialization of Software
-- (qa_test) and "Networking" a specialization of Cloud. They are now top-level
-- families beside cloud/software/data/hris, each with its own specializations.
-- See src/taxonomy/families.ts and src/taxonomy/specializations.ts.
--
-- The ONLY schema change this needs is the specialization CHECK constraint.
-- `family` and `specialization` are plain text columns that already exist, and
-- jobs_family_idx / jobs_family_specialization_idx index whatever value is
-- written — a new family needs no new column and no new index.
--
-- ORDER OF OPERATIONS MATTERS. Apply this BEFORE deploying the new crawler
-- code. The constraint below is what lets a row be written with
-- family='testing' or family='networking'; the OLD constraint rejects those
-- outright, so a crawl running the new classifier against the old constraint
-- would fail its jobs upsert. A deploy-before-migrate does not take the live
-- site down (reads are unaffected), but the hourly crawl's writes will error
-- until this runs. Migrate first, then deploy.
--
-- Safe to re-run. It never deletes a row and never rewrites family or
-- specialization — the crawl re-files existing rows into the new families as it
-- re-reads each board, exactly as `region` populated with no backfill.

-- ---------------------------------------------------------------------------
-- A specialization must belong to its family
-- ---------------------------------------------------------------------------
-- Dropped and recreated rather than altered: a CHECK cannot be modified in
-- place. The new definition adds the testing and networking families and keeps
-- the legacy qa_test (software) and networking (cloud) pairs VALID, so the
-- validation below still passes on a table full of pre-migration rows and any
-- row the crawler is mid-flight on stays legal. Those legacy pairs are no
-- longer written — the classifier stopped producing them — so they drain away
-- within a crawl cycle on their own; tolerating them here just means the
-- transition has no window in which a write can fail.
alter table public.jobs drop constraint if exists jobs_specialization_family_chk;

alter table public.jobs add constraint jobs_specialization_family_chk check (
  specialization is null
  or (family = 'software' and specialization in (
        'frontend','backend','fullstack','mobile','qa_test',
        'application_integration','embedded_systems','general_software'))
  or (family = 'cloud' and specialization in (
        'devops_sre','platform_engineering','cloud_infrastructure','networking',
        'cloud_security','systems_storage','finops','general_cloud'))
  or (family = 'data' and specialization in (
        'data_engineering','analytics_bi','data_science','ml_engineering',
        'mlops','database_administration','general_data'))
  or (family = 'hris' and specialization in (
        'workday','successfactors','oracle_hcm','ukg','payroll_benefits','general_hris'))
  or (family = 'testing' and specialization in (
        'test_automation','manual_qa','performance_testing','qa_management','general_testing'))
  or (family = 'networking' and specialization in (
        'network_engineering','network_operations','network_security',
        'network_architecture','wireless_telecom','cloud_sdn'))
) not valid;

-- NOT VALID above, VALIDATE separately: the add is then instant and the scan is
-- a second statement, which keeps the file re-runnable on a table that has
-- since filled. Every existing row satisfies the new constraint (the legacy
-- pairs are still allowed), so this passes without rewriting anything.
alter table public.jobs validate constraint jobs_specialization_family_chk;
