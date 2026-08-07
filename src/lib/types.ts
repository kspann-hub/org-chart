/** One seat (box) on the chart. Owned by this app; admins edit these. */
export type Position = {
  id: string
  parent_id: string | null
  employee_key: string | null
  name_override: string | null
  title_override: string | null
  show_title: boolean
  sort_order: number
  /** Object path inside the private `headshots` bucket. Null = use initials. */
  photo_path: string | null
  /** Full profile URL, e.g. https://www.linkedin.com/in/jane-doe. Null = no badge. */
  linkedin_url: string | null
  updated_at: string
  updated_by: string | null
}

/** A vertical on the landing page, defined by the seat at its root. */
export type Group = {
  id: string
  root_position_id: string
  name: string
  accent: string
  sort_order: number
}

/** One person from Ajera, via the public.employee_directory view. Read-only. */
export type Employee = {
  employee_key: string
  full_name: string
  employee_title: string | null
  employment_status: string | null
  employee_email: string | null
  employee_type_description: string | null
  is_supervisor: boolean | null
  /** Ajera's own reporting line. Used to seed the chart, not to draw it — the
   *  chart's shape lives in org_positions.parent_id once it's built. */
  supervisor_key: string | null
}

/** One logged edit to a seat, from public.org_position_history. Admin-only. */
export type HistoryEntry = {
  id: string
  position_id: string
  action: 'insert' | 'update' | 'delete'
  before_row: Record<string, unknown> | null
  after_row: Record<string, unknown> | null
  /** The seat's name at the time, cached so the log survives its deletion. */
  label: string | null
  changed_at: string
  changed_by: string | null
  undone_at: string | null
  undone_by: string | null
}

/** What org_sync_ajera() reports back. Add-only: nothing is ever deleted. */
export type SyncResult = {
  added: number
  parented: number
  departed: number
  total: number
}

/** Which way the tree grows. See layoutChart() for why both exist. */
export type Orientation = 'vertical' | 'horizontal'

/** A seat joined to its person, with display values already resolved. */
export type ChartNode = {
  id: string
  position: Position
  employee: Employee | null
  name: string
  title: string | null
  /** True when the seat points at someone Ajera no longer lists as Active. */
  stale: boolean
  /** True when the seat has no person attached at all. */
  vacant: boolean
  /** Signed URL for the headshot, resolved separately and injected. */
  photoUrl: string | null
  /** Vetted profile link, or null. Drives the LinkedIn badge on the chart. */
  linkedinUrl: string | null
}

/** A laid-out node: a ChartNode plus where to draw it. */
export type PlacedNode = ChartNode & {
  x: number
  y: number
  depth: number
  childCount: number
  /** Every seat beneath this one, at any depth. */
  descendantCount: number
}

export type Link = {
  id: string
  path: string
}

export type Layout = {
  nodes: PlacedNode[]
  links: Link[]
  width: number
  height: number
  byId: Map<string, PlacedNode>
}
