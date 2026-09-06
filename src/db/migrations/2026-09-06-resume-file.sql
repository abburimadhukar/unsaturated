-- Resume files: let people upload a PDF or DOCX instead of pasting text.
--
-- Two halves. Three columns on user_state to remember WHICH file, and a private
-- Supabase Storage bucket to hold it.
--
-- The file and the extracted text are kept apart on purpose. Replacing the file
-- must not drop the skills already matched, and pasting text must not drop the
-- file — the same rule the name already follows, for the same reason: three
-- write paths share one row and none of them may erase another's work.
--
-- The text itself is still never stored. Only the skills extracted from it and
-- a character count, exactly as before. The file is the one new thing being
-- kept, and it is kept because the person asked us to.
--
-- Safe to re-run.

begin;

alter table public.user_state add column if not exists resume_name text;
alter table public.user_state add column if not exists resume_size integer;
alter table public.user_state add column if not exists resume_path text;

-- PRIVATE. A public bucket would put every CV behind a guessable URL with no
-- sign-in at all; downloads go through a short-lived signed link instead.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes',
  'resumes',
  false,
  5242880,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No policies on storage.objects for this bucket, deliberately.
--
-- Every read and write goes through the site's own routes, which hold the
-- service key and check the signed-in session first. Adding an anon policy here
-- would open a second door to the same files governed by weaker rules than the
-- one already guarding them.

commit;
