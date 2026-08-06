import type { ChartNode, Group, Link } from './types'
import { assignGroups } from './groups'

/**
 * The circular layout — the landing page.
 *
 * The tree layouts in layout.ts answer "who reports to whom". This one answers
 * "what does the firm look like", which is a different question: every seat at
 * once, no scrolling, and the verticals readable as shapes rather than as
 * branches you have to trace.
 *
 * The structure is fixed rather than derived. Each vertical owns a wedge, its
 * lead sits on the leadership ring, and depth inside the vertical becomes
 * distance from the middle. Nothing is at the centre — the centre is the firm.
 * That is deliberate: the three verticals are peers here, and putting the
 * President in the middle would say the opposite.
 */

/** What each ring is called, in the firm's own words. Index = ring number. */
export const RING_NAMES = [
  'The firm',
  'Leadership',
  'Account managers',
  'Project managers',
  'Project teams',
]

/** Named rings get a hand-picked radius; anything deeper steps out evenly. */
const RING_RADIUS = [0, 150, 285, 390, 480]
const RING_STEP = 90

/** Photo discs, by ring. Past this the ring is dots — a face wouldn't read. */
const DISC_SIZE = [0, 34, 20, 13]
const DOT_SIZE = 5

const CENTER_R = 66
/** Degrees held open between one vertical's wedge and the next. */
const WEDGE_GAP = 10
/** The vertical band sits outside the outermost ring's labels. */
const BAND_INSET = 125
const BAND_THICKNESS = 12
const EDGE_PADDING = 45

/** Seats in no group at all. They still belong on a page called "everyone". */
const UNGROUPED = '__ungrouped__'
const UNGROUPED_ACCENT = '#6b7280'

export type CircleLabel = {
  x: number
  y: number
  rotate: number
  anchor: 'start' | 'middle' | 'end'
  /** chip: horizontal, for the leads. tangential: along the ring, for
   *  managers. radial: a spoke outward, for anyone with no reports. */
  mode: 'chip' | 'tangential' | 'radial'
}

export type CircleNode = ChartNode & {
  x: number
  y: number
  /** Degrees, normalised to (-180, 180]. -90 is the top of the circle. */
  angle: number
  ring: number
  /** Radius of the photo disc, or of the dot on the outer rings. */
  size: number
  hasDisc: boolean
  accent: string
  wedgeKey: string
  childCount: number
  descendantCount: number
  label: CircleLabel
}

export type CircleWedge = {
  key: string
  name: string
  accent: string
  /** Null for the catch-all wedge, which has no group to open. */
  groupId: string | null
  /** The seat on the leadership ring, when the wedge has a single root. */
  leadId: string | null
  from: number
  to: number
  mid: number
  count: number
}

export type CircleRing = {
  ring: number
  r: number
  name: string
  count: number
}

export type CircleLayout = {
  nodes: CircleNode[]
  links: Link[]
  wedges: CircleWedge[]
  rings: CircleRing[]
  byId: Map<string, CircleNode>
  /** Square viewBox, with the firm at (center, center). */
  size: number
  center: number
  centerRadius: number
  leadershipRadius: number
  bandInner: number
  bandOuter: number
}

const EMPTY: CircleLayout = {
  nodes: [],
  links: [],
  wedges: [],
  rings: [],
  byId: new Map(),
  size: 0,
  center: 0,
  centerRadius: CENTER_R,
  leadershipRadius: RING_RADIUS[1],
  bandInner: 0,
  bandOuter: 0,
}

const radiusOf = (ring: number) =>
  ring < RING_RADIUS.length
    ? RING_RADIUS[ring]
    : RING_RADIUS[RING_RADIUS.length - 1] + (ring - RING_RADIUS.length + 1) * RING_STEP

const rad = (deg: number) => (deg * Math.PI) / 180
const point = (cx: number, cy: number, r: number, deg: number): [number, number] => [
  cx + r * Math.cos(rad(deg)),
  cy + r * Math.sin(rad(deg)),
]

/** Into (-180, 180], so "is this on the left half" is a plain comparison. */
const normalise = (deg: number) => (((deg + 180) % 360) + 360) % 360 - 180

/**
 * Lay out the circle.
 *
 * `groups` are the verticals. A seat belonging to no group still gets drawn —
 * it lands in a catch-all wedge rather than vanishing, because a page that
 * claims to show everyone has to actually show everyone.
 */
