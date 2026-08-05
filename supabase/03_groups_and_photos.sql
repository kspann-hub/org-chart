-- =====================================================================
-- Org chart — groups and photos
-- Run this AFTER 01_schema.sql and 02_seed_positions.sql.
--
-- Adds two things:
--   * groups  — the "verticals" on the landing page
--   * photos  — headshots stored in Supabase Storage
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Groups
-- ---------------------------------------------------------------------
-- A group is defined by ONE seat: its root. Membership is then "every seat
-- whose nearest group-root ancestor is this one".
--
-- That rule is what makes the numbers work. The President's subtree is the
-- whole company, so a group can't just be a subtree — but mark the President
-- AND the two VPs as group roots, and the President's group becomes only the
-- people who don't fall under a VP. Groups tile the org with no overlap and
-- no gaps, and adding a fourth is one row.

create table if not exists public.org_groups (
  id               uuid primary key default gen_random_uuid(),
  root_position_id uuid not null unique
                     references public.org_positions(id) on delete cascade,
  name             text not null,
  -- Drives the card border and heading on the landing page.
  accent           text not null default '#3b82f6',
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now()
);

comment on table public.org_groups is
  'Verticals on the landing page. One row per group root; membership is '
  'computed in the app as nearest-group-root-ancestor, so groups never '
  'overlap and every seat lands in exactly one.';
comment on column public.org_groups.root_position_id is
  'ON DELETE CASCADE removes the group marker if the seat goes, not the '
  'people — they simply fall into the enclosing group.';

alter table public.org_groups enable row level security;

drop policy if exists org_groups_read  on public.org_groups;
drop policy if exists org_groups_write on public.org_groups;

create policy org_groups_read
  on public.org_groups for select to authenticated
  using (public.org_email_allowed());

create policy org_groups_write
  on public.org_groups for all to authenticated
  using (public.is_org_admin()) with check (public.is_org_admin());

grant select, insert, update, delete on public.org_groups to authenticated;
revoke all on public.org_groups from anon;

-- Realtime, so a viewer sees an admin's changes without refreshing.
do $$
begin
  alter publication supabase_realtime add table public.org_groups;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Photos
-- ---------------------------------------------------------------------
-- Only the object path is stored. URLs are minted client-side as short-lived
-- signed links, so headshots are unreadable to anyone not signed in — the
-- bucket stays private.

alter table public.org_positions
  add column if not exists photo_path text;

comment on column public.org_positions.photo_path is
  'Path inside the private `headshots` storage bucket, e.g. '
  '"<position-id>.jpg". Null means fall back to initials.';


-- ---------------------------------------------------------------------
-- 3. Storage policies for the headshots bucket
-- ---------------------------------------------------------------------
-- CREATE THE BUCKET FIRST, in the dashboard:
--   Storage -> New bucket -> name `headshots` -> Public bucket OFF -> Create
--
-- Running this before the bucket exists is harmless; the policies just sit
-- there until it does.

drop policy if exists headshots_read   on storage.objects;
drop policy if exists headshots_insert on storage.objects;
drop policy if exists headshots_update on storage.objects;
drop policy if exists headshots_delete on storage.objects;

-- Anyone signed in with a company address can view headshots.
create policy headshots_read
  on storage.objects for select to authenticated
  using (bucket_id = 'headshots' and public.org_email_allowed());

-- Only admins can add, replace or remove them.
create policy headshots_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'headshots' and public.is_org_admin());

create policy headshots_update
  on storage.objects for update to authenticated
  using (bucket_id = 'headshots' and public.is_org_admin())
  with check (bucket_id = 'headshots' and public.is_org_admin());

create policy headshots_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'headshots' and public.is_org_admin());


-- ---------------------------------------------------------------------
-- 4. Seed the three verticals
-- ---------------------------------------------------------------------
-- Justin Harder, Logan Smith and Brian Agosta. Because groups resolve to the
-- NEAREST root above a seat, marking all three means Justin's card holds the
-- business-overhead people specifically — Logan's and Brian's branches get
-- pulled out of it rather than counted twice.
--
-- Matching by name needs care: Logan Smith holds five seats and Justin Harder
-- two. `distinct on (person) ... order by depth` picks each person's HIGHEST
-- seat, which is the VP/President one every time. Picking by name alone would
-- be a coin-flip between "VP - Operations" and "Operations Manager - Aviation".

