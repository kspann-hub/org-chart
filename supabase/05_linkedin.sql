-- =====================================================================
-- Org chart — LinkedIn profile links
-- Run this AFTER 01–04. Safe to re-run.
--
-- Adds one column, org_positions.linkedin_url. Admins fill it in from the
-- edit panel; everyone sees a small LinkedIn badge on the corner of that
-- person's photo, which opens the profile in a new tab.
--
-- No new table, no new policy: the column sits on org_positions, so the
-- existing rules already cover it — company email can read it, only an admin
-- can write it, and the change log records edits to it like any other.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------
-- Stored on the seat rather than the person, exactly like photo_path. That
-- means a placeholder seat with nobody in it can still carry a link — and it
-- also means someone who holds several seats needs the link on each one they
-- should show a badge on.

alter table public.org_positions
  add column if not exists linkedin_url text;

comment on column public.org_positions.linkedin_url is
  'Full LinkedIn profile URL, e.g. https://www.linkedin.com/in/jane-doe. '
  'Null means no badge is drawn. The app normalises whatever is pasted before '
  'saving; the CHECK below is the backstop.';

-- Only ever an https linkedin.com address. This is what stops a hand-edited
-- row from putting a `javascript:` or off-site link behind a badge on the
-- chart. `add constraint if not exists` isn't a thing in Postgres, hence the
-- block — which is what keeps this file re-runnable.
do $$
begin
  alter table public.org_positions
    add constraint org_positions_linkedin_url_check
    check (
      linkedin_url is null
      or linkedin_url ~* '^https://([a-z0-9-]+\.)*linkedin\.com/.+'
    );
exception
  when duplicate_object then null;  -- already there, fine
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Teach undo about the new column
-- ---------------------------------------------------------------------
-- org_position_history stores whole rows, so the log itself already captured
-- linkedin_url the moment the column existed. But org_undo_change() names its
-- columns one by one, and a column it doesn't name is simply not restored.
--
-- This is the same function as in 04_sync_and_history.sql with linkedin_url
-- added in two places. Replacing it here rather than editing that file means
-- a database built from 01–04 and one built from 01–05 both end up correct,
-- and nothing already run needs running again.

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
           linkedin_url   =  h.before_row ->> 'linkedin_url'
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
       show_title, sort_order, photo_path, linkedin_url)
    values (
      h.position_id,
      (h.before_row ->> 'parent_id')::uuid,
       h.before_row ->> 'employee_key',
       h.before_row ->> 'name_override',
       h.before_row ->> 'title_override',
      (h.before_row ->> 'show_title')::boolean,
      (h.before_row ->> 'sort_order')::integer,
       h.before_row ->> 'photo_path',
       h.before_row ->> 'linkedin_url'
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
  'because it is security definer. Knows about linkedin_url as of 05.';

revoke all    on function public.org_undo_change(uuid) from public, anon;
grant execute on function public.org_undo_change(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 3. Filling links in without clicking through the app
-- ---------------------------------------------------------------------
-- The edit panel is the normal way: click a box, paste the address into
-- "LinkedIn profile", Save. For a batch, match on the displayed name:
--
--   update public.org_positions p
--      set linkedin_url = v.url
--     from (values
--       ('Justin Harder', 'https://www.linkedin.com/in/justin-harder'),
--       ('Holly Smith',   'https://www.linkedin.com/in/holly-smith')
--     ) as v(person, url)
--     left join app.employee_roster e on true
--    where coalesce(p.name_override, e.full_name) = v.person
--      and e.employee_key = p.employee_key;
--
-- Check what you are about to write first — a person holding several seats
-- gets the badge on every seat this matches.


-- ---------------------------------------------------------------------
-- 4. Confirm
-- ---------------------------------------------------------------------
select 'seats total'            as check, count(*)::text as result from public.org_positions
union all
select 'seats with a LinkedIn', count(*) filter (where linkedin_url is not null)::text
  from public.org_positions;