export function layoutCircle(nodes: ChartNode[], groups: Group[]): CircleLayout {
  if (nodes.length === 0) return EMPTY

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const membership = assignGroups(nodes, groups)
  const wedgeKeyOf = (id: string) => membership.get(id) ?? UNGROUPED

  const childrenOf = new Map<string, string[]>()
  for (const node of [...nodes].sort(
    (a, b) => a.position.sort_order - b.position.sort_order || a.name.localeCompare(b.name),
  )) {
    const parent = node.position.parent_id
    if (!parent || !byId.has(parent)) continue
    const bucket = childrenOf.get(parent)
    if (bucket) bucket.push(node.id)
    else childrenOf.set(parent, [node.id])
  }

  // Descend only within a wedge. A group root's children can belong to another
  // group — Logan and Brian report to Justin in the data, but they lead their
  // own verticals, so Business Operations must stop at them.
  const childrenInWedge = (id: string, key: string) =>
    (childrenOf.get(id) ?? []).filter((c) => wedgeKeyOf(c) === key)

  // ------------------------------------------------------------ the wedges

  type Seed = { key: string; name: string; accent: string; groupId: string | null; roots: string[] }

  const seeds: Seed[] = []

  for (const group of [...groups].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  )) {
    if (!byId.has(group.root_position_id)) continue
    seeds.push({
      key: group.id,
      name: group.name,
      accent: group.accent,
      groupId: group.id,
      roots: [group.root_position_id],
    })
  }

  // The catch-all is a forest, not a tree: every ungrouped seat whose manager
  // is also ungrouped hangs off one that isn't, so the tops become leads.
  const loose = nodes.filter((n) => !membership.has(n.id))
  if (loose.length > 0) {
    seeds.push({
      key: UNGROUPED,
      name: groups.length > 0 ? 'Not in a vertical' : 'Everyone',
      accent: UNGROUPED_ACCENT,
      groupId: null,
      roots: loose
        .filter((n) => {
          const parent = n.position.parent_id
          return !parent || !byId.has(parent) || membership.has(parent)
        })
        .map((n) => n.id),
    })
  }

  if (seeds.length === 0) return EMPTY

  // ------------------------------------------------------------ the angles

  // Every seat with no reports takes one slice; a manager spans the slices of
  // everyone beneath them. So a wedge's width is its headcount, and a busy
  // vertical gets more of the circle than a small one.
  const countLeaves = (id: string, key: string): number => {
    const kids = childrenInWedge(id, key)
    return kids.length === 0 ? 1 : kids.reduce((s, c) => s + countLeaves(c, key), 0)
  }

  let totalLeaves = 0
  for (const seed of seeds) {
    totalLeaves += seed.roots.reduce((s, r) => s + countLeaves(r, seed.key), 0)
  }

  const slice = (360 - WEDGE_GAP * seeds.length) / totalLeaves

  const placed: {
    id: string
    ring: number
    angle: number
    wedgeKey: string
    accent: string
    parent: string | null
  }[] = []

  const wedges: CircleWedge[] = []
  let maxRing = 1

  // A gap sits centred on the top of the circle, which is where the ring names
  // go — the one place they can sit without landing on somebody.
  let cursor = -90 + WEDGE_GAP / 2

  for (const seed of seeds) {
    const from = cursor
    let count = 0

    const walk = (id: string, ring: number, parent: string | null) => {
      count += 1
      maxRing = Math.max(maxRing, ring)
      const kids = childrenInWedge(id, seed.key)

      let angle: number
      if (kids.length === 0) {
        angle = cursor + slice / 2
        cursor += slice
      } else {
        const started = cursor
        for (const child of kids) walk(child, ring + 1, id)
        angle = (started + cursor) / 2
      }

      placed.push({ id, ring, angle, wedgeKey: seed.key, accent: seed.accent, parent })
    }

    for (const root of seed.roots) walk(root, 1, null)

    const to = cursor
    wedges.push({
      key: seed.key,
      name: seed.name,
      accent: seed.accent,
      groupId: seed.groupId,
      leadId: seed.roots.length === 1 ? seed.roots[0] : null,
      from,
      to,
      mid: (from + to) / 2,
      count,
    })
    cursor += WEDGE_GAP
  }

  // ---------------------------------------------------------- the geometry

  const rMax = radiusOf(maxRing)
  const bandInner = rMax + BAND_INSET
  const bandOuter = bandInner + BAND_THICKNESS
  const center = bandOuter + EDGE_PADDING
  const size = center * 2

  const at = (r: number, deg: number) => point(center, center, r, deg)

  const countBelow = (id: string, key: string): number =>
    childrenInWedge(id, key).reduce((s, c) => s + 1 + countBelow(c, key), 0)

  const out: CircleNode[] = placed.map((p) => {
    const node = byId.get(p.id) as ChartNode
    const angle = normalise(p.angle)
    const r = radiusOf(p.ring)
    const [x, y] = at(r, angle)
    const hasDisc = p.ring < DISC_SIZE.length
    const nodeSize = hasDisc ? DISC_SIZE[p.ring] : DOT_SIZE
    const kids = childrenInWedge(p.id, p.wedgeKey)

    return {
      ...node,
      x,
      y,
      angle,
      ring: p.ring,
      size: nodeSize,
      hasDisc,
      accent: node.vacant ? UNGROUPED_ACCENT : p.accent,
      wedgeKey: p.wedgeKey,
      childCount: kids.length,
      descendantCount: countBelow(p.id, p.wedgeKey),
      label: labelFor(p.ring, angle, r, nodeSize, kids.length === 0, at),
    }
  })

  const positions = new Map(out.map((n) => [n.id, n]))

  const links: Link[] = []
  for (const p of placed) {
    if (!p.parent) continue
    const parent = positions.get(p.parent)
    const child = positions.get(p.id)
    if (!parent || !child) continue

    // Curved through polar space: out from the manager's ring, round to the
    // report's angle, in to their ring. Straight spokes would cross wedges
    // and lose which branch is which.
    const r0 = radiusOf(parent.ring)
    const r1 = radiusOf(child.ring)
    const rm = (r0 + r1) / 2
    const [c1x, c1y] = at(rm, parent.angle)
    const [c2x, c2y] = at(rm, child.angle)

    links.push({
      id: `${parent.id}->${child.id}`,
      path: `M ${parent.x.toFixed(1)} ${parent.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${child.x.toFixed(1)} ${child.y.toFixed(1)}`,
    })
  }

  const rings: CircleRing[] = []
  for (let ring = 1; ring <= maxRing; ring++) {
    rings.push({
      ring,
      r: radiusOf(ring),
      name: RING_NAMES[ring] ?? RING_NAMES[RING_NAMES.length - 1],
      count: out.filter((n) => n.ring === ring).length,
    })
  }

  return {
    nodes: out,
    links,
    wedges,
    rings,
    byId: positions,
    size,
    center,
    centerRadius: CENTER_R,
    leadershipRadius: RING_RADIUS[1],
    bandInner,
    bandOuter,
  }
}

