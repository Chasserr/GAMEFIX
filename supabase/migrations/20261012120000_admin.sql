-- GameFix Hub — admin access.
--
-- Apply after the init migration:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/20261012120000_admin.sql
--   or paste into the Supabase SQL editor
--
-- Additive and idempotent. Adds an admins table, then widens the read/update/
-- delete rules on enquiries for members of it only. Nothing here trusts the
-- browser: every rule below is enforced by Postgres.

-- ================================================================ admins =====
-- Membership decides who can see every customer's request. It is deliberately
-- empty of policies, so it can only be read through is_admin() below or by the
-- service role. There is no way to add yourself: rows go in via SQL, by you.

create table if not exists public.admins (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  label      text        not null default '',
  created_at timestamptz not null default now()
);

comment on table public.admins is
  'Accounts allowed to read and triage every enquiry. Managed by hand, via SQL.';

alter table public.admins enable row level security;

-- Belt and braces: RLS with no policy already denies everyone, but Supabase
-- grants table privileges broadly, so strip those too.
revoke all on public.admins from anon, authenticated;

-- ============================================================== is_admin =====
-- The single question every policy below asks. Runs as the definer so it can
-- read the admins table even though the caller has no privileges on it, and it
-- only ever answers about the caller.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

comment on function public.is_admin is
  'True when the signed-in account is listed in public.admins.';

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ===================================================== enquiry permissions ==
-- The init migration allowed a customer to read their own rows and nothing else.
-- These are permissive policies, so they widen access rather than replace it:
-- a customer keeps reading their own requests, and an admin reads everything.

drop policy if exists "admins read every enquiry" on public.enquiries;
create policy "admins read every enquiry"
  on public.enquiries
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists "admins triage enquiries" on public.enquiries;
create policy "admins triage enquiries"
  on public.enquiries
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admins remove enquiries" on public.enquiries;
create policy "admins remove enquiries"
  on public.enquiries
  for delete
  to authenticated
  using (public.is_admin());

-- Matching privileges. The UPDATE grant is column-limited on purpose: an admin
-- can move a request through the workflow and leave a note, but cannot quietly
-- rewrite what the customer actually asked for.
grant update (status, notes) on public.enquiries to authenticated;
grant delete on public.enquiries to authenticated;

-- ============================================================== statistics ===
-- The view already exists; what it was missing is a safe way to be read.
--
-- By default a Postgres view runs with the privileges of its owner, which would
-- let ANY signed-in account read global totals and quietly defeat row level
-- security. security_invoker makes the view answer as the person asking, so the
-- policies above decide what they see: everything for an admin, their own rows
-- for everyone else, nothing at all when signed out.

alter view public.enquiry_stats set (security_invoker = true);

grant select on public.enquiry_stats to authenticated;
revoke all on public.enquiry_stats from anon;
