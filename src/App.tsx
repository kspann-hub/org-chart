import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import type { Employee, Group, HistoryEntry, Position, SyncResult } from './lib/types'
import { joinNodes } from './lib/layout'
import { signPhotoPaths } from './lib/photos'
import { Login, WrongAccount } from './components/Login'
import { isCompanyEmail } from './lib/config'
import { Workspace, type WorkspaceActions } from './components/Workspace'

/**
 * How long to wait for realtime events to stop arriving before reloading.
 *
 * Realtime sends one event per changed row, and load() is three whole-table
 * selects plus an RPC. "Sync with Ajera" rewrites many seats in one go, so
 * without this a sync ran that entire load once per changed row, in every tab
 * anyone had open. Long enough to swallow a sync's burst, short enough that a
 * single drag still looks instant to everyone else.
 */
const REALTIME_SETTLE_MS = 400

/** Whether two path -> signed-URL maps hold exactly the same entries. */
function sameUrls(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [path, url] of a) if (b.get(path) !== url) return false
  return true
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)

  const [positions, setPositions] = useState<Position[]>([])
  const [directory, setDirectory] = useState<Employee[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map())
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Sync + history are admin tools, kept out of the main data load so a
  // viewer's page never asks for them at all.
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<{ result: SyncResult; at: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [undoing, setUndoing] = useState<string | null>(null)

  // ------------------------------------------------------------------ auth

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => sub.subscription.unsubscribe()
  }, [])

  // ------------------------------------------------------------------ data

  const load = useCallback(async () => {
    const [seats, people, groupRows, admin] = await Promise.all([
      supabase.from('org_positions').select('*'),
      supabase.from('employee_directory').select('*'),
      supabase.from('org_groups').select('*'),
      supabase.rpc('is_org_admin'),
    ])

    // org_groups only exists after 03_groups_and_photos.sql has been run. Its
    // absence shouldn't take down a chart that otherwise works, so it's
    // excluded from the failure check and just yields no groups.
    const failure = seats.error ?? people.error ?? admin.error
    if (failure) {
      setError(failure.message)
      setLoading(false)
      return
    }

    setError(null)
    setPositions(seats.data ?? [])
    setDirectory(people.data ?? [])
    setGroups(groupRows.data ?? [])
    setIsAdmin(admin.data === true)
    setLoading(false)

    // Headshots live in a private bucket, so each one needs a signed URL.
    // Resolved after the chart is already on screen — initials show in the
    // meantime rather than blocking the render.
    const paths = (seats.data ?? []).map((p) => p.photo_path).filter(Boolean) as string[]
    const nextUrls = await signPhotoPaths(paths)

    // load() runs on mount, after every mutation, and on every realtime change
    // to org_positions — so an admin dragging one box re-ran this for every open
    // tab. Handing back a fresh Map each time recomputed the layout and gave
    // every <img> a new src, which re-downloaded all 78 photos. Keeping the
    // previous object when the URLs are unchanged makes that free.
    setPhotoUrls((prev) => (sameUrls(prev, nextUrls) ? prev : nextUrls))
  }, [])

  useEffect(() => {
    if (!session) return
    void load()

    // Viewers see an admin's edits without reloading. If Realtime isn't
    // enabled on the table this simply never fires — the app still works,
    // it just needs a refresh to pick up changes.
    let timer: ReturnType<typeof setTimeout> | undefined
    const reload = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), REALTIME_SETTLE_MS)
    }

    const channel = supabase
      .channel('org-chart')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'org_positions' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'org_groups' }, reload)
      .subscribe()

    return () => {
      clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [session, load])

  // ---------------------------------------------------------------- derived

  const nodes = useMemo(
    () => joinNodes(positions, directory, photoUrls),
    [positions, directory, photoUrls],
  )

  // --------------------------------------------------------------- mutations
  // Every one of these can be refused by the database if the caller isn't an
  // admin. That's the real guard; the UI just doesn't offer them.

  // Supabase hands back a plain object, not an Error. Running that through
  // String() yields "[object Object]", which is how a refused write used to
  // look like nothing happening at all.
  const fail = (e: unknown) => {
    if (e instanceof Error) return setError(e.message)
    if (e && typeof e === 'object' && 'message' in e) {
      const { message, hint } = e as { message?: unknown; hint?: unknown }
      return setError([message, hint].filter(Boolean).join(' — ') || 'Something went wrong.')
    }
    setError(String(e))
  }

  async function reparent(childId: string, newParentId: string | null) {
    const { error } = await supabase
      .from('org_positions')
      .update({ parent_id: newParentId })
      .eq('id', childId)
    if (error) return fail(error)
    await load()
  }

  async function savePatch(id: string, patch: Record<string, unknown>) {
    const { error } = await supabase.from('org_positions').update(patch).eq('id', id)
    if (error) throw new Error(error.message)
    await load()
  }

  /** Create, update or clear the group rooted at a seat. */
  async function saveGroup(
    positionId: string,
    next: { name: string; accent: string } | null,
  ) {
    const existing = groups.find((g) => g.root_position_id === positionId) ?? null

    if (!next) {
      if (!existing) return
      const { error } = await supabase.from('org_groups').delete().eq('id', existing.id)
      if (error) throw new Error(error.message)
    } else if (existing) {
      const { error } = await supabase
        .from('org_groups')
        .update({ name: next.name, accent: next.accent })
        .eq('id', existing.id)
      if (error) throw new Error(error.message)
    } else {
      const { error } = await supabase.from('org_groups').insert({
        root_position_id: positionId,
        name: next.name,
        accent: next.accent,
        sort_order: Math.max(0, ...groups.map((g) => g.sort_order)) + 1,
      })
      if (error) throw new Error(error.message)
    }
    await load()
  }

  /** Resolves to the new seat's id. Workspace picks the parent. */
  async function addSeat(effectiveParent: string | null): Promise<string | null> {
    const siblings = positions.filter((p) => p.parent_id === effectiveParent)
    const seat = {
      parent_id: effectiveParent,
      name_override: 'New seat',
      sort_order: Math.max(0, ...siblings.map((s) => s.sort_order)) + 1,
      // This is the only place a seat is created by a person, so it is the
      // only place 'manual' is written. It's what draws the white dashes.
      source: 'manual' as const,
    }

    let { data, error } = await supabase.from('org_positions').insert(seat).select().single()

    // A database that hasn't had 06_manual_seats.sql run has no source column,
    // and PostgREST rejects the whole insert for naming it. Adding a seat is
    // more important than marking it, so drop the flag and try once more.
    if (error?.code === 'PGRST204') {
      const { source: _dropped, ...withoutSource } = seat
      ;({ data, error } = await supabase
        .from('org_positions')
        .insert(withoutSource)
        .select()
        .single())
    }

    if (error) {
      fail(error)
      return null
    }
    await load()
    return data.id as string
  }

  async function deleteSeat(id: string): Promise<boolean> {
    const node = nodes.find((n) => n.id === id)
    if (!node) return false
    const childCount = positions.filter((p) => p.parent_id === id).length

    const message =
      childCount > 0
        ? `Delete ${node.name}?\n\nTheir ${childCount} direct report(s) will move up to report to ${
            node.position.parent_id ? 'their manager' : 'the top of the chart'
          }.`
        : `Delete ${node.name}?`
    if (!window.confirm(message)) return false

    // Promote the children first. The foreign key is ON DELETE RESTRICT, so
    // skipping this step makes the delete fail rather than quietly taking a
    // whole branch with it.
    if (childCount > 0) {
      const { error } = await supabase
        .from('org_positions')
        .update({ parent_id: node.position.parent_id })
        .eq('parent_id', id)
      if (error) {
        fail(error)
        return false
      }
    }

    const { error } = await supabase.from('org_positions').delete().eq('id', id)
    if (error) {
      fail(error)
      return false
    }
    await load()
    return true
  }

  // ------------------------------------------------------- sync + history
  // Both of these lean on functions added by 04_sync_and_history.sql. If that
  // script hasn't been run the RPC 404s, so the message says which file to
  // run rather than showing Postgres's own wording.

  const missingScript = (e: { message?: string; code?: string }) =>
    e.code === 'PGRST202' || (e.message ?? '').includes('org_sync_ajera')
      ? 'Run supabase/04_sync_and_history.sql in the SQL Editor first — this feature needs it.'
      : null

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    const { data, error } = await supabase
      .from('org_position_history')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(100)
    setHistoryLoading(false)

    if (error) return fail(missingScript(error) ?? error)
    setHistory((data ?? []) as HistoryEntry[])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function syncAjera() {
    if (
      !window.confirm(
        'Pull the latest roster from Ajera?\n\n' +
          'This only ADDS people who are missing and slots them under their ' +
          'Ajera manager. It never deletes a seat, never moves one you have ' +
          'already arranged by hand, and never writes back to Ajera.',
      )
    ) {
      return
    }

    setSyncing(true)
    setNotice(null)
    const { data, error } = await supabase.rpc('org_sync_ajera')
    setSyncing(false)

    if (error) return fail(missingScript(error) ?? error)

    const r = data as SyncResult
    setLastSync({ result: r, at: new Date().toISOString() })
    const parts = [
      r.added === 0
        ? 'No new people to add'
        : `Added ${r.added} new ${r.added === 1 ? 'person' : 'people'}`,
      r.parented > 0 && `slotted ${r.parented} under their manager`,
      r.departed > 0 &&
        `${r.departed} ${r.departed === 1 ? 'seat holds someone' : 'seats hold people'} ` +
          'Ajera no longer lists as active — those are flagged, not removed',
    ].filter(Boolean)

    setNotice(`${parts.join(' · ')}. ${r.total} seats total.`)
    await load()
    // Cheap, admin-only, and it is what makes the Recent changes page show
    // the sync's additions without a manual refresh.
    await loadHistory()
  }

  async function undoChange(entry: HistoryEntry) {
    setUndoing(entry.id)
    const { error } = await supabase.rpc('org_undo_change', { p_history_id: entry.id })
    setUndoing(null)

    if (error) return fail(error)
    setNotice('Change undone.')
    await load()
    await loadHistory()
  }

  // ------------------------------------------------------------------ render

  if (!authReady) return <div className="boot">Loading…</div>
  if (!session) return <Login />

  // Google will happily authenticate a personal account. RLS already returns
  // them nothing; this just says so instead of showing an empty chart.
  if (!isCompanyEmail(session.user.email)) {
    return <WrongAccount email={session.user.email ?? 'an unknown address'} />
  }

  const actions: WorkspaceActions = {
    reparent,
    savePatch,
    saveGroup,
    addSeat,
    deleteSeat,
    sync: syncAjera,
    loadHistory,
    undo: undoChange,
    signOut: () => void supabase.auth.signOut(),
    fail,
  }

  return (
    <Workspace
      nodes={nodes}
      directory={directory}
      groups={groups}
      isAdmin={isAdmin}
      email={session.user.email ?? null}
      loading={loading}
      empty={
        <>
          No seats yet. Run <code>supabase/02_seed_positions.sql</code> to create one per active
          employee.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      history={history}
      historyLoading={historyLoading}
      undoing={undoing}
      syncing={syncing}
      lastSync={lastSync}
      actions={actions}
    />
  )
}
