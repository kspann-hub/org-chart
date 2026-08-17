import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import type {
  Employee,
  Group,
  HistoryEntry,
  Orientation,
  Position,
  SyncResult,
} from './lib/types'
import { descendantIds, joinNodes, layoutChart } from './lib/layout'
import { layoutCircle } from './lib/circle'
import { assignGroups, summariseGroups, ungroupedNodes } from './lib/groups'
import { signPhotoPaths } from './lib/photos'
import { downloadBlob, exportChartPng } from './lib/exportPng'
import { Login, WrongAccount } from './components/Login'
import { isCompanyEmail } from './lib/config'
import { Chart } from './components/Chart'
import { Home } from './components/Home'
import { EditPanel } from './components/EditPanel'
import { HistoryPanel } from './components/HistoryPanel'

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

  /** null = the landing page; a group id = that vertical; 'all' = everyone. */
  const [view, setViewMode] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // Sync + history are admin tools, kept out of the main data load so a
  // viewer's page never asks for them at all.
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [undoing, setUndoing] = useState<string | null>(null)

  // Horizontal by default: a 76-person top-down tree is ~18,000px wide and
  // unreadable without zooming out past the point of legibility. Remembered
  // per browser so nobody has to re-pick it every visit.
  const [orientation, setOrientation] = useState<Orientation>(
    () => (localStorage.getItem('orgchart.orientation') as Orientation) ?? 'horizontal',
  )

  useEffect(() => {
    localStorage.setItem('orgchart.orientation', orientation)
  }, [orientation])

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
    const channel = supabase
      .channel('org-chart')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'org_positions' }, () => {
        void load()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'org_groups' }, () => {
        void load()
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [session, load])

  // ---------------------------------------------------------------- derived

  const nodes = useMemo(
    () => joinNodes(positions, directory, photoUrls),
    [positions, directory, photoUrls],
  )

  const summaries = useMemo(() => summariseGroups(nodes, groups), [nodes, groups])
  const ungrouped = useMemo(() => ungroupedNodes(nodes, groups), [nodes, groups])
  const membership = useMemo(() => assignGroups(nodes, groups), [nodes, groups])

  const activeGroup = view && view !== 'all' ? groups.find((g) => g.id === view) ?? null : null

  // Opening a vertical charts only its members. The group's root loses its
  // parent from the visible set and becomes the top of the chart, which is
  // exactly what you want when you drill into a branch.
  const visibleNodes = useMemo(
    () => (activeGroup ? nodes.filter((n) => membership.get(n.id) === activeGroup.id) : nodes),
    [nodes, membership, activeGroup],
  )

  const layout = useMemo(
    () => layoutChart(visibleNodes, collapsed, orientation),
    [visibleNodes, collapsed, orientation],
  )

  // The landing page. Laid out from every seat regardless of which vertical is
  // open, because it is the one view that always shows the whole firm.
  const circle = useMemo(() => layoutCircle(nodes, groups), [nodes, groups])

  const accentById = useMemo(() => {
    const byGroup = new Map(groups.map((g) => [g.id, g.accent]))
    return (id: string) => byGroup.get(membership.get(id) ?? '') ?? null
  }, [groups, membership])

  const matchedIds = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return new Set<string>()
    return new Set(
      visibleNodes
        .filter(
          (n) =>
            n.name.toLowerCase().includes(q) ||
            (n.title ?? '').toLowerCase().includes(q) ||
            // Search the Ajera legal name too, so looking up "Samuel" still
            // finds the box that displays "Sam".
            (n.employee?.full_name ?? '').toLowerCase().includes(q) ||
            (n.employee?.employee_email ?? '').toLowerCase().includes(q),
        )
        .map((n) => n.id),
    )
  }, [visibleNodes, query])

  const forbiddenIds = useMemo(
    () => (draggingId ? descendantIds(draggingId, nodes) : new Set<string>()),
    [draggingId, nodes],
  )

  // Every seat on the chart, not just the ones currently visible — the change
  // log names managers that may sit outside the group being viewed.
  const nameById = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes])

  // Which boxes are the signed-in user's own. Matched on Ajera's
  // employee_email, so it only works for people whose login address matches
  // what Ajera has — and one person can legitimately hold several seats.
  const viewerIds = useMemo(() => {
    const email = session?.user.email?.toLowerCase()
    if (!email) return new Set<string>()
    return new Set(
      nodes
        .filter((n) => n.employee?.employee_email?.toLowerCase() === email)
        .map((n) => n.id),
    )
  }, [nodes, session])

  const selected = selectedId ? layout.byId.get(selectedId) ?? null : null

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

  async function addChild(parentId: string | null) {
    // A seat with no parent is a new root. Inside a group view the group's
    // members are the only visible nodes, so a new root lands outside the
    // filter and the click looks like it did nothing. Falling back to the
    // group's own root keeps the new seat where the admin is looking.
    const effectiveParent = parentId ?? activeGroup?.root_position_id ?? null

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

    if (error) return fail(error)
    await load()
    setSelectedId(data.id)
    setFocusId(data.id)
  }

  async function deleteSeat(id: string) {
    const node = layout.byId.get(id)
    if (!node) return

    const message =
      node.childCount > 0
        ? `Delete ${node.name}?\n\nTheir ${node.childCount} direct report(s) will move up to report to ${
            node.position.parent_id ? 'their manager' : 'the top of the chart'
          }.`
        : `Delete ${node.name}?`
    if (!window.confirm(message)) return

    // Promote the children first. The foreign key is ON DELETE RESTRICT, so
    // skipping this step makes the delete fail rather than quietly taking a
    // whole branch with it.
    if (node.childCount > 0) {
      const { error } = await supabase
        .from('org_positions')
        .update({ parent_id: node.position.parent_id })
        .eq('parent_id', id)
      if (error) return fail(error)
    }

    const { error } = await supabase.from('org_positions').delete().eq('id', id)
    if (error) return fail(error)
    setSelectedId(null)
    await load()
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
    const { data, error } = await supabase
      .from('org_position_history')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(100)

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
    if (showHistory) await loadHistory()
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

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function jumpToFirstMatch() {
    const first = layout.nodes.find((n) => matchedIds.has(n.id))
    if (first) {
      setSelectedId(first.id)
      setFocusId(first.id)
    }
  }

  const clearFocus = useCallback(() => setFocusId(null), [])

  const [exporting, setExporting] = useState(false)

  async function exportPng() {
    setExporting(true)
    try {
      const label = activeGroup?.name ?? 'Everyone'
      const blob = await exportChartPng(layout, {
        title: `CriticalArc — ${label}`,
        subtitle: `${layout.nodes.length} of ${nodes.length} people · ${new Date().toLocaleDateString()}`,
        accentOf: accentById,
      })
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      downloadBlob(blob, `org-chart-${slug}.png`)
    } catch (e) {
      fail(e)
    } finally {
      setExporting(false)
    }
  }

  // ------------------------------------------------------------------ render

  if (!authReady) return <div className="boot">Loading…</div>
  if (!session) return <Login />

  // Google will happily authenticate a personal account. RLS already returns
  // them nothing; this just says so instead of showing an empty chart.
  if (!isCompanyEmail(session.user.email)) {
    return <WrongAccount email={session.user.email ?? 'an unknown address'} />
  }

  const onHome = view === null

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">
          <span className="brand-mark">CriticalArc</span>
          {activeGroup ? (
            <>
              <span className="brand-dot" style={{ background: activeGroup.accent }} />
              <span>{activeGroup.name}</span>
            </>
          ) : (
            <span>{onHome ? 'Organization Chart' : 'Everyone'}</span>
          )}
        </h1>

        {!onHome && (
          <div className="search">
            <input
              value={query}
              placeholder="Search anyone…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && jumpToFirstMatch()}
            />
            {query && <span className="search-count">{matchedIds.size}</span>}
          </div>
        )}

        {!onHome && (
          <button
            className="btn-quiet"
            title={
              orientation === 'horizontal'
                ? 'Switch to a classic top-down chart'
                : 'Switch to left-to-right, which fits far better at this headcount'
            }
            onClick={() =>
              setOrientation((o) => (o === 'horizontal' ? 'vertical' : 'horizontal'))
            }
          >
            {orientation === 'horizontal' ? 'Top-down' : 'Left-to-right'}
          </button>
        )}

        {!onHome && viewerIds.size > 0 && (
          <button
            className="btn-quiet"
            onClick={() => {
              const [first] = viewerIds
              setSelectedId(first)
              setFocusId(first)
            }}
          >
            Find me
          </button>
        )}

        <div className="spacer" />

        <span className="count-readout">
          {onHome
            ? `${nodes.length} people`
            : `${layout.nodes.length} in this view · ${nodes.length} total`}
        </span>

        {isAdmin && (
          <>
            <span className="badge">Admin</span>

            {/* Sync and history sit outside the !onHome guard on purpose —
                both are useful from the landing page, and the request was
                for the sync to be reachable from every screen. */}
            <button
              className="btn-quiet"
              onClick={() => void syncAjera()}
              disabled={syncing}
              title="Add anyone new from Ajera. Never deletes, never writes back to Ajera."
            >
              {syncing ? 'Syncing…' : '⟳ Sync with Ajera'}
            </button>

            <button
              className="btn-quiet"
              onClick={() => {
                const next = !showHistory
                setShowHistory(next)
                if (next) void loadHistory()
              }}
              title="See recent edits and undo one"
            >
              Recent changes
            </button>

            {!onHome && (
              <button
                className="btn-quiet"
                onClick={() => void addChild(selectedId)}
                title={
                  selectedId
                    ? 'Add a seat reporting to the selected box'
                    : 'Add a seat, then pick who fills it'
                }
              >
                {selectedId ? 'Add a report' : 'Add a person'}
              </button>
            )}
          </>
        )}

        {!onHome && (
          <button
            className="btn-quiet"
            onClick={() => {
              setViewMode(null)
              setSelectedId(null)
              setQuery('')
            }}
          >
            ← All groups
          </button>
        )}

        {!onHome && (
          <button
            className="btn-quiet"
            onClick={() => void exportPng()}
            disabled={exporting}
            title="Download this chart as an image"
          >
            {exporting ? 'Rendering…' : '↓ PNG'}
          </button>
        )}
        <button className="btn-quiet" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      {error && (
        <div className="banner">
          {error}
          <button className="btn-quiet" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div className="banner is-notice">
          {notice}
          <button className="btn-quiet" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="body">
        {loading ? (
          <div className="boot">Loading the chart…</div>
        ) : nodes.length === 0 ? (
          <div className="boot">
            No seats yet. Run <code>supabase/02_seed_positions.sql</code> to create one per active
            employee.
          </div>
        ) : onHome ? (
          <Home
            circle={circle}
            summaries={summaries}
            ungrouped={ungrouped}
            totalSeats={nodes.length}
            viewerIds={viewerIds}
            onOpenGroup={(id) => setViewMode(id)}
            onOpenAll={() => setViewMode('all')}
          />
        ) : (
          <Chart
            layout={layout}
            isAdmin={isAdmin}
            selectedId={selectedId}
            matchedIds={matchedIds}
            searching={query.trim().length > 0}
            collapsed={collapsed}
            forbiddenIds={forbiddenIds}
            viewerIds={viewerIds}
            orientation={orientation}
            accentOf={accentById}
            onSelect={setSelectedId}
            onToggleCollapse={toggleCollapse}
            onReparent={(child, parent) => void reparent(child, parent)}
            onDragStateChange={setDraggingId}
            focusId={focusId}
            onFocusHandled={clearFocus}
          />
        )}

        {isAdmin && !onHome && selected && (
          <EditPanel
            node={selected}
            directory={directory}
            allNodes={nodes}
            forbiddenIds={descendantIds(selected.id, nodes)}
            childCount={selected.childCount}
            group={groups.find((g) => g.root_position_id === selected.id) ?? null}
            onSave={(patch) => savePatch(selected.id, patch)}
            onSaveGroup={(next) => saveGroup(selected.id, next)}
            onAddChild={() => void addChild(selected.id)}
            onDelete={() => void deleteSeat(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        )}

        {isAdmin && showHistory && (
          <HistoryPanel
            entries={history}
            nameFor={(id) => (id ? layout.byId.get(id)?.name ?? nameById.get(id) ?? null : null)}
            undoing={undoing}
            onUndo={(entry) => void undoChange(entry)}
            onRefresh={() => void loadHistory()}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>

      <footer className="statusbar">
        <span>{session.user.email}</span>
        <span>
          {isAdmin
            ? onHome
              ? 'Open a group to edit it.'
              : 'Click a box to edit. Drag one onto another to change who it reports to.'
            : 'View only'}
        </span>
      </footer>
    </div>
  )
}
