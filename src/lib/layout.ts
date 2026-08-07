import { hierarchy, tree } from 'd3-hierarchy'
import type {
  ChartNode,
  Employee,
  Layout,
  Link,
  Orientation,
  PlacedNode,
  Position,
} from './types'
import { linkedInHref } from './linkedin'

export const NODE_W = 208
export const NODE_H = 104
/** The headshot sits above the card and overlaps it; NODE_H includes it. */
export const AVATAR_SIZE = 44

/** Top-down: siblings side by side, generations stacked. */
const V_SIBLING_GAP = 28
const V_DEPTH_GAP = 64

/** Left-to-right: siblings stacked, generations side by side.
 *  Siblings can sit much closer together this way — it's the whole reason
 *  this orientation fits a 76-person org on a screen at all. */
const H_SIBLING_GAP = 14
const H_DEPTH_GAP = 72

/** Sentinel parent for every top-level seat, so d3 has a single tree to lay out. */
const ROOT = '__root__'

/**
 * Join seats to people and resolve what each box should actually say.
 *
 * The override columns win when set. That's deliberate and it is the whole
 * reason they exist: Ajera stores one legal name and one title per person,
 * but the chart needs "Sam Murphy" rather than "Samuel Murphy", and needs a
 * person who holds five seats to show five different titles.
 */
export function joinNodes(
  positions: Position[],
  directory: Employee[],
  photoUrls: Map<string, string> = new Map(),
): ChartNode[] {
  const people = new Map(directory.map((e) => [e.employee_key, e]))

  return positions.map((position) => {
    const employee = position.employee_key ? people.get(position.employee_key) ?? null : null
    const title = position.show_title
      ? position.title_override ?? employee?.employee_title ?? null
      : null

    return {
      id: position.id,
      position,
      employee,
      name: position.name_override ?? employee?.full_name ?? 'Vacant',
      title,
      // A seat can point at an employee_key the directory no longer returns
      // (terminated, or filtered out of the mart). Both count as stale.
      stale: Boolean(position.employee_key) && employee?.employment_status !== 'Active',
      vacant: !position.employee_key,
      photoUrl: position.photo_path ? photoUrls.get(position.photo_path) ?? null : null,
      linkedinUrl: linkedInHref(position.linkedin_url),
    }
  })
}

/** Siblings sort by explicit sort_order, then alphabetically as a tiebreak. */
function compareSiblings(a: ChartNode, b: ChartNode): number {
  const bySort = a.position.sort_order - b.position.sort_order
  return bySort !== 0 ? bySort : a.name.localeCompare(b.name)
}

/**
 * An elbow connector: straight out of the parent, across, straight into the
 * child. Diagonal curves look softer but make it genuinely hard to trace who
 * reports to whom once a manager has more than about six reports.
 */
function elbow(
  px: number,
  py: number,
  cx: number,
  cy: number,
  orientation: Orientation,
): string {
  if (orientation === 'horizontal') {
    const midX = px + (cx - px) / 2
    return `M ${px} ${py} H ${midX} V ${cy} H ${cx}`
  }
  const midY = py + (cy - py) / 2
  return `M ${px} ${py} V ${midY} H ${cx} V ${cy}`
}

/**
 * Lay the chart out.
 *
 * `vertical` is the classic org chart: siblings side by side, generations
 * stacked downward. It reads well, and it is unusable past about twenty
 * people — width grows with headcount, so 76 seats is ~18,000px across.
 *
 * `horizontal` trades that off: depth becomes width (four or five columns,
 * regardless of headcount) and headcount becomes height, which a browser
 * scrolls naturally. Less familiar, far more legible at this size.
 *
 * `collapsed` holds seat ids whose subtrees are hidden — those nodes are still
 * placed, but nothing beneath them is.
 */
