import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ChartNode,
  Employee,
  Group,
  HistoryEntry,
  Orientation,
  SyncResult,
} from '../lib/types'
import { descendantIds, layoutChart } from '../lib/layout'
import { layoutCircle, RING_NAMES } from '../lib/circle'
import { assignGroups, summariseGroups, ungroupedNodes } from '../lib/groups'
import { buildForest, verticalStats, type Forest } from '../lib/tree'
import { downloadBlob, exportChartPng } from '../lib/exportPng'
import { Sidebar, type Page } from './Sidebar'
import { Overview } from './Overview'
import { ReportingMap } from './ReportingMap'
import { ChangesPage } from './ChangesPage'
import { Chart } from './Chart'
import { EditPanel } from './EditPanel'
import { PersonCard, type PersonContext, type PersonEditor } from './PersonCard'
import { IconBack, IconFlask } from './Icons'

/** Everything that touches the database. App supplies the real ones. */
export type WorkspaceActions = {
  reparent: (childId: string, newParentId: string | null) => Promise<void>
  savePatch: (id: string, patch: Record<string, unknown>) => Promise<void>
  saveGroup: (positionId: string, next: { name: string; accent: string } | null) => Promise<void>
  /** Resolves to the new seat's id, or null if it failed. */
  addSeat: (parentId: string | null) => Promise<string | null>
  /** Resolves to true once the seat is gone. Asks for confirmation itself. */
  deleteSeat: (id: string) => Promise<boolean>
  sync: () => Promise<void>
  loadHistory: () => Promise<void>
  undo: (entry: HistoryEntry) => Promise<void>
  signOut: () => void
  fail: (e: unknown) => void
}

type Props = {
  nodes: ChartNode[]
  directory: Employee[]
  groups: Group[]
  isAdmin: boolean
  email: string | null
  loading: boolean
  /** Shown in place of the screens when there are no seats at all. */
  empty: React.ReactNode
  error: string | null
  notice: string | null
  onDismissError: () => void
  onDismissNotice: () => void
  history: HistoryEntry[]
  historyLoading: boolean
  undoing: string | null
  syncing: boolean
  lastSync: { result: SyncResult; at: string } | null
  actions: WorkspaceActions
}

const SEARCH_LIMIT = 8

function readOrientation(): Orientation {
  try {
    const v = localStorage.getItem('orgchart.orientation')
    return v === 'vertical' || v === 'horizontal' ? v : 'horizontal'
  } catch {
    return 'horizontal'
  }
}

/**
 * The signed-in app: the sidebar and whichever screen it has open.
 *
 * Holds view state only — what's selected, what's folded, which screen. The
 * data and every write come in from App, which is what lets the fixture draw
 * these exact screens from a made-up firm without Supabase.
 */
