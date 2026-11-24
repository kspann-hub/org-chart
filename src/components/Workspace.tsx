import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ChartNode,
  Employee,
  Group,
  HistoryEntry,
  MapHours,
  MapProject,
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
  /** Fetch the CriticalArc map's projects and hours (10_map.sql's views). */
  loadMap: () => Promise<void>
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
  map: { projects: MapProject[]; hours: MapHours[] } | null
  mapLoading: boolean
  mapError: string | null
  actions: WorkspaceActions
}

const SEARCH_LIMIT = 8

// The map brings the US outline and the Census list of places with it — about
// 400 KB — so it loads only when someone opens that tab.
const CAMap = lazy(() => import('./CAMap').then((m) => ({ default: m.CAMap })))

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

  const onMapTab = page.kind === 'all' && page.mode === 'places'
  const { map, mapLoading, mapError } = props
  useEffect(() => {
    if (onMapTab && !map && !mapLoading && !mapError) void actions.loadMap()
  }, [onMapTab, map, mapLoading, mapError, actions])

  // Opening a vertical charts only its members. The group's root loses its
  // parent from the visible set and becomes the top of the chart, which is
  // exactly what you want when you drill into a branch.
  const visibleNodes = useMemo(
    () => (activeGroup ? nodes.filter((n) => membership.get(n.id) === activeGroup.id) : nodes),
    [nodes, membership, activeGroup],
  )

  // The whole-company tree draws each vertical as its own tree, the way the
  // map view does. Drawn literally, every lead hangs under whoever they report
  // to (Brian and Logan under Justin), and the verticals vanish into one
  // pyramid. Only the drawing changes: the real reporting line is untouched,
  // and the card still says who each lead reports to.
  const treeNodes = useMemo(() => {
    if (activeGroup) return visibleNodes
    const order = new Map(summaries.map((s, i) => [s.group.id, i]))
    return nodes.map((n) => {
      const parent = n.position.parent_id
      if (!parent || membership.get(parent) === membership.get(n.id)) return n
      // Lead of a vertical: start a tree of its own, in the verticals' order.
      const g = membership.get(n.id)
      const sort_order = g ? order.get(g) ?? 999 : 999
      return { ...n, position: { ...n.position, parent_id: null, sort_order } }
    })
  }, [activeGroup, visibleNodes, nodes, membership, summaries])

  const layout = useMemo(
    () => layoutChart(treeNodes, collapsed, orientation),
    [treeNodes, collapsed, orientation],
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

  /**
   * Open a seat on the map view of its vertical, selected, so its card shows
   * and the map scrolls to it and makes it pulse. What search lands on.
   */
  const openInMap = useCallback(
    (id: string) => {
      const groupId = membership.get(id)
      navigate(groupId ? { kind: 'group', id: groupId, mode: 'map' } : { kind: 'all', mode: 'map' }, id)
    },
    [membership, navigate],
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
    opts: { inTree?: boolean; extra?: (shownId: string) => React.ReactNode } = {},
  ) => (
    <PersonCard
      id={id}
      ctx={personCtx}
      onSelect={onSelect}
      onShowInTree={opts.inTree ? undefined : openInTree}
      onShowMap={(g) => navigate({ kind: 'group', id: g, mode: 'map' })}
      renderEditor={renderEditor}
      extra={opts.extra}
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
        onReparent={(child, parent) => {
          // A vertical's lead is drawn without its real manager (see
          // treeNodes), so a drop back onto that manager would change nothing.
          if (nodes.find((n) => n.id === child)?.position.parent_id === parent) return
          void actions.reparent(child, parent)
        }}
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
        selectedId={selectedId}
        focusId={focusId}
        onFocusHandled={clearFocus}
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
        selectedId={selectedId}
        focusId={focusId}
        onFocusHandled={clearFocus}
        accentOf={accentById}
        viewerIds={viewerIds}
        treeControls={treeControls}
        tree={tree}
        places={
          <Suspense fallback={<div className="boot">Loading the map…</div>}>
            <CAMap
              nodes={nodes}
              projects={map?.projects ?? null}
              hours={map?.hours ?? null}
              loading={mapLoading || (!map && !mapError)}
              error={mapError}
              personCard={(id, onSelect, extra) => personCard(id, onSelect, { extra })}
            />
          </Suspense>
        }
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
          openInMap(id)
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
  selectedId: string | null
  /** Set when the map should scroll to a seat (search); cleared once it has. */
  focusId: string | null
  onFocusHandled: () => void
  accentOf: (id: string) => string | null
  viewerIds: Set<string>
  exporting: boolean
  onExport: () => void
  treeControls: React.ReactNode
  tree: React.ReactNode
}) {
  const { group, members, lead } = props

  // Test mode: a sandbox copy of this vertical's tree. Moves, added roles and
  // removals live in this component's state and nowhere else — nothing is
  // written to the database.
  const [testOn, setTestOn] = useState(false)
  const [testSel, setTestSel] = useState<string | null>(null)
  /** Seat id -> the manager it now reports to in the copy. */
  const [moves, setMoves] = useState<Map<string, string>>(new Map())
  /** Roles that exist only in the copy. Their parent_id is where they were added. */
  const [added, setAdded] = useState<ChartNode[]>([])
  /** Real seats taken out of the copy; their reports move up a level. */
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')

  const byId = useMemo(
    () => new Map([...members, ...added].map((m) => [m.id, m])),
    [members, added],
  )

  // The copy as a flat list: moves applied, removed seats gone, and anyone
  // who reported to a removed seat reporting to that seat's manager instead.
  const sandbox: ChartNode[] = useMemo(() => {
    if (!testOn) return members
    const all = [...members, ...added].map((m) => {
      const to = moves.get(m.id)
      return to ? { ...m, position: { ...m.position, parent_id: to } } : m
    })
    const raw = new Map(all.map((n) => [n.id, n.position.parent_id]))
    const resolve = (p: string | null) => {
      const seen = new Set<string>()
      while (p && removed.has(p) && !seen.has(p)) {
        seen.add(p)
        p = raw.get(p) ?? null
      }
      return p
    }
    return all
      .filter((n) => !removed.has(n.id))
      .map((n) => {
        const r = resolve(n.position.parent_id)
        return r === n.position.parent_id ? n : { ...n, position: { ...n.position, parent_id: r } }
      })
  }, [members, added, moves, removed, testOn])

  const parentOf = useMemo(
    () => new Map(sandbox.map((n) => [n.id, n.position.parent_id])),
    [sandbox],
  )
  const stats = useMemo(() => verticalStats(sandbox), [sandbox])
  const forest: Forest = useMemo(() => buildForest(sandbox), [sandbox])

  const labelOf = (id: string | null | undefined) => {
    if (!id) return 'the top'
    const n = byId.get(id)
    if (!n) return 'someone'
    return n.vacant ? (n.title ? `${n.title} (vacant)` : 'Vacant seat') : n.name
  }

  /** May `seat` report to `manager` without making a loop or changing nothing? */
  function canMove(seat: string | null, manager: string) {
    if (!seat || seat === manager || parentOf.get(seat) === manager) return false
    const seen = new Set<string>()
    for (let p: string | null | undefined = manager; p && !seen.has(p); p = parentOf.get(p)) {
      if (p === seat) return false // can't report to someone below yourself
      seen.add(p)
    }
    return true
  }

  function moveTo(seat: string, manager: string) {
    if (!canMove(seat, manager)) return
    setMoves((prev) => {
      const next = new Map(prev)
      if (byId.get(seat)?.position.parent_id === manager) next.delete(seat)
      else next.set(seat, manager)
      return next
    })
  }

  function addRole() {
    const title = newTitle.trim() || 'New role'
    const parent = testSel ?? forest.roots[0]?.id ?? null
    const id = `test-${crypto.randomUUID()}`
    const node: ChartNode = {
      id,
      position: {
        id,
        parent_id: parent,
        employee_key: null,
        name_override: null,
        title_override: title,
        show_title: true,
        sort_order: 9999,
        photo_path: null,
        linkedin_url: null,
        home_base: null,
        source: 'manual',
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
      employee: null,
      name: 'Vacant',
      title,
      stale: false,
      vacant: true,
      manual: true,
      photoUrl: null,
      linkedinUrl: null,
    }
    setAdded((prev) => [...prev, node])
    setNewTitle('')
  }

  function removeSeat(id: string) {
    if (added.some((a) => a.id === id)) {
      // A role that only exists in the copy: hand its reports to its manager,
      // then forget it entirely.
      const up = parentOf.get(id) ?? null
      setMoves((prev) => {
        const next = new Map(prev)
        next.delete(id)
        for (const n of sandbox) {
          if (n.position.parent_id !== id) continue
          if (!up || byId.get(n.id)?.position.parent_id === up) next.delete(n.id)
          else next.set(n.id, up)
        }
        return next
      })
      setAdded((prev) => prev.filter((a) => a.id !== id))
    } else {
      setRemoved((prev) => new Set(prev).add(id))
    }
    if (testSel === id) setTestSel(null)
  }

  function resetCopy() {
    setMoves(new Map())
    setAdded([])
    setRemoved(new Set())
    setTestSel(null)
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

  const addedIds = new Set(added.map((a) => a.id))
  const changes: { id: string; name: string; detail: string; undo: () => void }[] = [
    ...added.map((a) => ({
      id: a.id,
      name: `${a.title ?? 'New role'} (new)`,
      detail: `added under ${labelOf(parentOf.get(a.id))}`,
      undo: () => removeSeat(a.id),
    })),
    ...[...removed].map((id) => ({
      id,
      name: labelOf(id),
      detail: 'removed · their reports move up a level',
      undo: () =>
        setRemoved((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        }),
    })),
    ...[...moves]
      .filter(([id]) => !addedIds.has(id) && !removed.has(id))
      .map(([id]) => ({
        id,
        name: labelOf(id),
        // Where they end up, which differs from the drop target if that seat
        // was removed afterwards.
        detail: `${labelOf(byId.get(id)?.position.parent_id)} → ${labelOf(parentOf.get(id))}`,
        undo: () =>
          setMoves((prev) => {
            const next = new Map(prev)
            next.delete(id)
            return next
          }),
      })),
  ]
  const changed = new Set([...moves.keys(), ...addedIds])
  const addUnder = testSel ?? forest.roots[0]?.id ?? null

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
                Nothing here changes Ajera or the live chart. Drag anyone onto a person or a
                team to change who they report to. Click someone to select them, then add a role
                under them or remove them.
              </p>
            </div>
            <div className="row-wrap">
              <button type="button" className="btn sm" onClick={resetCopy}>
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
                <span className="meta">{c.detail}</span>
                <button type="button" className="btn sm" onClick={c.undo}>
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
          {testOn ? (
            <div className="row-wrap test-tools">
              <input
                className="test-input"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addUnder) addRole()
                }}
                placeholder="New role title"
                aria-label="New role title"
              />
              <button
                type="button"
                className="btn sm is-test"
                onClick={addRole}
                disabled={!addUnder}
              >
                Add role under {labelOf(addUnder)}
              </button>
              {testSel && (
                <>
                  <button type="button" className="btn sm" onClick={() => removeSeat(testSel)}>
                    Remove {labelOf(testSel)}
                  </button>
                  <button type="button" className="btn sm" onClick={() => setTestSel(null)}>
                    Deselect
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="meta">Click anyone to see their card.</p>
          )}
        </div>
        <div className="hscroll">
          <ReportingMap
            forest={forest}
            accentOf={props.accentOf}
            viewerIds={props.viewerIds}
            onOpen={props.onOpen}
            selectedId={testOn ? null : props.selectedId}
            focusId={props.focusId}
            onFocusHandled={props.onFocusHandled}
            test={
              testOn
                ? {
                    selectedId: testSel,
                    dragId,
                    overKey,
                    changed,
                    onPick: (id) => setTestSel((cur) => (cur === id ? null : id)),
                    onDragStart: (id) => setDragId(id),
                    onDragEnd: () => {
                      setDragId(null)
                      setOverKey(null)
                    },
                    onOver: setOverKey,
                    canDrop: (managerId) => canMove(dragId, managerId),
                    onDrop: (managerId) => {
                      if (dragId) moveTo(dragId, managerId)
                      setDragId(null)
                      setOverKey(null)
                    },
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
  mode: 'map' | 'tree' | 'places'
  onMode: (mode: 'map' | 'tree' | 'places') => void
  onBack: () => void
  onOpen: (id: string) => void
  side: React.ReactNode
  selectedId: string | null
  focusId: string | null
  onFocusHandled: () => void
  accentOf: (id: string) => string | null
  viewerIds: Set<string>
  treeControls: React.ReactNode
  tree: React.ReactNode
  /** The CriticalArc map, the page's third view. */
  places: React.ReactNode
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

  // A seat searched for may be folded away inside its vertical's map. Open
  // every manager above it so the map has something to scroll to.
  const { focusId } = props
  useEffect(() => {
    if (!focusId || props.mode !== 'map') return
    const parentOf = new Map<string, string>()
    for (const { forest } of forests) {
      for (const [manager, kids] of forest.kids) for (const k of kids) parentOf.set(k.id, manager)
    }
    const above: string[] = []
    for (let p = parentOf.get(focusId); p && !above.includes(p); p = parentOf.get(p)) above.push(p)
    if (above.every((id) => effectiveOpen.has(id))) return
    setOpen(new Set([...effectiveOpen, ...above]))
  }, [focusId, props.mode, forests, effectiveOpen])

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <p className="eyebrow">
            <button type="button" className="crumb" onClick={props.onBack}>
              Overview
            </button>{' '}
            · {props.mode === 'places' ? 'CriticalArc map' : 'Full org chart'}
          </p>
          <h1>{props.mode === 'places' ? 'CriticalArc map' : 'Full org chart'}</h1>
          <p className="lede">
            {props.total} people across {props.verticalCount}{' '}
            {props.verticalCount === 1 ? 'vertical' : 'verticals'}.{' '}
            {props.mode === 'map'
              ? 'Use + on any seat to open the level below it.'
              : props.mode === 'tree'
                ? 'Each vertical as its own reporting tree, starting from its lead.'
                : "Everyone at their home base, and the projects they're charging time to."}
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
            <button
              type="button"
              className="btn"
              aria-pressed={props.mode === 'places'}
              onClick={() => props.onMode('places')}
            >
              CriticalArc map
            </button>
          </div>
          {props.mode === 'places' ? null : props.mode === 'map' ? (
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

      {props.mode === 'places' ? (
        props.places
      ) : props.mode === 'tree' ? (
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
                  selectedId={props.selectedId}
                  focusId={props.focusId}
                  onFocusHandled={props.onFocusHandled}
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