export function layoutChart(
  nodes: ChartNode[],
  collapsed: Set<string> = new Set(),
  orientation: Orientation = 'vertical',
): Layout {
  if (nodes.length === 0) {
    return { nodes: [], links: [], width: 0, height: 0, byId: new Map() }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const childrenOf = new Map<string, ChartNode[]>()

  for (const node of nodes) {
    // A parent_id pointing at a seat that no longer exists would strand the
    // node; treat it as top-level rather than dropping it off the chart.
    const parent = node.position.parent_id
    const key = parent && byId.has(parent) ? parent : ROOT
    const bucket = childrenOf.get(key)
    if (bucket) bucket.push(node)
    else childrenOf.set(key, [node])
  }
  for (const bucket of childrenOf.values()) bucket.sort(compareSiblings)

  type Datum = { id: string; node: ChartNode | null }

  const root = hierarchy<Datum>({ id: ROOT, node: null }, (d) => {
    if (d.id !== ROOT && collapsed.has(d.id)) return []
    return (childrenOf.get(d.id) ?? []).map((n) => ({ id: n.id, node: n }))
  })

  const horizontal = orientation === 'horizontal'

  // d3 lays out in its own space: `x` is the sibling axis, `y` is depth. We
  // decide which of those becomes screen-horizontal.
  const laidOut = tree<Datum>()
    .nodeSize(
      horizontal
        ? [NODE_H + H_SIBLING_GAP, NODE_W + H_DEPTH_GAP]
        : [NODE_W + V_SIBLING_GAP, NODE_H + V_DEPTH_GAP],
    )(root)

  const placed = laidOut.descendants().filter((d) => d.data.id !== ROOT)
  if (placed.length === 0) {
    return { nodes: [], links: [], width: 0, height: 0, byId: new Map() }
  }

  // d3's sibling-axis value is the CENTRE of the node; its depth value is the
  // leading edge. Convert both to a top-left corner in screen space.
  const corner = (d: { x: number; y: number }) =>
    horizontal
      ? { left: d.y, top: d.x - NODE_H / 2 }
      : { left: d.x - NODE_W / 2, top: d.y }

  const corners = new Map(placed.map((d) => [d.data.id, corner(d)]))

  // d3 centres the tree on 0 and starts the synthetic root at depth 0, so
  // both axes can be negative. Shift the whole thing to start at the origin.
  const lefts = [...corners.values()].map((c) => c.left)
  const tops = [...corners.values()].map((c) => c.top)
  const offsetX = -Math.min(...lefts)
  const offsetY = -Math.min(...tops)

  const at = (id: string) => {
    const c = corners.get(id) as { left: number; top: number }
    return { x: c.left + offsetX, y: c.top + offsetY }
  }

  const out: PlacedNode[] = placed.map((d) => {
    const node = d.data.node as ChartNode
    const { x, y } = at(d.data.id)
    return {
      ...node,
      x,
      y,
      depth: d.depth - 1,
      childCount: (childrenOf.get(node.id) ?? []).length,
      descendantCount: countDescendants(node.id, childrenOf),
    }
  })

  const links: Link[] = []
  for (const d of placed) {
    const parent = d.parent
    if (!parent || parent.data.id === ROOT) continue
    const p = at(parent.data.id)
    const c = at(d.data.id)
    links.push({
      id: `${parent.data.id}->${d.data.id}`,
      // Leave from the parent's trailing edge, arrive at the child's leading
      // edge, centred on the other axis.
      path: horizontal
        ? elbow(p.x + NODE_W, p.y + NODE_H / 2, c.x, c.y + NODE_H / 2, orientation)
        : elbow(p.x + NODE_W / 2, p.y + NODE_H, c.x + NODE_W / 2, c.y, orientation),
    })
  }

  return {
    nodes: out,
    links,
    width: Math.max(...out.map((n) => n.x)) + NODE_W,
    height: Math.max(...out.map((n) => n.y)) + NODE_H,
    byId: new Map(out.map((n) => [n.id, n])),
  }
}

function countDescendants(id: string, childrenOf: Map<string, ChartNode[]>): number {
  let total = 0
  const stack = [...(childrenOf.get(id) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop() as ChartNode
    total += 1
    stack.push(...(childrenOf.get(next.id) ?? []))
  }
  return total
}

/**
 * Every seat at or beneath `id`. Used to refuse a drag that would make a
 * manager report to one of their own reports — the database has a trigger
 * that refuses this too, but catching it here means the drop target just
 * doesn't light up, instead of the move failing with an error afterwards.
 */
export function descendantIds(id: string, nodes: ChartNode[]): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const n of nodes) {
    const parent = n.position.parent_id
    if (!parent) continue
    const bucket = childrenOf.get(parent)
    if (bucket) bucket.push(n.id)
    else childrenOf.set(parent, [n.id])
  }

  const found = new Set<string>([id])
  const stack = [id]
  while (stack.length > 0) {
    const next = stack.pop() as string
    for (const child of childrenOf.get(next) ?? []) {
      if (found.has(child)) continue
      found.add(child)
      stack.push(child)
    }
  }
  return found
}
