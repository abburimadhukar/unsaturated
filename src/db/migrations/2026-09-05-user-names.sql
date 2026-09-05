-- A name for each person, so the site can address them as someone.
--
-- Sign-in is a magic link and has only ever asked for an email, so the only
-- thing the site knew about anyone was an address. The header showed the bit
-- before the @, which is a username, not a name.
--
-- Stored here rather than in Supabase's own user metadata for one reason: that
-- metadata is written when an account is CREATED and ignored on every later
-- sign-in, so the four accounts that already exist could never be given a name.
-- Here it is an ordinary column that the account page can edit whenever.
--
-- Nullable on purpose. Every existing row predates this and has no name, and a
-- NOT NULL column would have to invent one. The account page prompts instead.
--
-- Safe to re-run.

alter table public.user_state add column if not exists first_name text;
alter table public.user_state add column if not exists last_name  text;

-- The site reads its own visitor row through the publishable key, so the SELECT
-- policy already in place covers these. Writes go through the secret key and
-- bypass RLS, exactly as the resume and skills do.
