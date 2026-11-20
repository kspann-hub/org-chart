-- =====================================================================
-- 09 — What the CriticalArc map could be built from (read-only)
-- =====================================================================
-- The map in the Claude Design canvas needs four things the app doesn't
-- read yet: each person's home base, projects with a location and a status,
-- who has charged time to which project lately, and potential projects.
--
-- This changes nothing. It lists every table and view in the `mart` schema,
-- and every column whose name suggests it holds one of those. Run it in the
-- SQL Editor and send back the results (both grids).
-- =====================================================================

-- 1. Every table/view in mart, with its row count estimate.
select c.relname                                   as table_name,
       case c.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end as kind,
       c.reltuples::bigint                         as approx_rows
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'mart'
   and c.relkind in ('r', 'v', 'm', 'p')
 order by c.relname;

-- 2. Columns that look like locations, projects, time, or pipeline.
select table_name,
       column_name,
       data_type
  from information_schema.columns
 where table_schema = 'mart'
   and (
         column_name ~* '(city|state|zip|postal|address|location|office|lat|lon|lng|region|country)'
      or column_name ~* '(project|job|phase|client|status|stage|opportunit|proposal|pipeline|prospect)'
      or column_name ~* '(timesheet|hours|hrs|time_entry|work_date|entry_date|period)'
       )
 order by table_name, ordinal_position;

-- 3. Follow-up, once 1 and 2 have been read. One cell of JSON, so the SQL
--    Editor shows all of it at once: every column of the employee and
--    timesheet tables, the project statuses in use, and what project
--    locations actually look like (no people in this part — places only).
select json_build_object(
  'employee_columns', (
    select json_agg(column_name order by ordinal_position)
      from information_schema.columns
     where table_schema = 'mart' and table_name = 'employees'),
  'timesheet_columns', (
    select json_agg(column_name order by ordinal_position)
      from information_schema.columns
     where table_schema = 'mart' and table_name = 'timesheet_project_daily'),
  'project_statuses', (
    select json_agg(s) from (
      select project_status, count(*) as projects
        from mart.projects group by 1 order by 2 desc) s),
  'location_samples', (
    select json_agg(s) from (
      select project_location, project_status, count(*) as projects
        from mart.projects
       where coalesce(trim(project_location), '') <> ''
       group by 1, 2 order by 3 desc limit 40) s),
  'projects_without_location', (
    select count(*) from mart.projects where coalesce(trim(project_location), '') = ''),
  'projects_with_time_last_14_days', (
    select count(distinct project_key)
      from mart.timesheet_project_daily
     where work_date >= current_date - 14)
) as answers;
