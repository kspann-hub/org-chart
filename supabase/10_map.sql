-- =====================================================================
-- 10 — The CriticalArc map
-- Run this AFTER 01–08. Safe to re-run.
--
-- Three things for the "CriticalArc map" tab on the Full org chart page:
--
--   1. org_positions.home_base — "City, ST", typed in by an admin. Ajera has
--      no home location for anyone, so this is the only real source. Until
--      it's filled in, the map places a person at the project location they
--      charged the most time to recently, and says so.
--   2. public.org_map_projects — every Ajera project with its status,
--      location, client and project manager. The app sorts the statuses into
--      pins: Active / WorkHold / Hold = active, Preliminary / Marketing =
--      potential, Closed (anything else) = past.
--   3. public.org_map_hours — hours each person charged to each project over
--      the last 14 and the last 90 days, from timesheet_project_daily.
--
-- Both views follow the employee_directory pattern: they read mart tables the
-- API can't see, and return rows only to a signed-in company address. Every
-- signed-in employee can therefore see who charged how many hours to which
-- project — the map shows it on each person's card. If that should be
-- admins only, change `public.org_email_allowed()` in org_map_hours to
-- `public.is_org_admin()`; the map then shows hours to admins alone.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Home base, on the seat (like photo_path and linkedin_url)
-- ---------------------------------------------------------------------

alter table public.org_positions
  add column if not exists home_base text;

comment on column public.org_positions.home_base is
  'Where this person is based, as "City, ST" (e.g. "Sacramento, CA"). '
  'Typed in by an admin; null means the map falls back to timesheets.';

do $$
begin
  alter table public.org_positions
    add constraint org_positions_home_base_check
    check (home_base is null or char_length(home_base) between 2 and 80);
exception
  when duplicate_object then null;  -- already there, fine
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Teach undo about home_base
-- ---------------------------------------------------------------------
-- Same function as in 06_manual_seats.sql with home_base added in three
-- places. org_undo_change() restores columns it names one by one, so a column
-- it doesn't name would silently stay as it was.

create or replace function public.org_undo_change(p_history_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  h public.org_position_history%rowtype;
  v_actor text := coalesce(auth.jwt() ->> 'email', 'system');
begin
  if not public.is_org_admin() then
    raise exception 'Only org chart admins can undo a change.'
      using errcode = '42501';
  end if;

  select * into h from public.org_position_history where id = p_history_id;
  if not found then
    raise exception 'That change is no longer in the log.';
  end if;

  if h.undone_at is not null then
    raise exception 'That change has already been undone.';
  end if;

  if h.action = 'update' then
    update public.org_positions
       set parent_id      = (h.before_row ->> 'parent_id')::uuid,
           employee_key   =  h.before_row ->> 'employee_key',
           name_override  =  h.before_row ->> 'name_override',
           title_override =  h.before_row ->> 'title_override',
           show_title     = (h.before_row ->> 'show_title')::boolean,
           sort_order     = (h.before_row ->> 'sort_order')::integer,
           photo_path     =  h.before_row ->> 'photo_path',
           linkedin_url   =  h.before_row ->> 'linkedin_url',
           home_base      =  h.before_row ->> 'home_base',
           -- coalesce covers log rows written before this column existed.
           source         =  coalesce(h.before_row ->> 'source', 'ajera')
     where id = h.position_id;

    if not found then
      raise exception 'That seat no longer exists, so this change cannot be undone.';
    end if;

  elsif h.action = 'insert' then
    -- ON DELETE RESTRICT means this refuses rather than taking a branch with
    -- it, which is the behaviour we want: move the reports out first.
    begin
      delete from public.org_positions where id = h.position_id;
    exception
      when foreign_key_violation then
        raise exception 'That seat now has people reporting to it. Move them first, then undo.';
    end;

  else  -- delete
    insert into public.org_positions
      (id, parent_id, employee_key, name_override, title_override,
       show_title, sort_order, photo_path, linkedin_url, home_base, source)
    values (
      h.position_id,
      (h.before_row ->> 'parent_id')::uuid,
       h.before_row ->> 'employee_key',
       h.before_row ->> 'name_override',
       h.before_row ->> 'title_override',
      (h.before_row ->> 'show_title')::boolean,
      (h.before_row ->> 'sort_order')::integer,
       h.before_row ->> 'photo_path',
       h.before_row ->> 'linkedin_url',
       h.before_row ->> 'home_base',
       coalesce(h.before_row ->> 'source', 'ajera')
    );
  end if;

  update public.org_position_history
     set undone_at = now(), undone_by = v_actor
   where id = p_history_id;

  return jsonb_build_object('ok', true, 'action', h.action, 'label', h.label);
exception
  when foreign_key_violation then
    -- Recreating a seat whose old manager has since been deleted.
    raise exception 'The manager this seat reported to no longer exists. '
                    'Undo that deletion first.';
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Projects
-- ---------------------------------------------------------------------

drop view if exists public.org_map_projects;

create view public.org_map_projects as
select
  p.project_key::text                              as project_key,
  p.project_description                            as name,
  p.project_status                                 as status,
  nullif(trim(p.project_location), '')             as location,
  p.client_description                             as client,
  p.project_manager_employee_key::text             as manager_key,
  t.last_work_date
from mart.projects p
left join (
  select project_key, max(work_date) as last_work_date
    from mart.timesheet_project_daily
   group by project_key
) t on t.project_key = p.project_key
where coalesce(p.has_valid_project_key, true)
  and public.org_email_allowed();

comment on view public.org_map_projects is
  'Ajera projects for the CriticalArc map, with the last day anyone charged '
  'time to each. Company-email gated, like employee_directory.';

grant select on public.org_map_projects to authenticated;
revoke all  on public.org_map_projects from anon;


-- ---------------------------------------------------------------------
-- 4. Who has been charging time where
-- ---------------------------------------------------------------------

drop view if exists public.org_map_hours;

create view public.org_map_hours as
select
  t.ajera_employee_key::text                                            as employee_key,
  t.project_key::text                                                   as project_key,
  round(sum(t.hours_total_worked) filter (
    where t.work_date >= current_date - 14)::numeric, 1)::float8        as hours_14d,
  round(sum(t.hours_total_worked)::numeric, 1)::float8                  as hours_90d
from mart.timesheet_project_daily t
where t.work_date >= current_date - 90
  and t.ajera_employee_key is not null
  and t.project_key is not null
  and public.org_email_allowed()
group by 1, 2
having sum(t.hours_total_worked) > 0;

comment on view public.org_map_hours is
  'Hours per person per project, last 14 and 90 days, for the CriticalArc '
  'map. Company-email gated; see the note at the top of 10_map.sql.';

grant select on public.org_map_hours to authenticated;
revoke all  on public.org_map_hours from anon;


-- ---------------------------------------------------------------------
-- 5. Check
-- ---------------------------------------------------------------------
-- Run as yourself in the SQL Editor these views return nothing (no login, so
-- the email gate says no) — that's the gate working. These read the mart
-- directly instead, to show what the map will have to work with.

select
  (select count(*) from mart.projects)                                       as projects,
  (select count(*) from mart.projects
    where coalesce(trim(project_location), '') <> '')                        as with_location,
  (select count(distinct ajera_employee_key) from mart.timesheet_project_daily
    where work_date >= current_date - 90)                                    as people_with_time_90d,
  (select count(*) from public.org_positions where home_base is not null)    as seats_with_home_base;
