-- =====================================================================
-- 07 — Where the chart and Ajera disagree
--
-- READ-ONLY. Changes nothing. Safe to run any time, as often as you like.
--
-- Supabase SQL Editor → New query → paste this whole file → Run.
--
-- It is one query on purpose: the SQL Editor only shows the result of the
-- last statement, so a file of separate checks would hide all but one.
-- Every row is one thing worth a look, grouped by the "issue" column.
-- An empty result means the chart and Ajera agree on everything checked.
--
-- Not every row is a mistake. A title or name override, or someone placed
-- under a different manager than Ajera says, may be deliberate. The point
-- is to see them all in one place and confirm each is still intended.
--
-- Reads app.employee_roster, not public.employee_directory — the directory
-- is gated on a logged-in user and returns nothing in the SQL Editor.
-- =====================================================================

with
roster as (
  select * from app.employee_roster
),
-- Each seat with the person in it and the person in the seat above it.
seat as (
  select p.id,
         p.employee_key,
         p.parent_id,
         p.name_override,
         p.title_override,
         par.employee_key                                  as parent_key,
         coalesce(par.name_override, pe.full_name,
                  case when p.parent_id is null then '(top of chart)'
                       else '(vacant seat)' end)           as parent_name
    from public.org_positions p
    left join public.org_positions par on par.id = p.parent_id
    left join roster pe on pe.employee_key = par.employee_key
)

