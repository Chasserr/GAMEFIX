-- GameFix Hub — core schema.
--
-- Apply with either:
--   supabase db push                     (linked CLI project)
--   psql "$SUPABASE_DB_URL" -f this file
--   or paste into the Supabase SQL editor
--
-- This migration is additive and idempotent: it creates new objects and never
-- drops or rewrites anything, so it is safe to run against a live database.

create extension if not exists pgcrypto with schema extensions;

-- =========================================================== enquiries ======
-- One row per quote request, whether it came from a signed-in customer or a
-- guest. `user_id` links it to an account when there is one.

create table if not exists public.enquiries (
  id            uuid        primary key default gen_random_uuid(),
  reference     text        not null unique,
  created_at    timestamptz not null default now(),
  user_id       uuid        references auth.users (id) on delete set null,
  name          text        not null,
  email         text        not null,
  phone         text,
  service       text        not null,
  budget        text,
  urgency       text        not null default 'standard',
  contact_by    text        not null default 'email',
  message       text        not null,
  build_summary text,
  parts         jsonb,
  status        text        not null default 'new',
  notes         text        not null default '',

  constraint enquiries_urgency_check   check (urgency in ('standard', 'soon', 'urgent')),
  constraint enquiries_contact_check   check (contact_by in ('email', 'whatsapp', 'phone')),
  constraint enquiries_status_check    check (status in ('new', 'read', 'replied', 'won', 'archived')),
  constraint enquiries_name_length     check (char_length(btrim(name)) between 2 and 120),
  constraint enquiries_email_shape     check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),
  constraint enquiries_message_length  check (char_length(btrim(message)) between 10 and 4000)
);

comment on table public.enquiries is
  'Quote requests submitted from the website. Guests may insert, customers may read their own.';

create index if not exists enquiries_created_at_idx on public.enquiries (created_at desc);
create index if not exists enquiries_user_id_idx    on public.enquiries (user_id);
create index if not exists enquiries_status_idx     on public.enquiries (status);
create index if not exists enquiries_email_idx      on public.enquiries (lower(email));

-- ================================================== row level security ======
-- Read your own requests and nobody else's. There is deliberately no INSERT,
-- UPDATE or DELETE policy: writes go through submit_enquiry() below, and the
-- owner reads everything through the service role, which bypasses RLS.

alter table public.enquiries enable row level security;

drop policy if exists "customers read their own enquiries" on public.enquiries;
create policy "customers read their own enquiries"
  on public.enquiries
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Do not rely on RLS alone: remove the table privileges too.
revoke all on public.enquiries from anon;
revoke insert, update, delete, truncate, references on public.enquiries from authenticated;
grant  select on public.enquiries to authenticated;

-- ================================================ submission function =======
-- The only way to create an enquiry. Runs as the owner, so it can insert even
-- though the caller has no INSERT privilege, and it validates on the server
-- rather than trusting the browser.

create or replace function public.submit_enquiry(
  p_name          text,
  p_email         text,
  p_service       text,
  p_message       text,
  p_phone         text    default null,
  p_budget        text    default null,
  p_urgency       text    default 'standard',
  p_contact_by    text    default 'email',
  p_build_summary text    default null,
  p_parts         jsonb   default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference text;
  v_recent    integer;
  v_parts     jsonb;
begin
  -- Trim everything so stored values are exactly what was validated.
  p_name          := btrim(coalesce(p_name, ''));
  p_email         := lower(btrim(coalesce(p_email, '')));
  p_service       := btrim(coalesce(p_service, ''));
  p_message       := btrim(coalesce(p_message, ''));
  p_phone         := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  p_budget        := nullif(btrim(coalesce(p_budget, '')), '');
  p_build_summary := nullif(btrim(coalesce(p_build_summary, '')), '');
  p_urgency       := lower(btrim(coalesce(p_urgency, 'standard')));
  p_contact_by    := lower(btrim(coalesce(p_contact_by, 'email')));

  if char_length(p_name) < 2 or char_length(p_name) > 120 then
    raise exception 'Please enter your name.' using errcode = '22023';
  end if;

  if p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' or char_length(p_email) > 160 then
    raise exception 'That email address does not look right.' using errcode = '22023';
  end if;

  if char_length(p_service) < 2 or char_length(p_service) > 80 then
    raise exception 'Please choose what you need.' using errcode = '22023';
  end if;

  if char_length(p_message) < 10 or char_length(p_message) > 4000 then
    raise exception 'Please describe the job in at least 10 characters.' using errcode = '22023';
  end if;

  if p_urgency not in ('standard', 'soon', 'urgent') then
    p_urgency := 'standard';
  end if;

  if p_contact_by not in ('email', 'whatsapp', 'phone') then
    p_contact_by := 'email';
  end if;

  if p_contact_by in ('whatsapp', 'phone')
     and (p_phone is null or char_length(p_phone) < 6) then
    raise exception 'Please add a phone number for a WhatsApp or phone reply.' using errcode = '22023';
  end if;

  -- Keep the attached build plan sane: an array of at most 24 entries.
  v_parts := case
    when p_parts is null or jsonb_typeof(p_parts) <> 'array' then null
    else (select coalesce(jsonb_agg(value), '[]'::jsonb)
            from (select value from jsonb_array_elements(p_parts) limit 24) trimmed)
  end;

  -- Light server-side throttle, per email address.
  select count(*) into v_recent
    from public.enquiries
   where lower(email) = p_email
     and created_at > now() - interval '1 hour';

  if v_recent >= 5 then
    raise exception 'You have already sent several requests. Please wait a little or message us on WhatsApp.'
      using errcode = '55006';
  end if;

  insert into public.enquiries (
    reference, user_id, name, email, phone, service, budget,
    urgency, contact_by, message, build_summary, parts
  )
  values (
    'GFH-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    auth.uid(),
    p_name, p_email, p_phone, p_service, p_budget,
    p_urgency, p_contact_by, p_message, p_build_summary, v_parts
  )
  returning reference into v_reference;

  return v_reference;
end;
$$;

comment on function public.submit_enquiry is
  'Validates and stores one website enquiry, returning its reference. Callable by anyone.';

-- Guests must be able to submit; nobody needs to replace or drop the function.
revoke all on function public.submit_enquiry(text, text, text, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.submit_enquiry(text, text, text, text, text, text, text, text, text, jsonb)
  to anon, authenticated;

-- ============================================ owner convenience view ========
-- Handy in the Table Editor; RLS still applies to whoever queries it.

create or replace view public.enquiry_stats as
  select
    count(*)                                                          as total,
    count(*) filter (where status = 'new')                            as unread,
    count(*) filter (where urgency = 'urgent')                        as urgent,
    count(*) filter (where status = 'won')                            as won,
    count(*) filter (where created_at > now() - interval '7 days')    as last_week,
    count(*) filter (where user_id is not null)                       as from_accounts
  from public.enquiries;

revoke all on public.enquiry_stats from anon, authenticated;
