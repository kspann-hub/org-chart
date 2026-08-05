-- =====================================================================
-- Org chart — seed the seats and build the reporting tree
-- Run this AFTER 01_schema.sql, in the Supabase SQL Editor.
--
-- mart.employees has supervisor_employee_key, so the whole tree builds
-- itself. Run STEP 1 and READ THE OUTPUT before running anything else —
-- five cheap health checks on the Ajera data, each catching a problem that
-- is much more annoying to unpick after the tree exists.
--
-- Everything here reads app.employee_roster, never public.employee_directory.
-- The directory view is gated on the logged-in user's email, and the SQL
-- Editor has no logged-in user — so reading it here would return zero rows
-- and every statement below would silently do nothing.
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 1 — check the Ajera data before trusting it
-- ---------------------------------------------------------------------

-- 1a. Who ends up at the top? You want exactly ONE row.
--     Several means several disconnected trees.
--     ZERO means every chain loops back on itself — go straight to 1b.
select employee_key, full_name, employee_title
  from app.employee_roster
 where employment_status = 'Active'
   and supervisor_key is null
 order by full_name;

-- 1b. People who are their own supervisor. This is the usual way a roster
--     ends up with no root: whoever runs the company has to have SOMETHING
--     in the supervisor field, so they get pointed at themselves.
--
--     The chart handles this fine — the seed skips the self-reference and
--     leaves them unparented, which puts them at the top, which is right.
--     You just want to know it's them and not an accident.
select employee_key, full_name, employee_title
  from app.employee_roster
 where employment_status = 'Active'
   and supervisor_key = employee_key
 order by full_name;

-- 1c. Longer loops — A reports to B reports to A. Unlike 1b these are real
--     data errors, and the database REFUSES to build a tree containing one.
--     Fix in Ajera, or hand-parent those people in the app afterwards.
with recursive walk as (
  select employee_key as root, supervisor_key as next_key, 0 as depth
    from app.employee_roster
   where employment_status = 'Active'
  union all
  select w.root, e.supervisor_key, w.depth + 1
    from walk w
    join app.employee_roster e on e.employee_key = w.next_key
   where w.depth < 50
)
select distinct e.employee_key, e.full_name, e.employee_title
  from walk w
  join app.employee_roster e on e.employee_key = w.root
 where w.next_key = w.root
   and w.depth > 0          -- depth 0 is the self-reference case, see 1b
 order by e.full_name;

-- 1d. Supervisors who aren't Active, or aren't on the roster at all
--     (terminated, or excluded by org_excluded_employees). Their reports
--     land at the top of the chart instead of underneath them.
select e.full_name                                     as person,
       e.supervisor_key,
       coalesce(s.full_name, '(not on the roster)')    as supervisor,
       coalesce(s.employment_status, '—')              as supervisor_status
  from app.employee_roster e
  left join app.employee_roster s on s.employee_key = e.supervisor_key
 where e.employment_status = 'Active'
   and e.supervisor_key is not null
   and e.supervisor_key <> e.employee_key
   and (s.employee_key is null or s.employment_status <> 'Active')
 order by 1;

-- 1e. The tree as Ajera sees it, indented. Eyeball this — it is the chart
--     you are about to get. Roots are anyone with no supervisor OR who
--     supervises themselves.
with recursive tree as (
  select employee_key, full_name, employee_title, 0 as depth,
         array[lower(full_name)] as sort_path
    from app.employee_roster
   where employment_status = 'Active'
     and (supervisor_key is null or supervisor_key = employee_key)
  union all
  select e.employee_key, e.full_name, e.employee_title, t.depth + 1,
         t.sort_path || lower(e.full_name)
    from app.employee_roster e
    join tree t on e.supervisor_key = t.employee_key
   where e.employment_status = 'Active'
     and e.employee_key <> t.employee_key
     and t.depth < 20
)
select repeat('    ', depth) || full_name as org, employee_title, depth
  from tree
 order by sort_path;

-- 1f. Anyone 1e missed. If this returns rows, those people are in a loop
--     (see 1c) or hang off an inactive supervisor (see 1d) — they'll end up
--     as extra boxes at the top of the chart rather than disappearing.
with recursive tree as (
  select employee_key
    from app.employee_roster
   where employment_status = 'Active'
     and (supervisor_key is null or supervisor_key = employee_key)
  union all
  select e.employee_key
    from app.employee_roster e
    join tree t on e.supervisor_key = t.employee_key
   where e.employment_status = 'Active'
     and e.employee_key <> t.employee_key
)
select r.employee_key, r.full_name, r.employee_title, r.supervisor_key
  from app.employee_roster r
 where r.employment_status = 'Active'
   and r.employee_key not in (select employee_key from tree)
 order by r.full_name;


-- ---------------------------------------------------------------------
-- STEP 2 — create one seat per active employee
-- ---------------------------------------------------------------------
-- Idempotent. Re-run any time to pick up new hires in bulk; it only adds
-- seats for people who don't already have one.

insert into public.org_positions (employee_key, sort_order)
select e.employee_key,
       row_number() over (order by e.full_name)
  from app.employee_roster e
 where e.employment_status = 'Active'
   and not exists (
     select 1 from public.org_positions p where p.employee_key = e.employee_key
   );

-- Note there is deliberately no title_override set above. Leaving it null
-- means each box shows the live Ajera title, so a promotion in Ajera reaches
-- the chart by itself. Override a title only where the chart needs to
-- disagree with Ajera — see STEP 5.


