import type { ChartNode } from './types'

/**
 * Parent -> children for a subset of the chart, for the views that draw the
 * reporting line as nested markup (the map overviews) rather than as placed
 * boxes (layout.ts).
 *
 * A seat whose parent is outside the subset is a root of it. That is what makes
 * a vertical's lead the top of its own map even though they report to someone
 * in another vertical.
 */
export type Forest = {
  roots: ChartNode[]
  kids: Map<string, ChartNode[]>
}

function bySiblingOrder(a: ChartNode, b: ChartNode): number {
  const bySort = a.position.sort_order - b.position.sort_order
  return bySort !== 0 ? bySort : a.name.localeCompare(b.name)
}

export function buildForest(nodes: ChartNode[]): Forest {
  const ids = new Set(nodes.map((n) => n.id))
  const kids = new Map<string, ChartNode[]>()
  const roots: ChartNode[] = []

  for (const n of nodes) {
    const parent = n.position.parent_id
    if (parent && ids.has(parent) && parent !== n.id) {
      const bucket = kids.get(parent)
      if (bucket) bucket.push(n)
      else kids.set(parent, [n])
    } else {
      roots.push(n)
    }
  }

  for (const list of kids.values()) list.sort(bySiblingOrder)
  roots.sort(bySiblingOrder)
  return { roots, kids }
}

/** Every seat beneath `id` in the forest, at any depth. Cycle-safe. */
export function countBelow(id: string, kids: Map<string, ChartNode[]>): number {
  const seen = new Set<string>([id])
  const stack = [id]
  let count = 0
  while (stack.length) {
    for (const child of kids.get(stack.pop() as string) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      count++
      stack.push(child.id)
    }
  }
  return count
}

/** Depth of every seat from the forest's roots (roots are 0). */
export function depths(forest: Forest): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (n: ChartNode, d: number) => {
    if (out.has(n.id)) return
    out.set(n.id, d)
    for (const k of forest.kids.get(n.id) ?? []) walk(k, d + 1)
  }
  for (const r of forest.roots) walk(r, 0)
  return out
}

/** Every seat in the forest that has at least one report. */
export function managerIds(forest: Forest): string[] {
  return [...forest.kids.keys()]
}

export type VerticalStats = {
  people: number
  filled: number
  vacant: number
  /** Everyone with reports, not counting the vertical's lead. */
  managers: number
  /** Managers by their depth below the lead, shallowest first. */
  managersByDepth: Array<{ depth: number; count: number }>
  /** Managers whose reports are all individual contributors. */
  teamLeads: number
  teamMembers: number
  stale: number
}

export function verticalStats(members: ChartNode[]): VerticalStats {
  const forest = buildForest(members)
  const depth = depths(forest)
  const rootIds = new Set(forest.roots.map((r) => r.id))

  const byDepth = new Map<number, number>()
  let managers = 0
  let teamLeads = 0
  let teamMembers = 0

  for (const [id, children] of forest.kids) {
    if (rootIds.has(id)) continue
    managers++
    const d = depth.get(id) ?? 0
    byDepth.set(d, (byDepth.get(d) ?? 0) + 1)
    if (children.every((c) => !forest.kids.has(c.id))) {
      teamLeads++
      teamMembers += children.length
    }
  }

  const vacant = members.filter((m) => m.vacant).length
  return {
    people: members.length,
    filled: members.length - vacant,
    vacant,
    managers,
    managersByDepth: [...byDepth]
      .sort((a, b) => a[0] - b[0])
      .map(([d, count]) => ({ depth: d, count })),
    teamLeads,
    teamMembers,
    stale: members.filter((m) => m.stale).length,
  }
}