/**
 * Where a name goes, and which way up.
 *
 * The placement itself says how far down the chart you are: leads read
 * horizontally, managers run along their own ring, and anyone with no reports
 * gets a spoke pointing outward into their own empty slice.
 */
function labelFor(
  ring: number,
  angle: number,
  r: number,
  size: number,
  isLeaf: boolean,
  at: (r: number, deg: number) => [number, number],
): CircleLabel {
  if (ring === 1) {
    const [x, y] = at(r + size + 22, angle)
    return { x, y, rotate: 0, anchor: 'middle', mode: 'chip' }
  }

  if (isLeaf) {
    const flip = angle > 90 || angle < -90
    const [x, y] = at(r + size + 6, angle)
    return { x, y, rotate: flip ? angle + 180 : angle, anchor: flip ? 'end' : 'start', mode: 'radial' }
  }

  // Upside down through the bottom half, so those get spun the other way.
  const flip = angle > 0 && angle < 180
  const [x, y] = at(r + size + 13, angle)
  return { x, y, rotate: angle + (flip ? -90 : 90), anchor: 'middle', mode: 'tangential' }
}

/** The arc path for one vertical's band, as a closed ring segment. */
export function bandPath(
  wedge: CircleWedge,
  center: number,
  inner: number,
  outer: number,
): string {
  const p = (r: number, deg: number) => point(center, center, r, deg)
  const [x1, y1] = p(inner, wedge.from)
  const [x2, y2] = p(inner, wedge.to)
  const [x3, y3] = p(outer, wedge.to)
  const [x4, y4] = p(outer, wedge.from)
  const large = wedge.to - wedge.from > 180 ? 1 : 0
  return (
    `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${inner} ${inner} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} ` +
    `L ${x3.toFixed(1)} ${y3.toFixed(1)} A ${outer} ${outer} 0 ${large} 0 ${x4.toFixed(1)} ${y4.toFixed(1)} Z`
  )
}

/** Where a vertical's name sits on its band, and which way up it reads. */
export function bandLabel(wedge: CircleWedge, center: number, inner: number, outer: number) {
  const mid = normalise(wedge.mid)
  const flip = mid > 0 && mid < 180
  const [x, y] = point(center, center, (inner + outer) / 2 + (flip ? -22 : 22), mid)
  return { x, y, rotate: mid + (flip ? -90 : 90) }
}

/** The dashed tie from the firm in the middle out to one vertical's lead. */
export function spokePath(wedge: CircleWedge, center: number, from: number, to: number) {
  const [x1, y1] = point(center, center, from, wedge.mid)
  const [x2, y2] = point(center, center, to, wedge.mid)
  return { x1, y1, x2, y2 }
}