-- ---------------------------------------------------------------------
-- STEP 3 — build the reporting tree
-- ---------------------------------------------------------------------
-- Only touches seats that don't already have a parent, so re-running this
-- after adding new hires slots them in without disturbing any hand-arranging
-- done in the app.
--
-- The self-reference guard is what keeps whoever runs the company at the top
-- instead of aborting the statement on the cycle trigger.

update public.org_positions child
   set parent_id = parent.id
  from app.employee_roster e
  join public.org_positions parent on parent.employee_key = e.supervisor_key
 where child.employee_key = e.employee_key
   and child.parent_id is null
   and e.supervisor_key is not null
   and e.supervisor_key <> e.employee_key
   and parent.id <> child.id;


-- ---------------------------------------------------------------------
-- STEP 4 — confirm the shape
-- ---------------------------------------------------------------------

-- Expect: total_seats = your active headcount, top_level_seats small.
-- Ideally 1. Anything above that is explained by STEP 1a / 1b / 1d.
select count(*) filter (where parent_id is null) as top_level_seats,
       count(*)                                  as total_seats
  from public.org_positions;

-- The chart as it now stands, indented. Compare with 1e.
with recursive tree as (
  select p.id, 0 as depth,
         array[lower(coalesce(p.name_override, e.full_name, 'zz'))] as sort_path
    from public.org_positions p
    left join app.employee_roster e on e.employee_key = p.employee_key
   where p.parent_id is null
  union all
  select p.id, t.depth + 1,
         t.sort_path || lower(coalesce(p.name_override, e.full_name, 'zz'))
    from public.org_positions p
    left join app.employee_roster e on e.employee_key = p.employee_key
    join tree t on p.parent_id = t.id
   where t.depth < 20
)
select repeat('    ', t.depth) || coalesce(p.name_override, e.full_name, '(vacant)') as org,
       coalesce(p.title_override, e.employee_title) as title
  from tree t
  join public.org_positions p on p.id = t.id
  left join app.employee_roster e on e.employee_key = p.employee_key
 order by t.sort_path;


-- ---------------------------------------------------------------------
-- STEP 5 — one person, several seats
-- ---------------------------------------------------------------------
-- Ajera stores ONE title per person, but people hold several roles. Logan
-- Smith is one Ajera record and five boxes on the chart. Ajera can't express
-- that, so the extra seats are created here.
--
-- Easiest way: do it in the app. Select the manager, hit "Add a report", pick
-- the person from the dropdown, type the title. No ids to copy around.
--
-- Or in SQL, reporting to a named manager:
--
--   insert into public.org_positions (employee_key, parent_id, title_override)
--   select person.employee_key, seat.id, 'Operations Manager - Aviation'
--     from app.employee_roster person
--     join public.org_positions seat
--       on seat.employee_key = (select employee_key from app.employee_roster
--                                where full_name = 'Justin Harder')
--    where person.full_name = 'Logan Smith';
--
-- Where the chart's wording should differ from Ajera's — Ajera says
-- "Director of Project Delivery", the chart says "VP - Project Delivery" —
-- set title_override on that seat. Everywhere you leave it null, the chart
-- tracks Ajera automatically.


-- ---------------------------------------------------------------------
-- STEP 6 — worth re-running when something looks off
-- ---------------------------------------------------------------------

-- Active people with no seat. Usually new hires; the app's "Not on the
-- chart" tray shows the same list. Re-run STEP 2 + STEP 3 to add them.
select e.full_name, e.employee_title
  from app.employee_roster e
  left join public.org_positions p on p.employee_key = e.employee_key
 where e.employment_status = 'Active'
   and p.id is null
 order by 1;

-- Seats whose person has left. The app flags these amber rather than
-- removing them — a termination shouldn't silently delete a manager out from
-- under their reports.
select coalesce(p.name_override, e.full_name) as person,
       e.employment_status,
       (select count(*) from public.org_positions c where c.parent_id = p.id) as direct_reports
  from public.org_positions p
  join app.employee_roster e on e.employee_key = p.employee_key
 where e.employment_status <> 'Active'
 order by 3 desc;

-- Seats pointing at an employee_key that is no longer on the roster at all —
-- newly excluded, or dropped out of the mart. These show as "Vacant".
select p.id, p.employee_key, p.name_override, p.title_override
  from public.org_positions p
 where p.employee_key is not null
   and not exists (
     select 1 from app.employee_roster e where e.employee_key = p.employee_key
   );

-- Where the chart deliberately disagrees with Ajera about a title. Every row
-- is intentional — but check it's still intentional after someone changes role.
select coalesce(p.name_override, e.full_name) as person,
       p.title_override as on_the_chart,
       e.employee_title as in_ajera
  from public.org_positions p
  join app.employee_roster e on e.employee_key = p.employee_key
 where p.title_override is not null
   and p.title_override is distinct from e.employee_title
 order by 1;

-- Duplicate names on the roster. Two real people called J. Smith are a
-- support ticket waiting to happen; know about them in advance.
select full_name, count(*), array_agg(employee_key)
  from app.employee_roster
 where employment_status = 'Active'
 group by 1 having count(*) > 1;

-- New non-people to exclude. Records with no title and no supervisor are the
-- usual shape of a vendor/placeholder record like Stambaugh Ness.
select employee_key, full_name, employee_type_description
  from app.employee_roster
 where employment_status = 'Active'
   and employee_title is null
   and supervisor_key is null
 order by full_name;
