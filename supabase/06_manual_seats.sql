-- =====================================================================
-- Org chart — mark which seats were added by hand
-- Run this AFTER 01–05. Safe to re-run.
--
-- Adds one column, org_positions.source. It answers a question the chart
-- could not previously answer: did this box come from Ajera, or did an admin
-- create it here?
--
-- The chart draws a hand-added seat in its vertical's colour, like every
-- other box, but ringed with a white dashed outline — so it reads as part of
-- the branch while still being obviously something the roster doesn't know
-- about. The Recent changes panel uses the same column to say whether a new
-- person arrived from a sync or was typed in.
--
-- No new table and no new policy: the column sits on org_positions, so the
-- existing rules already cover it — company email can read it, only an admin
-- can write it, and the change log records it like any other column.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------
-- It defaults to 'ajera' on purpose, and that default is what makes this
-- file safe to run against a database that is already full of seats:
--
--   * every existing row becomes 'ajera' the moment the column is added
--   * the seed (02) and the sync (04) insert without naming it, so anything
--     they create from now on is 'ajera' too, with no change to either
--   * the app names it explicitly when an admin clicks "Add a person" or
--     "Add a report", which is the only path that produces 'manual'
--
-- So the flag means "this seat was created in the app by a person", and
-- everything else — including a seat you insert by hand in the SQL Editor —
-- reads as coming from the roster. Section 3 has the one-liner for flipping
-- a seat either way if that ever needs correcting.

alter table public.org_positions
  add column if not exists source text not null default 'ajera';

do $$
begin
  alter table public.org_positions
    add constraint org_positions_source_check
    check (source in ('ajera', 'manual'));
exception
  when duplicate_object then null;  -- already there, fine
end;
$$;

comment on column public.org_positions.source is
  'How this seat came to exist. ''ajera'' = created by the seed or the sync '
  'from the roster. ''manual'' = created in the app by an admin. Drives the '
  'white dashed outline on the chart; carries no other behaviour.';


-- ---------------------------------------------------------------------
-- 2. Backfill the seats that were already added by hand
-- ---------------------------------------------------------------------
-- Section 1 made every existing seat 'ajera', which is wrong for the ones an
-- admin created before this column existed. The change log can identify most
-- of them: the seed and the sync only ever insert a seat that already has an
-- employee_key, whereas "Add a person" creates an empty seat first and lets
-- the admin choose who fills it afterwards. So an insert logged with no
-- employee_key was a person clicking the button.
--
-- This only reaches back as far as 04_sync_and_history.sql — seats created
-- before the log existed leave no trace and stay 'ajera'. Fix any of those by
-- hand with the statement in section 3; there are unlikely to be many.

update public.org_positions p
   set source = 'manual'
 where p.source <> 'manual'
   and exists (
     select 1
       from public.org_position_history h
      where h.position_id = p.id
        and h.action = 'insert'
        and h.after_row ->> 'employee_key' is null
   );


-- ---------------------------------------------------------------------
-- 3. Correcting a seat by hand
-- ---------------------------------------------------------------------
-- Which seats currently carry the dashed outline:
--
--   select coalesce(p.name_override, e.full_name, 'Vacant') as seat,
--          coalesce(p.title_override, e.employee_title)     as title
--     from public.org_positions p
--     left join app.employee_roster e on e.employee_key = p.employee_key
--    where p.source = 'manual'
--    order by 1;
--
-- Mark one as hand-added (or set it back to 'ajera' to drop the outline):
--
--   update public.org_positions p
--      set source = 'manual'
--     from app.employee_roster e
--    where e.employee_key = p.employee_key
--      and coalesce(p.name_override, e.full_name) = 'Jane Doe';
--
-- A person holding several seats matches on every one of them, so check what
-- you are about to write first. Editing a seat this way is logged and shows
-- up in Recent changes like any other edit.


-- ---------------------------------------------------------------------
-- 4. Teach undo about the new column
-- ---------------------------------------------------------------------
-- Same reasoning as section 2 of 05_linkedin.sql. The log already captures
-- source, because it stores whole rows — but org_undo_change() names its
-- columns one by one, and a column it doesn't name is not restored. Without
-- this, undoing the deletion of a hand-added seat would bring it back looking
-- like it came from Ajera.
--
-- This is the 05 version of the function with source added in two places.

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
       show_title, sort_order, photo_path, linkedin_url, source)
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

comment on function public.org_undo_change(uuid) is
  'Reverses one entry in org_position_history. Admin-gated internally '
  'because it is security definer. Knows about linkedin_url as of 05 and '
  'source as of 06.';

revoke all    on function public.org_undo_change(uuid) from public, anon;
grant execute on function public.org_undo_change(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 5. Confirm
-- ---------------------------------------------------------------------
-- "added by hand" counts the seats that will now be drawn with the white
-- dashed outline. On a chart nobody has added to yet, zero is the right
-- answer and nothing on screen changes.

select 'seats total'   as check, count(*)::text as result from public.org_positions
union all
select 'from Ajera',    count(*) filter (where source = 'ajera')::text  from public.org_positions
union all
select 'added by hand', count(*) filter (where source = 'manual')::text from public.org_positions;
