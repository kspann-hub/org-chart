-- =====================================================================
-- 04 — Ajera sync + change history (undo)
--
-- Run this AFTER 01, 02 and 03. It adds:
--   public.org_sync_ajera()        the "Sync with Ajera" button's engine
--   public.org_position_history    every edit, with enough detail to undo it
--   public.org_undo_change(uuid)   reverse one entry from that log
--
-- As everywhere else in this project, NOTHING here writes to mart.employees.
-- Ajera stays the source of truth for who exists; this only ever touches
-- public.org_positions, which is the app's own table.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Ajera sync
-- ---------------------------------------------------------------------
-- This is STEP 2 + STEP 3 of the seed script, callable from the app.
--
-- It is deliberately ADD-ONLY:
--   * new Active people in Ajera get a seat
--   * seats with no manager get slotted under their Ajera supervisor
--   * people who left are COUNTED and reported, never auto-deleted
--
-- The last point matters. A seat can hold hand-entered work — a title
-- override, a photo, a group root, a whole branch reporting to it. Deleting
-- it because Ajera flipped a status would throw that away silently. So the
-- sync reports departures and a human decides.
--
-- security definer is required: app.employee_roster is intentionally
-- unreachable over the API, so the calling user cannot read it directly.
-- That makes the admin check on the first line the thing standing between
-- any logged-in employee and a write. It is not optional.

create or replace function public.org_sync_ajera()
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_added    integer := 0;
  v_parented integer := 0;
  v_departed integer := 0;
  v_total    integer := 0;
begin
  if not public.is_org_admin() then
    raise exception 'Only org chart admins can run the Ajera sync.'
      using errcode = '42501';
  end if;

  -- New hires: one seat each, no title_override so the box shows the live
  -- Ajera title and a later promotion reaches the chart by itself.
  with new_seats as (
    insert into public.org_positions (employee_key, sort_order)
    select e.employee_key,
           row_number() over (order by e.full_name)
      from app.employee_roster e
     where e.employment_status = 'Active'
       and not exists (
         select 1 from public.org_positions p where p.employee_key = e.employee_key
       )
    returning 1
  )
  select count(*) into v_added from new_seats;

  -- Slot unparented seats under their Ajera supervisor. Only touches seats
  -- with no parent, so hand-arranging done in the app survives a sync.
  -- The self-reference guard keeps whoever runs the company at the top
  -- rather than tripping the cycle trigger.
  with parented as (
    update public.org_positions child
       set parent_id = parent.id
      from app.employee_roster e
      join public.org_positions parent on parent.employee_key = e.supervisor_key
     where child.employee_key = e.employee_key
       and child.parent_id is null
       and e.supervisor_key is not null
       and e.supervisor_key <> e.employee_key
       and parent.id <> child.id
    returning 1
  )
  select count(*) into v_parented from parented;

  -- Seats pointing at someone Ajera no longer lists as Active. Reported
  -- only — the app shows these as "stale" and an admin clears them by hand.
  select count(*) into v_departed
    from public.org_positions p
   where p.employee_key is not null
     and not exists (
       select 1
         from app.employee_roster e
        where e.employee_key = p.employee_key
          and e.employment_status = 'Active'
     );

  select count(*) into v_total from public.org_positions;

  return jsonb_build_object(
    'added',    v_added,
    'parented', v_parented,
    'departed', v_departed,
    'total',    v_total
  );
end;
$$;

comment on function public.org_sync_ajera() is
  'Pulls new Active people from Ajera into the chart and parents them by '
  'supervisor. Add-only: never deletes a seat, never writes to mart.employees. '
  'Admin-gated internally because it is security definer.';

revoke all    on function public.org_sync_ajera() from public, anon;
grant execute on function public.org_sync_ajera() to authenticated;


-- ---------------------------------------------------------------------
-- 2. Change history
-- ---------------------------------------------------------------------
-- One row per edit to public.org_positions, holding the whole row before and
-- after as jsonb. Storing whole rows rather than a diff means undo does not
-- need to know which columns existed when the entry was written — a column
-- added later cannot corrupt an older undo.

create table if not exists public.org_position_history (
  id           uuid primary key default gen_random_uuid(),
  position_id  uuid not null,
  action       text not null check (action in ('insert', 'update', 'delete')),
  before_row   jsonb,
  after_row    jsonb,
  -- Cached so the log still reads sensibly after the seat is gone.
  label        text,
  changed_at   timestamptz not null default now(),
  changed_by   text,
  undone_at    timestamptz,
  undone_by    text
);

