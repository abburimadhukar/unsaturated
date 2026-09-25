-- Remove the storage behind two features that are gone: resume tailoring and
-- the job-matching fingerprints.
--
-- APPLY ONLY AFTER THE SITE IS DEPLOYED AND A CRAWL HAS RUN ON THE NEW CODE.
-- The old site writes resume_text on every resume upload and treats a failed
-- write as an error the person sees; the old crawler writes job_embedding every
-- run. Dropping these first would break the old code while it is still live.
-- Dropping them after means nothing is left that touches them.
--
-- WHAT GOES
--
--   job_embedding          ~200 MB, 40% of the database on 25 Sep 2026. One
--                          384-number vector per job from Cloudflare Workers AI.
--                          Written by every crawl and never read: no query
--                          selected the vector, nothing compared vectors, and
--                          "Best match" never used them. Half of a matching
--                          feature whose other half was never built.
--   user_state.resume_embedding, resume_model, resume_embedded_at
--                          Where a resume's vector would have gone. 0 of 9
--                          people ever had one; no code read or wrote them.
--   user_state.resume_version
--                          For cached per-job match explanations that were
--                          never built. No code read or wrote it.
--   user_state.resume_text The full text of each uploaded CV. Only resume
--                          tailoring read it. Two people had one stored; with
--                          tailoring gone, a private CV nobody reads is a
--                          liability with no use, so it is deleted rather than
--                          left behind.
--
-- WHAT STAYS
--
--   user_state.skills, resume_chars   Best match reads the skills.
--   resume_name / resume_size / resume_path, and the file in storage
--                                     The Account page's upload / download /
--                                     delete of the resume file itself.
--   The `vector` extension            Harmless, and what vector search would
--                                     need if it is ever built properly.
--
-- Checked before writing this: no function, view, policy or foreign key in the
-- database refers to any of these, other than job_embedding's own key into
-- `jobs`, which goes with the table.
--
-- Safe to re-run.

drop table if exists public.job_embedding;

alter table public.user_state
  drop column if exists resume_embedding,
  drop column if exists resume_model,
  drop column if exists resume_embedded_at,
  drop column if exists resume_version,
  drop column if exists resume_text;
