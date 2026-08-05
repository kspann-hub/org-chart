import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import type { Employee, Group, Orientation, Position } from './lib/types'
import { descendantIds, joinNodes, layoutChart } from './lib/layout'
import { assignGroups, summariseGroups, ungroupedNodes } from './lib/groups'
import { signPhotoPaths } from './lib/photos'
import { downloadBlob, exportChartPng } from './lib/exportPng'
import { Login, WrongAccount } from './components/Login'
import { isCompanyEmail } from './lib/config'
import { Chart } from './components/Chart'
import { Home } from './components/Home'
import { EditPanel } from './components/EditPanel'
import { UnseatedTray } from './components/UnseatedTray'

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
  const [showTray, setShowTray] = useState(false)

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

    // Headshots live in a private bucket, so each one needs a short-lived
    // signed URL. Resolved after the chart is already on screen — initials
    // show in the meantime rather than blocking the render.
    const paths = (seats.data ?? []).map((p) => p.photo_path).filter(Boolean) as string[]
    setPhotoUrls(await signPhotoPaths(paths))
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

  const unseated = useMemo(() => {
    const seated = new Set(positions.map((p) => p.employee_key).filter(Boolean))
    return directory
      .filter((e) => e.employment_status === 'Active' && !seated.has(e.employee_key))
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
  }, [positions, directory])

  const forbiddenIds = useMemo(
    () => (draggingId ? descendantIds(draggingId, nodes) : new Set<string>()),
    [draggingId, nodes],
  )

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

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

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
    const siblings = positions.filter((p) => p.parent_id === parentId)
    const { data, error } = await supabase
      .from('org_positions')
      .insert({
        parent_id: parentId,
        name_override: 'New seat',
        sort_order: Math.max(0, ...siblings.map((s) => s.sort_order)) + 1,
      })
      .select()
      .single()

    if (error) return fail(error)
    await load()
    setSelectedId(data.id)
    setFocusId(data.id)
  }

  async function seatEmployee(employee: Employee) {
    const parentId = selectedId
    const siblings = positions.filter((p) => p.parent_id === parentId)
    const { error } = await supabase.from('org_positions').insert({
      parent_id: parentId,
      employee_key: employee.employee_key,
      title_override: employee.employee_title,
      sort_order: Math.max(0, ...siblings.map((s) => s.sort_order)) + 1,
    })
    if (error) return fail(error)
    await load()
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
            {!onHome && (
              <>
                <button className="btn-quiet" onClick={() => setShowTray((v) => !v)}>
                  Not on the chart{unseated.length > 0 ? ` (${unseated.length})` : ''}
                </button>
                <button className="btn-quiet" onClick={() => void addChild(selectedId)}>
                  {selectedId ? 'Add a report' : 'Add a seat'}
                </button>
              </>
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
            summaries={summaries}
            ungrouped={ungrouped}
            totalSeats={nodes.length}
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

        {isAdmin && !onHome && showTray && (
          <UnseatedTray
            unseated={unseated}
            selectedName={selected?.name ?? null}
            onSeat={(e) => void seatEmployee(e)}
            onClose={() => setShowTray(false)}
          />
        )}

        {isAdmin && !onHome && !showTray && selected && (
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