-- 4a. PREVIEW FIRST. Check this picks the seats you expect before writing.
with recursive tree as (
  select id, parent_id, employee_key, name_override, title_override, 0 as depth
    from public.org_positions where parent_id is null
  union all
  select p.id, p.parent_id, p.employee_key, p.name_override, p.title_override, t.depth + 1
    from public.org_positions p join tree t on p.parent_id = t.id
   where t.depth < 20
),
resolved as (
  select t.id, t.depth,
         coalesce(t.name_override, e.full_name)      as person,
         coalesce(t.title_override, e.employee_title) as title,
         (select count(*) from public.org_positions c where c.parent_id = t.id) as reports
    from tree t
    left join app.employee_roster e on e.employee_key = t.employee_key
)
select distinct on (person) person, title, depth, reports, id as seat_id
  from resolved
 where person in ('Justin Harder', 'Logan Smith', 'Brian Agosta')
 order by person, depth, reports desc;

-- 4b. Write them. Re-runnable: an existing group for the same seat is left
--     alone rather than duplicated.
with recursive tree as (
  select id, parent_id, employee_key, name_override, 0 as depth
    from public.org_positions where parent_id is null
  union all
  select p.id, p.parent_id, p.employee_key, p.name_override, t.depth + 1
    from public.org_positions p join tree t on p.parent_id = t.id
   where t.depth < 20
),
resolved as (
  select t.id, t.depth,
         coalesce(t.name_override, e.full_name) as person,
         (select count(*) from public.org_positions c where c.parent_id = t.id) as reports
    from tree t
    left join app.employee_roster e on e.employee_key = t.employee_key
),
picked as (
  select distinct on (person) person, id
    from resolved
   where person in ('Justin Harder', 'Logan Smith', 'Brian Agosta')
   order by person, depth, reports desc
),
wanted (person, name, accent, sort_order) as (
  values ('Justin Harder', 'Business Operations', '#3b82f6', 1),
         ('Logan Smith',   'Project Operations',  '#38bdf8', 2),
         ('Brian Agosta',  'Project Delivery',    '#4ade80', 3)
)
insert into public.org_groups (root_position_id, name, accent, sort_order)
select p.id, w.name, w.accent, w.sort_order
  from picked p
  join wanted w on w.person = p.person
 where not exists (select 1 from public.org_groups g where g.root_position_id = p.id);

-- 4c. Did all three land? A NOT MATCHED row means the spelling in your data
--     differs from the spelling above — check 4a's output and adjust 4b.
select w.person,
       coalesce(found.name, '*** NOT MATCHED — check the spelling ***') as status
  from (values ('Justin Harder'), ('Logan Smith'), ('Brian Agosta')) as w(person)
  left join lateral (
    select g.name
      from public.org_groups g
      join public.org_positions p on p.id = g.root_position_id
      left join app.employee_roster e on e.employee_key = p.employee_key
     where coalesce(p.name_override, e.full_name) = w.person
     limit 1
  ) found on true
 order by 1;


-- ---------------------------------------------------------------------
-- 5. Adding or changing a vertical later
-- ---------------------------------------------------------------------
-- Do it in the app: open the full chart, click the seat that should lead the
-- group, tick "Start a group here", type a name, pick a colour, Save.
-- Unticking it removes the group and its people fold back into the enclosing
-- one. Nothing here needs re-running.


-- ---------------------------------------------------------------------
-- 6. Confirm
-- ---------------------------------------------------------------------
select g.name, g.accent, coalesce(p.name_override, e.full_name) as led_by
  from public.org_groups g
  join public.org_positions p on p.id = g.root_position_id
  left join app.employee_roster e on e.employee_key = p.employee_key
 order by g.sort_order;