create index if not exists org_position_history_at_idx
  on public.org_position_history (changed_at desc);

comment on table public.org_position_history is
  'Append-only log of edits to org_positions. Feeds the Recent changes panel '
  'and public.org_undo_change().';

-- A readable name for the log, resolved the same way the app resolves a box
-- title: the override first, then the Ajera name, then "Vacant".
create or replace function public.org_position_label(p_row jsonb)
returns text
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(
    nullif(p_row ->> 'name_override', ''),
    (select e.full_name
       from app.employee_roster e
      where e.employee_key = p_row ->> 'employee_key'),
    'Vacant seat'
  );
$$;

create or replace function public.org_positions_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text := coalesce(auth.jwt() ->> 'email', 'system');
begin
  if tg_op = 'INSERT' then
    insert into public.org_position_history (position_id, action, after_row, label, changed_by)
    values (new.id, 'insert', to_jsonb(new), public.org_position_label(to_jsonb(new)), v_actor);
    return new;

  elsif tg_op = 'UPDATE' then
    -- Skip no-op updates, which would otherwise bury the real edits. The
    -- touch trigger always bumps updated_at, so those two columns are
    -- excluded from the comparison.
    if to_jsonb(old) - 'updated_at' - 'updated_by'
         is not distinct from to_jsonb(new) - 'updated_at' - 'updated_by' then
      return new;
    end if;

    insert into public.org_position_history
      (position_id, action, before_row, after_row, label, changed_by)
    values (new.id, 'update', to_jsonb(old), to_jsonb(new),
            public.org_position_label(to_jsonb(new)), v_actor);
    return new;

  else
    insert into public.org_position_history (position_id, action, before_row, label, changed_by)
    values (old.id, 'delete', to_jsonb(old), public.org_position_label(to_jsonb(old)), v_actor);
    return old;
  end if;
end;
$$;

drop trigger if exists org_positions_log_trg on public.org_positions;
create trigger org_positions_log_trg
  after insert or update or delete on public.org_positions
  for each row execute function public.org_positions_log();


-- ---------------------------------------------------------------------
-- 3. Who can see the log
-- ---------------------------------------------------------------------
-- Admins only. It is an editing tool, and it names who changed what.
-- Writes come from the trigger (security definer), never from the client,
-- so there is no insert or update policy here at all.

alter table public.org_position_history enable row level security;

drop policy if exists org_position_history_read on public.org_position_history;

create policy org_position_history_read
  on public.org_position_history
  for select
  to authenticated
  using (public.is_org_admin());

grant select on public.org_position_history to authenticated;
revoke all    on public.org_position_history from anon;


-- ---------------------------------------------------------------------
-- 4. Undo
-- ---------------------------------------------------------------------
-- Reverses one logged change:
--   update -> put the old values back
--   insert -> remove the seat that was added
--   delete -> recreate the seat, with its original id
--
-- Undoing is itself an edit, so it writes its own history row. That is
-- deliberate: an undo can be undone, and the log stays a true account of
-- what happened rather than pretending the first edit never did.

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
           photo_path     =  h.before_row ->> 'photo_path'
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
       show_title, sort_order, photo_path)
    values (
      h.position_id,
      (h.before_row ->> 'parent_id')::uuid,
       h.before_row ->> 'employee_key',
       h.before_row ->> 'name_override',
       h.before_row ->> 'title_override',
      (h.before_row ->> 'show_title')::boolean,
      (h.before_row ->> 'sort_order')::integer,
       h.before_row ->> 'photo_path'
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
  'because it is security definer.';

revoke all    on function public.org_undo_change(uuid) from public, anon;
grant execute on function public.org_undo_change(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 5. Confirm
-- ---------------------------------------------------------------------
-- Expect: three functions, one table, one trigger, one policy.

select 'functions' as what, string_agg(proname, ', ' order by proname) as found
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('org_sync_ajera', 'org_undo_change', 'org_positions_log')
union all
select 'history table', count(*)::text from information_schema.tables
 where table_schema = 'public' and table_name = 'org_position_history'
union all
select 'trigger', count(*)::text from pg_trigger
 where tgname = 'org_positions_log_trg' and not tgisinternal;
