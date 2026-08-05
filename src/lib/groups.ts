import type { ChartNode, Group } from './types'

export type GroupSummary = {
  group: Group
  /** The seat the group hangs off. Null if that seat has since been deleted. */
  root: ChartNode | null
  members: ChartNode[]
}

/**
 * Work out which group each seat belongs to.
 *
 * The rule is *nearest group-root ancestor*, not "everything under the root".
 * That distinction is the whole design:
 *
 *   President            <- group root: Business Operations
 *   ├── Accounting Mgr        -> Business Operations
 *   ├── VP Operations    <- group root: Project Operations
 *   │   └── Ops Manager       -> Project Operations, NOT Business Operations
 *   └── VP Delivery      <- group root: Project Delivery
 *
 * A plain subtree rule would put all 76 people in the President's group.
 * Walking up to the *nearest* root instead makes the groups tile the org:
 * no overlaps, no gaps, and every seat lands in exactly one.
 *
 * Returns seat id -> group id. Seats above every group root are absent.
 */
export function assignGroups(nodes: ChartNode[], groups: Group[]): Map<string, string> {
  const groupByRoot = new Map(groups.map((g) => [g.root_position_id, g.id]))
  const parentOf = new Map(nodes.map((n) => [n.id, n.position.parent_id]))
  const resolved = new Map<string, string>()

  for (const node of nodes) {
    // Remember the seats walked past so one climb resolves the whole chain,
    // and so a parent_id cycle can't spin forever.
    const chain: string[] = []
    let cursor: string | null = node.id
    let found: string | undefined

    while (cursor) {
      const cached = resolved.get(cursor)
      if (cached) {
        found = cached
        break
      }
      const direct = groupByRoot.get(cursor)
      if (direct) {
        found = direct
        break
      }
      if (chain.includes(cursor)) break
      chain.push(cursor)
      cursor = parentOf.get(cursor) ?? null
    }

    if (!found) continue
    resolved.set(node.id, found)
    for (const id of chain) resolved.set(id, found)
  }

  return resolved
}

/** Group cards for the landing page, in display order. */
export function summariseGroups(nodes: ChartNode[], groups: Group[]): GroupSummary[] {
  const membership = assignGroups(nodes, groups)
  const byId = new Map(nodes.map((n) => [n.id, n]))

  return [...groups]
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((group) => {
      const root = byId.get(group.root_position_id) ?? null
      const members = nodes
        .filter((n) => membership.get(n.id) === group.id)
        // The group's lead first, then everyone else alphabetically.
        .sort((a, b) => {
          if (a.id === group.root_position_id) return -1
          if (b.id === group.root_position_id) return 1
          return a.name.localeCompare(b.name)
        })
      return { group, root, members }
    })
}

/** Seats that fall outside every group — shown as a catch-all card. */
export function ungroupedNodes(nodes: ChartNode[], groups: Group[]): ChartNode[] {
  const membership = assignGroups(nodes, groups)
  return nodes.filter((n) => !membership.has(n.id))
}