select issue, person, on_the_chart, in_ajera
from (

  -- 1. Every status value Ajera uses. Only exactly 'Active' counts as
  --    active anywhere in this app, so 'active', 'Active ' or 'A' would
  --    quietly drop real people. Expect to see only Active / Terminated-style
  --    values here.
  select 1 as n, 'Status values in Ajera' as issue,
         coalesce('"' || employment_status || '"', '(blank)') as person,
         count(*)::text || ' people' as on_the_chart,
         case when employment_status = 'Active' then 'counted as active'
              else 'NOT counted as active' end as in_ajera
    from roster
   group by employment_status

  union all

  -- 2. Active in Ajera but no box on the chart. "Sync with Ajera" adds these.
  select 2, 'Active in Ajera, missing from the chart',
         r.full_name, null, r.employee_title
    from roster r
   where r.employment_status = 'Active'
     and not exists (select 1 from public.org_positions p where p.employee_key = r.employee_key)

  union all

  -- 3. A box for someone Ajera no longer lists as Active. Shown amber in the
  --    app; an admin removes them by hand (the sync never deletes).
  select 3, 'On the chart, no longer Active in Ajera',
         coalesce(s.name_override, r.full_name),
         (select count(*) from public.org_positions c where c.parent_id = s.id)::text
           || ' direct reports',
         coalesce(r.employment_status, '(blank status)')
    from seat s
    join roster r on r.employee_key = s.employee_key
   where r.employment_status is distinct from 'Active'

  union all

  -- 4. A box pointing at someone who isn't on the roster at all: excluded,
  --    a junk record, or removed from the mart. The app shows these as Vacant.
  select 4, 'On the chart, not on the Ajera roster at all',
         coalesce(s.name_override, '(Ajera key ' || s.employee_key || ')'),
         s.title_override,
         'key ' || s.employee_key || ' not found (excluded or removed)'
    from seat s
   where s.employee_key is not null
     and not exists (select 1 from roster r where r.employee_key = s.employee_key)

  union all

  -- 5. Reporting lines. For each Active person, does ANY of their boxes sit
  --    directly under a box held by their Ajera supervisor? If none does, the
  --    chart and Ajera disagree about who they report to. The sync only places
  --    people who have no manager yet, so a supervisor change in Ajera never
  --    reaches the chart by itself — this is where that drift shows up.
  select 5, 'Reports to someone different than in Ajera',
         r.full_name,
         'under ' || string_agg(distinct s.parent_name, ', '),
         'reports to ' || coalesce(sup.full_name,
                                   '(key ' || r.supervisor_key || ', not on roster)')
    from roster r
    join seat s on s.employee_key = r.employee_key
    left join roster sup on sup.employee_key = r.supervisor_key
   where r.employment_status = 'Active'
     and r.supervisor_key is not null
     and r.supervisor_key <> r.employee_key
   group by r.employee_key, r.full_name, r.supervisor_key, sup.full_name
  having not bool_or(coalesce(s.parent_key = r.supervisor_key, false))

  union all

  -- 6. Broken chains in Ajera itself: an Active person whose supervisor is
  --    not Active, or isn't on the roster. Fix these in Ajera.
  select 6, 'Ajera supervisor is not an Active person',
         r.full_name, null,
         'supervisor ' || coalesce(sup.full_name || ' is ' || coalesce(sup.employment_status, 'blank'),
                                   'key ' || r.supervisor_key || ' is not on the roster')
    from roster r
    left join roster sup on sup.employee_key = r.supervisor_key
   where r.employment_status = 'Active'
     and r.supervisor_key is not null
     and r.supervisor_key <> r.employee_key
     and sup.employment_status is distinct from 'Active'

  union all

  -- 7. Who Ajera puts at the very top: no supervisor, or their own
  --    supervisor. Expect exactly one person — whoever runs the company.
  select 7, 'Top of the tree in Ajera (expect one)',
         r.full_name, null,
         case when r.supervisor_key is null then 'no supervisor'
              else 'is their own supervisor' end
    from roster r
   where r.employment_status = 'Active'
     and (r.supervisor_key is null or r.supervisor_key = r.employee_key)

  union all

  -- 8. Titles where the chart deliberately says something different.
  select 8, 'Title differs (override on the chart)',
         coalesce(s.name_override, r.full_name), s.title_override, r.employee_title
    from seat s
    join roster r on r.employee_key = s.employee_key
   where s.title_override is not null
     and s.title_override is distinct from r.employee_title

  union all

  -- 9. Names where the chart deliberately says something different.
  select 9, 'Name differs (override on the chart)',
         r.full_name, s.name_override, r.full_name
    from seat s
    join roster r on r.employee_key = s.employee_key
   where s.name_override is not null
     and s.name_override is distinct from r.full_name

  union all

  -- 10. Same name, two Active records. Picking the wrong one in the app is
  --     easy and silent.
  select 10, 'Duplicate name in Ajera',
         full_name, count(*)::text || ' records',
         'keys ' || string_agg(employee_key, ', ')
    from roster
   where employment_status = 'Active'
   group by full_name
  having count(*) > 1

  union all

  -- 11. Active records with no title and no supervisor — the usual shape of
  --     a vendor or placeholder rather than a person (like Stambaugh Ness).
  select 11, 'Possibly not a person (no title, no supervisor)',
         full_name, null, coalesce(employee_type_description, '(no type)')
    from roster
   where employment_status = 'Active'
     and employee_title is null
     and supervisor_key is null

  union all

  -- 12. Stray spaces in Ajera names and titles. Invisible on screen, but they
  --     break search, sorting and duplicate checks.
  select 12, 'Extra spaces in Ajera data',
         '"' || full_name || '"', null, '"' || coalesce(employee_title, '') || '"'
    from roster
   where employment_status = 'Active'
     and (full_name <> btrim(full_name) or full_name ~ '\s{2,}'
          or employee_title <> btrim(employee_title) or employee_title ~ '\s{2,}')

  union all

  -- 13. Active people with no company email. The chart uses it to highlight
  --     the viewer's own box when they sign in.
  select 13, 'Active, no company email in Ajera',
         full_name, null, coalesce(employee_email, '(blank)')
    from roster
   where employment_status = 'Active'
     and (employee_email is null or employee_email !~* '@criticalarccx\.com$')

) checks
order by n, person;
