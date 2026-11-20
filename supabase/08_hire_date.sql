-- =====================================================================
-- 08 — Hire date on the employee card
-- =====================================================================
-- Adds `hire_date` to app.employee_roster (and so to
-- public.employee_directory, which the app reads). The Overview's employee
-- card shows it as "March 2021"; until this has run, the card shows a dash.
--
-- The column name in mart.employees isn't fixed in this repo, so this looks
-- for the usual names and uses the first one it finds. If none match it stops
-- with an error that lists every date-like column the mart does have — put the
-- right one at the front of `candidates` below and run it again.
--
-- Safe to re-run. It only appends a column to the two views: nothing that
-- already reads them changes, and their grants are kept.
-- =====================================================================

do $$
declare
  candidates text[] := array[
    'hire_date', 'date_hired', 'original_hire_date', 'employee_hire_date',
    'hired_date', 'hire_dt', 'start_date', 'employment_start_date'
  ];
  col text;
begin
  select c.column_name
    into col
    from information_schema.columns c
   where c.table_schema = 'mart'
     and c.table_name = 'employees'
     and c.column_name = any (candidates)
   order by array_position(candidates, c.column_name::text)
   limit 1;

  if col is null then
    raise exception
      'No hire date column found in mart.employees. Date-like columns it does have: %',
      coalesce((
        select string_agg(c.column_name, ', ' order by c.ordinal_position)
          from information_schema.columns c
         where c.table_schema = 'mart'
           and c.table_name = 'employees'
           and (c.column_name ilike '%hire%' or c.column_name ilike '%date%'
                or c.column_name ilike '%start%' or c.data_type like '%date%'
                or c.data_type like 'timestamp%')
      ), '(none)');
  end if;

  raise notice 'Using mart.employees.% as the hire date.', col;

  -- Same definition as 01_schema.sql, with hire_date appended. `create or
  -- replace` can only add columns at the end, which is exactly what this does.
  execute format($view$
    create or replace view app.employee_roster as
    select
      e.ajera_employee_key::text     as employee_key,
      e.full_name,
      e.employee_title,
      e.employment_status,
      e.employee_email,
      e.employee_type_description,
      e.is_supervisor,
      e.supervisor_employee_key::text as supervisor_key,
      e.%I::date                     as hire_date
    from mart.employees e
    where
      trim(coalesce(e.full_name, '')) !~ '^[0-9]+$'
      and trim(coalesce(e.full_name, '')) <> ''
      and not exists (
        select 1
          from public.org_excluded_employees x
         where x.employee_key = e.ajera_employee_key::text
      )
  $view$, col);

  -- `select *` was expanded when this view was first created, so it has to be
  -- restated to pick up the new column.
  create or replace view public.employee_directory as
  select * from app.employee_roster
   where public.org_email_allowed();
end;
$$;

-- Check: how many people now have a hire date. Expect most of the roster.
select count(*)          as people,
       count(hire_date)  as with_hire_date,
       min(hire_date)    as earliest,
       max(hire_date)    as latest
  from app.employee_roster;
