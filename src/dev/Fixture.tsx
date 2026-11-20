/**
 * A synthetic chart, for looking at the screens without Supabase.
 *
 * Reached at /?fixture — see main.tsx. It draws the real Workspace, the same
 * component the signed-in app renders, from a made-up firm, with writes that
 * only change local state. Nothing here is imported by the app's own path.
 */
import { useMemo, useState } from 'react'
import type { Employee, Group, HistoryEntry, Position } from '../lib/types'
import { joinNodes } from '../lib/layout'
import { Workspace, type WorkspaceActions } from '../components/Workspace'

const VERTICALS = [
  { name: 'Project Delivery', short: 'Delivery', accent: '#3b82f6', teams: 5 },
  { name: 'Project Operations', short: 'Operations', accent: '#4ade80', teams: 4 },
  { name: 'Business Operations', short: 'Business', accent: '#fbbf24', teams: 3 },
]

const VIEWER = 'viewer@example.com'

/** A stand-in firm: three verticals, a lead each, managers, and their teams. */
function fixture() {
  const positions: Position[] = []
  const directory: Employee[] = []
  const groups: Group[] = []
  let n = 0

  const seat = (
    parent: string | null,
    name: string | null,
    title: string,
    extra: { stale?: boolean; manual?: boolean; email?: string } = {},
  ): string => {
    const id = `p${++n}`
    const key = name ? `e${n}` : null
    positions.push({
      id,
      parent_id: parent,
      employee_key: key,
      name_override: null,
      title_override: name ? null : title,
      show_title: true,
      sort_order: n,
      photo_path: null,
      linkedin_url: null,
      source: extra.manual ? 'manual' : 'ajera',
      updated_at: '2026-08-01T00:00:00Z',
      updated_by: null,
    })
    if (key && name) {
      directory.push({
        employee_key: key,
        full_name: name,
        employee_title: title,
        employment_status: extra.stale ? 'Terminated' : 'Active',
        employee_email: extra.email ?? null,
        employee_type_description: null,
        is_supervisor: null,
        supervisor_key: null,
      })
    }
    return id
  }

  const president = seat(null, 'Dana Whitfield', 'President')

  VERTICALS.forEach((v, vi) => {
    const lead = seat(president, `${v.short} Lead`, `Director, ${v.name}`)
    groups.push({
      id: `g${vi + 1}`,
      root_position_id: lead,
      name: v.name,
      accent: v.accent,
      sort_order: vi,
    })
    for (let a = 0; a < 2; a++) {
      const am = seat(lead, `${v.short} Account ${a + 1}`, 'Account Manager')
      for (let m = 0; m < 2; m++) {
        const pm = seat(am, `${v.short} PM ${a + 1}.${m + 1}`, 'Project Manager', {
          manual: vi === 0 && a === 1 && m === 1,
        })
        for (let t = 0; t < v.teams; t++) {
          const special = vi === 0 && a === 0 && m === 0
          if (special && t === 3) seat(pm, null, 'Open: Cx Engineer')
          else
            seat(pm, `${v.short} Eng ${a + 1}.${m + 1}.${t + 1}`, 'Cx Engineer', {
              stale: special && t === 2,
              email: special && t === 0 ? VIEWER : undefined,
            })
        }
      }
    }
  })

  return { positions, directory, groups }
}

const data = fixture()

const now = Date.now()
const HISTORY: HistoryEntry[] = [
  {
    id: 'h1',
    position_id: 'p8',
    action: 'update',
    before_row: { parent_id: 'p4' },
    after_row: { parent_id: 'p10' },
    label: 'Delivery Eng 1.1.1',
    changed_at: new Date(now - 12 * 60_000).toISOString(),
    changed_by: 'admin@example.com',
    undone_at: null,
    undone_by: null,
  },
  {
    id: 'h2',
    position_id: 'p5',
    action: 'update',
    before_row: { title_override: null },
    after_row: { title_override: 'Senior PM' },
    label: 'Delivery PM 1.1',
    changed_at: new Date(now - 40 * 60_000).toISOString(),
    changed_by: 'admin@example.com',
    undone_at: null,
    undone_by: null,
  },
  {
    id: 'h3',
    position_id: 'p20',
    action: 'insert',
    before_row: null,
    after_row: { source: 'ajera' },
    label: 'Delivery Eng 2.2.4',
    changed_at: new Date(now - 26 * 3_600_000).toISOString(),
    changed_by: 'admin@example.com',
    undone_at: null,
    undone_by: null,
  },
  {
    id: 'h4',
    position_id: 'p99',
    action: 'delete',
    before_row: {},
    after_row: null,
    label: 'Someone Gone',
    changed_at: new Date(now - 30 * 3_600_000).toISOString(),
    changed_by: 'admin@example.com',
    undone_at: new Date(now - 29 * 3_600_000).toISOString(),
    undone_by: 'other@example.com',
  },
  {
    id: 'h5',
    position_id: 'p21',
    action: 'insert',
    before_row: null,
    after_row: { source: 'manual' },
    label: 'New seat',
    changed_at: new Date(now - 2 * 3_600_000).toISOString(),
    changed_by: 'admin@example.com',
    undone_at: null,
    undone_by: null,
  },
]

export function Fixture() {
  const [positions, setPositions] = useState(data.positions)
  const admin = new URLSearchParams(location.search).get('fixture') !== 'viewer'

  const nodes = useMemo(() => joinNodes(positions, data.directory), [positions])

  const actions: WorkspaceActions = {
    reparent: async (child, parent) =>
      setPositions((ps) => ps.map((p) => (p.id === child ? { ...p, parent_id: parent } : p))),
    savePatch: async (id, patch) =>
      setPositions((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p))),
    saveGroup: async () => {},
    addSeat: async () => null,
    deleteSeat: async () => false,
    sync: async () => {},
    loadHistory: async () => {},
    undo: async () => {},
    signOut: () => {},
    fail: (e) => console.error(e),
  }

  return (
    <Workspace
      nodes={nodes}
      directory={data.directory}
      groups={data.groups}
      isAdmin={admin}
      email={VIEWER}
      loading={false}
      empty="No seats."
      error={null}
      notice={null}
      onDismissError={() => {}}
      onDismissNotice={() => {}}
      history={HISTORY}
      historyLoading={false}
      undoing={null}
      syncing={false}
      lastSync={null}
      actions={actions}
    />
  )
}
