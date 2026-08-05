-- =====================================================================
-- Org chart — database setup
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: everything is create-if-not-exists / create-or-replace.
--
-- What this creates:
--   public.org_positions      the chart itself (app owns this, admins edit it)
--   public.org_admins         who is allowed to edit
--   public.employee_directory a read-only window onto mart.employees
--
-- NOTHING here writes to mart.employees. Your Ajera pipeline stays the
-- source of truth for who exists; this app only owns the shape of the chart.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------

-- Every read in this app is gated on the caller's email domain. Change the
-- domain in this ONE function if it ever needs to change.
create or replace function public.org_email_allowed()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') ilike '%@criticalarccx.com';
$$;

comment on function public.org_email_allowed() is
  'True when the logged-in user has a company email address. Gates all reads.';


-- ---------------------------------------------------------------------
-- 1. Who can edit
-- ---------------------------------------------------------------------
-- Keyed by email, not user id, so you can grant admin to someone who has
-- never logged in yet.

create table if not exists public.org_admins (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- >>> EDIT THIS LIST: one row per admin. <<<
-- These must match the Google account each person signs in with, exactly.
-- A typo here fails silently: they sign in fine and just see "View only".
insert into public.org_admins (email, note) values
  ('kspann@criticalarccx.com',   'initial admin'),
  ('arclab@criticalarccx.com',   'admin'),
  ('fsalinas@criticalarccx.com', 'admin')
on conflict (email) do nothing;

-- To add or remove an admin later, no redeploy needed — just:
--   insert into public.org_admins (email) values ('new.person@criticalarccx.com');
--   delete from public.org_admins where email = 'someone@criticalarccx.com';

create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.org_admins
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

comment on function public.is_org_admin() is
  'True when the logged-in user may edit the chart. Called by RLS and by the UI.';

grant execute on function public.is_org_admin()    to authenticated;
grant execute on function public.org_email_allowed() to authenticated;

-- The admin list itself is never exposed over the API. The UI asks
-- is_org_admin() instead, which answers only about the caller.
alter table public.org_admins enable row level security;
revoke all on public.org_admins from anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. The chart
-- ---------------------------------------------------------------------
-- One row = one seat (box) on the chart.
--
-- employee_key is nullable and NOT unique, on purpose:
--   * null  -> a vacant seat / placeholder ("Open Req - Project Engineer")
--   * dupes -> one person holding several seats (Logan Smith holds five)

create table if not exists public.org_positions (
  id             uuid primary key default gen_random_uuid(),
  parent_id      uuid references public.org_positions(id) on delete restrict,
  employee_key   text,
  name_override  text,
  title_override text,
  show_title     boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text
);

comment on column public.org_positions.parent_id is
  'Who this seat reports to. null = top of the chart. ON DELETE RESTRICT is '
  'deliberate: the app must re-parent children explicitly before deleting a '
  'manager, so a mis-click can never wipe out a whole branch.';
comment on column public.org_positions.employee_key is
  'mart.employees.ajera_employee_key, as text. Null for vacant seats.';
comment on column public.org_positions.name_override is
  'Display name. Falls back to the Ajera legal name when null — set this to '
  'show "Sam Murphy" where Ajera says "Samuel Murphy".';

create index if not exists org_positions_parent_idx   on public.org_positions (parent_id);
create index if not exists org_positions_employee_idx on public.org_positions (employee_key);

-- Keep updated_at / updated_by honest without trusting the client.
create or replace function public.org_positions_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', 'system');
  return new;
end;
$$;

drop trigger if exists org_positions_touch_trg on public.org_positions;
create trigger org_positions_touch_trg
  before insert or update on public.org_positions
  for each row execute function public.org_positions_touch();

-- A seat cannot report to itself, directly or through any chain.
-- Without this, one bad drag makes an orphaned ring that vanishes from the
-- chart entirely and is a nuisance to find again.
create or replace function public.org_positions_no_cycles()
returns trigger
language plpgsql
as $$
declare
  walker uuid := new.parent_id;
  hops   int  := 0;
begin
  while walker is not null loop
    if walker = new.id then
      raise exception 'That move would make % report to itself (through a loop).', new.id;
    end if;
    hops := hops + 1;
    if hops > 100 then
      raise exception 'Reporting chain is unreasonably deep; aborting.';
    end if;
    select parent_id into walker from public.org_positions where id = walker;
  end loop;
  return new;
end;
$$;

drop trigger if exists org_positions_no_cycles_trg on public.org_positions;
create trigger org_positions_no_cycles_trg
  before insert or update of parent_id on public.org_positions
  for each row execute function public.org_positions_no_cycles();


-- ---------------------------------------------------------------------
-- 3. Row Level Security — the actual read-only / editable split
-- ---------------------------------------------------------------------
-- This is enforced by Postgres, not by the app. Hiding the edit buttons in
-- the UI is cosmetic; THIS is what stops a non-admin from writing.

alter table public.org_positions enable row level security;

drop policy if exists org_positions_read  on public.org_positions;
drop policy if exists org_positions_write on public.org_positions;

-- Anyone with a company email who is logged in can read the whole chart.
create policy org_positions_read
  on public.org_positions
  for select
  to authenticated
  using (public.org_email_allowed());

-- Only admins can insert / update / delete.
create policy org_positions_write
  on public.org_positions
  for all
  to authenticated
  using      (public.is_org_admin())
  with check (public.is_org_admin());

grant select, insert, update, delete on public.org_positions to authenticated;
revoke all on public.org_positions from anon;


-- ---------------------------------------------------------------------
-- 4. Rows in mart.employees that aren't people
-- ---------------------------------------------------------------------
-- Ajera's employee table carries records that exist for accounting reasons.
-- Left alone they appear as boxes on the chart, usually floating at the top
-- because nothing supervises them.
--
-- Numeric-name junk (ajera_employee_key 23 is called "8493") is filtered by
-- pattern below. Anything with a plausible human-looking name has to be
-- named here — there's no rule that separates "Stambaugh Ness" the
-- consulting firm from a real person.

create table if not exists public.org_excluded_employees (
  employee_key text primary key,
  reason       text,
  created_at   timestamptz not null default now()
);

insert into public.org_excluded_employees (employee_key, reason) values
  ('206', 'Stambaugh Ness — outside consulting firm, not an employee')
on conflict (employee_key) do nothing;

alter table public.org_excluded_employees enable row level security;
revoke all on public.org_excluded_employees from anon, authenticated;

-- To exclude someone later:
--   insert into public.org_excluded_employees (employee_key, reason)
--   values ('123', 'why');
-- They vanish from the app's roster on the next page load. Delete the row to
-- bring them back.


-- ---------------------------------------------------------------------
-- 5. Read-only window onto the Ajera roster
-- ---------------------------------------------------------------------
-- Two views, deliberately.
--
-- app.employee_roster is the definition of "who counts as a person". It has
-- no auth gate, and it lives in a schema PostgREST doesn't expose, so it is
-- unreachable over the API but usable from the SQL Editor. The seed script
-- reads this one.
--
-- public.employee_directory is the same thing plus the login gate, and it is
-- what the app reads. Splitting them matters: the gate calls auth.jwt(),
-- which is null in the SQL Editor, so a seed script reading the gated view
-- would quietly insert nothing at all.

create schema if not exists app;
revoke all on schema app from anon, authenticated;

drop view if exists public.employee_directory;
drop view if exists app.employee_roster;

create view app.employee_roster as
select
  e.ajera_employee_key::text     as employee_key,
  e.full_name,
  e.employee_title,
  e.employment_status,
  e.employee_email,
  e.employee_type_description,
  e.is_supervisor,
  -- Nullable in Ajera and, in a well-formed roster, null for exactly one
  -- person: whoever sits at the top.
  e.supervisor_employee_key::text as supervisor_key
from mart.employees e
where
  -- Ajera has junk rows whose "name" is just a number.
  trim(coalesce(e.full_name, '')) !~ '^[0-9]+$'
  and trim(coalesce(e.full_name, '')) <> ''
  and not exists (
    select 1
      from public.org_excluded_employees x
     where x.employee_key = e.ajera_employee_key::text
  );

comment on view app.employee_roster is
  'Who counts as a person for the org chart. No auth gate — not reachable '
  'over the API, and safe to read from the SQL Editor. Add roster-wide '
  'filters here so the app and the seed scripts can never disagree.';

create view public.employee_directory as
select * from app.employee_roster
 where public.org_email_allowed();

comment on view public.employee_directory is
  'What the app reads: app.employee_roster plus the company-email gate. Add '
  'columns (department, photo_url) to app.employee_roster as they land in the '
  'mart. employee_email is what lets the app highlight the viewer''s own box.';

grant select on public.employee_directory to authenticated;
revoke all  on public.employee_directory from anon;


-- ---------------------------------------------------------------------
-- 6. Live updates (optional but nice)
-- ---------------------------------------------------------------------
-- With this on, an admin's edit appears on everyone else's screen without
-- them refreshing. If you skip it the app still works exactly the same; it
-- just needs a page refresh to see changes.

do $$
begin
  alter publication supabase_realtime add table public.org_positions;
exception
  when duplicate_object then null;  -- already added, fine
  when undefined_object then
    raise notice 'Realtime publication not found; skipping live updates.';
end;
$$;


-- ---------------------------------------------------------------------
-- 7. Confirm it worked
-- ---------------------------------------------------------------------
-- Read app.employee_roster, not public.employee_directory. The SQL Editor has
-- no logged-in user, so the gated view correctly returns nothing here — which
-- is itself the proof that the gate works.

select 'people on the roster'      as check, count(*)::text            as result from app.employee_roster
union all
select 'of those, Active',          count(*) filter (where employment_status = 'Active')::text from app.employee_roster
union all
select 'excluded as not-a-person',  count(*)::text from public.org_excluded_employees
union all
select 'seats on the chart',        count(*)::text from public.org_positions
union all
select 'admins configured',         string_agg(email, ', ') from public.org_admins
union all
select 'gated view, no login (want 0)', count(*)::text from public.employee_directory;