export function Workspace(props: Props) {
  const { nodes, groups, isAdmin, actions } = props

  const [page, setPage] = useState<Page>({ kind: 'home' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // Horizontal by default: a 76-person top-down tree is ~18,000px wide and
  // unreadable without zooming out past the point of legibility. Remembered
  // per browser so nobody has to re-pick it every visit.
  const [orientation, setOrientation] = useState<Orientation>(readOrientation)
  useEffect(() => {
    try {
      localStorage.setItem('orgchart.orientation', orientation)
    } catch {
      // Private window or blocked storage: the choice just isn't remembered.
    }
  }, [orientation])

  // ---------------------------------------------------------------- derived

  const membership = useMemo(() => assignGroups(nodes, groups), [nodes, groups])
  const summaries = useMemo(() => summariseGroups(nodes, groups), [nodes, groups])
  const ungrouped = useMemo(() => ungroupedNodes(nodes, groups), [nodes, groups])

  const activeGroup =
    page.kind === 'group' ? groups.find((g) => g.id === page.id) ?? null : null

  // A vertical deleted from under the page (by this admin, or another one in
  // realtime) leaves nothing to show. Go back to the overview.
  useEffect(() => {
    if (page.kind === 'group' && !props.loading && !activeGroup) setPage({ kind: 'home' })
  }, [page, activeGroup, props.loading])

  const isTree = (page.kind === 'group' || page.kind === 'all') && page.mode === 'tree'

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

  const circle = useMemo(() => layoutCircle(nodes, groups), [nodes, groups])

  const accentById = useMemo(() => {
    const byGroup = new Map(groups.map((g) => [g.id, g.accent]))
    return (id: string) => byGroup.get(membership.get(id) ?? '') ?? null
  }, [groups, membership])

  // Every word has to appear somewhere, in any order, so "pm delivery" finds
  // a Delivery project manager. Searches the Ajera legal name too, so looking
  // up "Samuel" still finds the box that displays "Sam".
  const matches = useCallback((n: ChartNode, q: string) => {
    const hay = [n.name, n.title, n.employee?.full_name, n.employee?.employee_email]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return q.split(/\s+/).every((word) => hay.includes(word))
  }, [])

  const q = query.trim().toLowerCase()

  const matchedIds = useMemo(
    () => (q ? new Set(visibleNodes.filter((n) => matches(n, q)).map((n) => n.id)) : new Set<string>()),
    [visibleNodes, q, matches],
  )

  const searchResults = useMemo(() => {
    if (!q) return []
    // Names that start with the query first: "an" should find Ana before Brian.
    return nodes
      .filter((n) => matches(n, q))
      .sort(
        (a, b) =>
          Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, SEARCH_LIMIT)
  }, [nodes, q, matches])

  const forbiddenIds = useMemo(
    () => (draggingId ? descendantIds(draggingId, nodes) : new Set<string>()),
    [draggingId, nodes],
  )

  const nameById = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes])

  // Which boxes are the signed-in user's own. Matched on Ajera's
  // employee_email, so it only works for people whose login address matches
  // what Ajera has — and one person can legitimately hold several seats.
  const viewerIds = useMemo(() => {
    const email = props.email?.toLowerCase()
    if (!email) return new Set<string>()
    return new Set(
      nodes.filter((n) => n.employee?.employee_email?.toLowerCase() === email).map((n) => n.id),
    )
  }, [nodes, props.email])

  const selected = isTree && selectedId ? layout.byId.get(selectedId) ?? null : null

  // ------------------------------------------------------------- navigation

  const navigate = useCallback(
    (next: Page, focus?: string) => {
      setPage(next)
      setSelectedId(focus ?? null)
      setFocusId(focus ?? null)
      if (next.kind === 'changes') void actions.loadHistory()
    },
    [actions],
  )

  /** Open a seat in the tree it belongs to, unfolding whatever hides it. */
  const openInTree = useCallback(
    (id: string) => {
      const groupId = membership.get(id)
      const parents = new Map(nodes.map((n) => [n.id, n.position.parent_id]))
      setCollapsed((prev) => {
        if (prev.size === 0) return prev
        const next = new Set(prev)
        let cursor = parents.get(id) ?? null
        const seen = new Set<string>()
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor)
          next.delete(cursor)
          cursor = parents.get(cursor) ?? null
        }
        return next
      })
      navigate(groupId ? { kind: 'group', id: groupId, mode: 'tree' } : { kind: 'all', mode: 'tree' }, id)
    },
    [membership, nodes, navigate],
  )

  const findMe = viewerIds.size > 0 ? () => openInTree([...viewerIds][0]) : undefined

  const clearFocus = useCallback(() => setFocusId(null), [])

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ---------------------------------------------------------------- actions

  async function addSeat() {
    // A seat with no parent is a new root. Inside a group view the group's
    // members are the only visible nodes, so a new root lands outside the
    // filter and the click looks like it did nothing. Falling back to the
    // group's own root keeps the new seat where the admin is looking.
    const parent = selectedId ?? activeGroup?.root_position_id ?? null
    const id = await actions.addSeat(parent)
    if (id) {
      setSelectedId(id)
      setFocusId(id)
    }
  }

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
      actions.fail(e)
    } finally {
      setExporting(false)
    }
  }

  // ------------------------------------------------------------------ parts

  // Everything the shared employee card needs about the chart around a person.
  const personCtx: PersonContext = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const kids = new Map<string, ChartNode[]>()
    for (const n of nodes) {
      const p = n.position.parent_id
      if (!p || !byId.has(p)) continue
      const bucket = kids.get(p)
      if (bucket) bucket.push(n)
      else kids.set(p, [n])
    }
    for (const list of kids.values()) {
      list.sort(
        (a, b) => a.position.sort_order - b.position.sort_order || a.name.localeCompare(b.name),
      )
    }
    const groupById = new Map(groups.map((g) => [g.id, g]))
    return {
      byId,
      kids,
      accentOf: accentById,
      verticalOf: (id) => {
        const g = groupById.get(membership.get(id) ?? '')
        return g ? { id: g.id, name: g.name, accent: g.accent } : null
      },
      viewerIds,
    }
  }, [nodes, groups, membership, accentById, viewerIds])

  // Admins only. The same edit panel wherever the card was opened; the
  // database refuses anyone else's writes regardless.
  const renderEditor: PersonEditor | undefined = isAdmin
    ? ({ id, onClose, onSelect }) => {
        const node = personCtx.byId.get(id)
        if (!node) return null
        return (
          <EditPanel
            node={node}
            directory={props.directory}
            allNodes={nodes}
            forbiddenIds={descendantIds(id, nodes)}
            childCount={personCtx.kids.get(id)?.length ?? 0}
            group={groups.find((g) => g.root_position_id === id) ?? null}
            onSave={(patch) => actions.savePatch(id, patch)}
            onSaveGroup={(next) => actions.saveGroup(id, next)}
            // A new seat opens straight into its own editor: it is called
            // "New seat" and has nobody in it, so editing is the next step.
            onAddChild={() =>
              void actions.addSeat(id).then((newId) => newId && onSelect(newId, true))
            }
            onDelete={() => void actions.deleteSeat(id).then((gone) => gone && onSelect(null))}
            onClose={onClose}
          />
        )
      }
    : undefined

  /** The one employee card, as every screen shows it. */
  const personCard = (
    id: string,
    onSelect: (id: string | null) => void,
    opts: { inTree?: boolean } = {},
  ) => (
    <PersonCard
      id={id}
      ctx={personCtx}
      onSelect={onSelect}
      onShowInTree={opts.inTree ? undefined : openInTree}
      onShowMap={(g) => navigate({ kind: 'group', id: g, mode: 'map' })}
      renderEditor={renderEditor}
    />
  )

  /** Select a seat in the tree; one outside this tree opens its own. */
  const selectInTree = (id: string | null) => {
    if (!id) return setSelectedId(null)
    if (layout.byId.has(id)) {
      setSelectedId(id)
      setFocusId(id)
    } else openInTree(id)
  }

  // Beside a map, the card of whoever was clicked on it.
  const mapSide =
    selectedId && personCtx.byId.has(selectedId) ? personCard(selectedId, setSelectedId) : null

  const tree = (
    <TreeSection
      admin={isAdmin}
      panel={
        selected ? (
          <aside className="side-panel">{personCard(selected.id, selectInTree, { inTree: true })}</aside>
        ) : null
      }
    >
      <Chart
        layout={layout}
        isAdmin={isAdmin}
        selectedId={selectedId}
        matchedIds={matchedIds}
        searching={q.length > 0}
        collapsed={collapsed}
        forbiddenIds={forbiddenIds}
        viewerIds={viewerIds}
        orientation={orientation}
        accentOf={accentById}
        onSelect={setSelectedId}
        onToggleCollapse={toggleCollapse}
        onReparent={(child, parent) => void actions.reparent(child, parent)}
        onDragStateChange={setDraggingId}
        focusId={focusId}
        onFocusHandled={clearFocus}
      />
    </TreeSection>
  )

  const treeControls = (
    <>
      <div className="seg" role="group" aria-label="Tree direction">
        <button
          type="button"
          className="btn"
          aria-pressed={orientation === 'vertical'}
          onClick={() => setOrientation('vertical')}
        >
          Top-down
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={orientation === 'horizontal'}
          onClick={() => setOrientation('horizontal')}
          title="Fits far better at this headcount"
        >
          Left-to-right
        </button>
      </div>
      {findMe && (
        <button type="button" className="btn" onClick={findMe}>
          Find me
        </button>
      )}
      {isAdmin && (
        <button
          type="button"
          className="btn"
          onClick={() => void addSeat()}
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
  )

  // ----------------------------------------------------------------- screen

  let screen: React.ReactNode
  if (props.loading) {
    screen = <div className="boot">Loading the chart…</div>
  } else if (nodes.length === 0) {
    screen = <div className="boot">{props.empty}</div>
  } else if (page.kind === 'home') {
    screen = (
      <Overview
        circle={circle}
        verticalCount={groups.length}
        viewerIds={viewerIds}
        onOpenGroup={(id) => navigate({ kind: 'group', id, mode: 'map' })}
        onOpenAll={(mode) => navigate({ kind: 'all', mode })}
        renderPerson={(id, onSelect) => personCard(id, onSelect)}
      />
    )
  } else if (page.kind === 'changes') {
    screen = (
      <ChangesPage
        entries={props.history}
        loading={props.historyLoading}
        nameFor={(id) => (id ? nameById.get(id) ?? null : null)}
        undoing={props.undoing}
        onUndo={(entry) => void actions.undo(entry)}
        onRefresh={() => void actions.loadHistory()}
        lastSync={props.lastSync}
        syncing={props.syncing}
        onSync={() => void actions.sync()}
      />
    )
  } else if (page.kind === 'group' && activeGroup) {
    screen = (
      <VerticalPage
        key={activeGroup.id}
        group={activeGroup}
        members={visibleNodes}
        lead={nodes.find((n) => n.id === activeGroup.root_position_id) ?? null}
        mode={page.mode}
        onMode={(mode) => navigate({ kind: 'group', id: activeGroup.id, mode })}
        onOpen={setSelectedId}
        side={mapSide}
        accentOf={accentById}
        viewerIds={viewerIds}
        exporting={exporting}
        onExport={() => void exportPng()}
        treeControls={treeControls}
        tree={tree}
      />
    )
  } else if (page.kind === 'all') {
    screen = (
      <CompanyPage
        rows={[
          ...summaries.map((s) => ({
            key: s.group.id,
            name: s.group.name,
            accent: s.group.accent,
            members: s.members,
          })),
          ...(ungrouped.length
            ? [{ key: 'none', name: 'Not in a vertical', accent: '#6b7280', members: ungrouped }]
            : []),
        ]}
        total={nodes.length}
        verticalCount={groups.length}
        mode={page.mode}
        onMode={(mode) => navigate({ kind: 'all', mode })}
        onBack={() => navigate({ kind: 'home' })}
        onOpen={setSelectedId}
        side={mapSide}
        accentOf={accentById}
        viewerIds={viewerIds}
        treeControls={treeControls}
        tree={tree}
      />
    )
  }

  return (
    <div className="shell">
      <Sidebar
        page={page}
        verticals={summaries.map((s) => ({ group: s.group, count: s.members.length }))}
        isAdmin={isAdmin}
        email={props.email}
        query={query}
        onQuery={setQuery}
        results={searchResults}
        onPickResult={(id) => {
          setQuery('')
          openInTree(id)
        }}
        onNavigate={(p) => navigate(p)}
        syncing={props.syncing}
        exporting={exporting}
        onSync={() => void actions.sync()}
        onExport={() => void exportPng()}
        onSignOut={actions.signOut}
      />

      <main className="main">
        {props.error && (
          <div className="banner" role="alert">
            {props.error}
            <button type="button" className="btn sm" onClick={props.onDismissError}>
              Dismiss
            </button>
          </div>
        )}
        {props.notice && (
          <div className="banner is-notice" role="status">
            {props.notice}
            <button type="button" className="btn sm" onClick={props.onDismissNotice}>
              Dismiss
            </button>
          </div>
        )}
        {screen}
      </main>
    </div>
  )
}

// ======================================================================= tree

function TreeSection(props: { admin: boolean; panel: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="tree-wrap">
      <section className="card tree-card" aria-label="Reporting tree">
        <div className="tree-bar">
          <div className="hints">
            <span>
              <b>Scroll</b> to move around
            </span>
            <span>
              <b>Ctrl + scroll</b> to zoom
            </span>
            <span>
              <b>Drag</b> the background to pan
            </span>
            {props.admin && (
              <span>
                <b>Drag a box</b> onto another to change who it reports to
              </span>
            )}
          </div>
          <div className="legend">
            <span>
              <i className="sw" />
              From Ajera
            </span>
            <span>
              <i className="sw is-manual" />
              Added here
            </span>
            <span>
              <i className="sw is-vacant" />
              Vacant
            </span>
            <span>
              <i className="sw is-stale" />
              Not active in Ajera
            </span>
          </div>
        </div>
        {props.children}
      </section>
      {props.panel}
    </div>
  )
}

// =================================================================== vertical

function VerticalPage(props: {
  group: Group
  members: ChartNode[]
  lead: ChartNode | null
  mode: 'map' | 'tree'
  onMode: (mode: 'map' | 'tree') => void
  onOpen: (id: string) => void
  /** The employee card for whoever was clicked on the map, if anyone. */
  side: React.ReactNode
  accentOf: (id: string) => string | null
  viewerIds: Set<string>
  exporting: boolean
  onExport: () => void
  treeControls: React.ReactNode
  tree: React.ReactNode
}) {
  const { group, members, lead } = props

  // Test mode: a sandbox copy of this vertical's tree. Moves live in this
  // component's state and nowhere else — nothing is written to the database.
  const [testOn, setTestOn] = useState(false)
  const [testSel, setTestSel] = useState<string | null>(null)
  const [moves, setMoves] = useState<Map<string, string>>(new Map())

  const stats = useMemo(() => verticalStats(members), [members])
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])

  const forest: Forest = useMemo(() => {
    if (!testOn || moves.size === 0) return buildForest(members)
    return buildForest(
      members.map((m) => {
        const to = moves.get(m.id)
        return to ? { ...m, position: { ...m.position, parent_id: to } } : m
      }),
    )
  }, [members, moves, testOn])

  const nameOf = (id: string | null | undefined) => (id ? byId.get(id)?.name ?? 'someone' : 'the top')

  function moveHere(managerId: string) {
    if (!testSel) return
    setMoves((prev) => {
      const next = new Map(prev)
      if (byId.get(testSel)?.position.parent_id === managerId) next.delete(testSel)
      else next.set(testSel, managerId)
      return next
    })
  }

  // In the firm's own words where the circle has a name for the ring —
  // "2 account · 6 project" — and by level past that.
  const managerSummary = stats.managersByDepth
    .map(({ depth, count }) => {
      const ring = RING_NAMES[depth + 1]
      return ring?.endsWith(' managers')
        ? `${count} ${ring.replace(/ managers$/, '').toLowerCase()}`
        : `${count} at level ${depth + 1}`
    })
    .join(' · ')
  const attention = stats.stale + stats.vacant

  const heading = (
    <h1 className="h-dot">
      <i className="dot lg" style={{ background: group.accent }} />
      {group.name}
    </h1>
  )

  if (props.mode === 'tree') {
    return (
      <div className="page">
        <header className="page-head">
          <div className="page-title">
            <p className="eyebrow">
              <button type="button" className="crumb" onClick={() => props.onMode('map')}>
                {group.name}
              </button>{' '}
              · Reporting tree
            </p>
            {heading}
            <p className="lede">
              Who reports to whom. Click a seat to select it; use the + and − tabs to open or
              fold a team.
            </p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn" onClick={() => props.onMode('map')}>
              <IconBack />
              Back to map overview
            </button>
            {props.treeControls}
          </div>
        </header>
        {props.tree}
      </div>
    )
  }

  const changes = [...moves].map(([id, to]) => ({
    id,
    name: byId.get(id)?.vacant ? 'Vacant seat' : nameOf(id),
    from: nameOf(byId.get(id)?.position.parent_id),
    to: nameOf(to),
  }))

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <p className="eyebrow">Verticals · Map overview</p>
          {heading}
          <p className="lede">
            {lead
              ? `Everyone under ${lead.name}${lead.title ? `, ${lead.title}` : ''}, one level per column.`
              : 'Everyone in this vertical, one level per column.'}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className={testOn ? 'btn is-test' : 'btn'}
            aria-pressed={testOn}
            onClick={() => {
              setTestOn((v) => !v)
              setTestSel(null)
            }}
            title="Try out moves on a copy of this vertical. Nothing is saved."
          >
            <IconFlask />
            {testOn ? 'Exit test mode' : 'Test mode'}
          </button>
          <button type="button" className="btn" onClick={() => props.onMode('tree')}>
            Open reporting tree
          </button>
          <button type="button" className="btn" onClick={props.onExport} disabled={props.exporting}>
            {props.exporting ? 'Rendering…' : 'Export PNG'}
          </button>
        </div>
      </header>

      {testOn && (
        <section className="testbox" aria-label="Test mode">
          <div className="spread wrap">
            <div>
              <p className="strong">Test mode: you're working on a copy of this vertical</p>
              <p className="meta">
                Nothing here changes Ajera or the live chart. Click a person, then “Move here” on
                another manager's team.
              </p>
            </div>
            <div className="row-wrap">
              <button type="button" className="btn sm" onClick={() => setMoves(new Map())}>
                Reset copy
              </button>
              <button
                type="button"
                className="btn sm is-test"
                onClick={() => {
                  setTestOn(false)
                  setTestSel(null)
                }}
              >
                Exit test mode
              </button>
            </div>
          </div>
          <div>
            <p className="eyebrow">
              {changes.length
                ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} in this copy`
                : 'No changes yet'}
            </p>
            {changes.map((c) => (
              <div className="test-change" key={c.id}>
                <span className="strong">{c.name}</span>
                <span className="meta">
                  {c.from} → {c.to}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    setMoves((prev) => {
                      const next = new Map(prev)
                      next.delete(c.id)
                      return next
                    })
                  }
                >
                  Undo
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="stats">
        <Stat label="People" value={stats.people}>
          {stats.filled} filled · {stats.vacant} vacant {stats.vacant === 1 ? 'seat' : 'seats'}
        </Stat>
        <Stat label="Managers" value={stats.managers}>
          {managerSummary || 'Nobody below the lead has reports'}
        </Stat>
        <Stat
          label="Average # of direct reports"
          value={stats.teamLeads ? (stats.teamMembers / stats.teamLeads).toFixed(1) : '—'}
        >
          {stats.teamMembers} people across {stats.teamLeads}{' '}
          {stats.teamLeads === 1 ? 'team lead' : 'team leads'}
        </Stat>
        <Stat label="Needs attention" value={attention} warn={attention > 0}>
          {stats.stale} not active in Ajera · {stats.vacant} vacant
        </Stat>
      </div>

      <MapWithSide side={props.side}>
      <section className="card pad stack" aria-labelledby="map-h">
        <div className="spread wrap">
          <h2 id="map-h" className="h-md">
            Reporting map
          </h2>
          <p className="meta">Click anyone to see their card.</p>
        </div>
        <div className="hscroll">
          <ReportingMap
            forest={forest}
            accentOf={props.accentOf}
            viewerIds={props.viewerIds}
            onOpen={props.onOpen}
            test={
              testOn
                ? {
                    selectedId: testSel,
                    selectedName: byId.get(testSel ?? '')?.vacant
                      ? 'the vacant seat'
                      : (byId.get(testSel ?? '')?.name ?? '').split(/\s+/)[0],
                    moved: moves,
                    onPick: (id) => setTestSel((cur) => (cur === id ? null : id)),
                    onMoveHere: moveHere,
                  }
                : undefined
            }
          />
        </div>
      </section>
      </MapWithSide>
    </div>
  )
}

function Stat(props: {
  label: string
  value: React.ReactNode
  warn?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="card pad stat">
      <span className="eyebrow">{props.label}</span>
      <span className={props.warn ? 'stat-num is-warn' : 'stat-num'}>{props.value}</span>
      <span className="meta">{props.children}</span>
    </div>
  )
}

// ==================================================================== company

type CompanyRow = { key: string; name: string; accent: string; members: ChartNode[] }

function CompanyPage(props: {
  rows: CompanyRow[]
  total: number
  verticalCount: number
  mode: 'map' | 'tree'
  onMode: (mode: 'map' | 'tree') => void
  onBack: () => void
  onOpen: (id: string) => void
  side: React.ReactNode
  accentOf: (id: string) => string | null
  viewerIds: Set<string>
  treeControls: React.ReactNode
  tree: React.ReactNode
}) {
  const forests = useMemo(
    () => props.rows.map((r) => ({ row: r, forest: buildForest(r.members) })),
    [props.rows],
  )

  // Start with each vertical's lead open, so the page opens on leads and
  // their managers rather than on 77 people or on three lonely boxes.
  const defaultOpen = useMemo(
    () => new Set(forests.flatMap(({ forest }) => forest.roots.map((r) => r.id))),
    [forests],
  )
  const allManagers = useMemo(
    () => new Set(forests.flatMap(({ forest }) => [...forest.kids.keys()])),
    [forests],
  )
  const [open, setOpen] = useState<Set<string> | null>(null)
  const effectiveOpen = open ?? defaultOpen

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <p className="eyebrow">
            <button type="button" className="crumb" onClick={props.onBack}>
              Overview
            </button>{' '}
            · Full org chart
          </p>
          <h1>Full org chart</h1>
          <p className="lede">
            {props.total} people across {props.verticalCount}{' '}
            {props.verticalCount === 1 ? 'vertical' : 'verticals'}.{' '}
            {props.mode === 'map'
              ? 'Use + on any seat to open the level below it.'
              : 'The whole company as one reporting tree, coloured by vertical.'}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={props.onBack}>
            <IconBack />
            Back to overview
          </button>
          <div className="seg" role="group" aria-label="Layout">
            <button
              type="button"
              className="btn"
              aria-pressed={props.mode === 'map'}
              onClick={() => props.onMode('map')}
            >
              Map view
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={props.mode === 'tree'}
              onClick={() => props.onMode('tree')}
            >
              Tree view
            </button>
          </div>
          {props.mode === 'map' ? (
            <>
              <button type="button" className="btn" onClick={() => setOpen(new Set(allManagers))}>
                Expand all
              </button>
              <button type="button" className="btn" onClick={() => setOpen(new Set())}>
                Collapse all
              </button>
            </>
          ) : (
            props.treeControls
          )}
        </div>
      </header>

      {props.mode === 'tree' ? (
        props.tree
      ) : (
        <MapWithSide side={props.side}>
        <section className="card pad stack" aria-label="Company reporting map">
          {forests.map(({ row, forest }) => (
            <div className="vrow" key={row.key}>
              <span className="vlabel">
                <i className="dot" style={{ background: row.accent }} />
                {row.name} · {row.members.length}
              </span>
              <div className="hscroll">
                <ReportingMap
                  forest={forest}
                  accentOf={(id) => props.accentOf(id) ?? row.accent}
                  viewerIds={props.viewerIds}
                  onOpen={props.onOpen}
                  open={effectiveOpen}
                  onToggle={(id) =>
                    setOpen(() => {
                      const next = new Set(effectiveOpen)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })
                  }
                />
              </div>
            </div>
          ))}
        </section>
        </MapWithSide>
      )}
    </div>
  )
}

/** A map with the clicked person's card beside it; the map alone otherwise. */
function MapWithSide(props: { side: React.ReactNode; children: React.ReactNode }) {
  if (!props.side) return <>{props.children}</>
  return (
    <div className="split">
      {props.children}
      <div className="split-side side-sticky">{props.side}</div>
    </div>
  )
}
