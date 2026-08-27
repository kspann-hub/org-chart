/**
 * A synthetic chart, for looking at the view code without Supabase.
 *
 * Reached at /?fixture — see main.tsx. It exists because the pan/zoom pane is
 * the kind of change you can only really judge by grabbing it, and the project
 * is behind an egress block until early September, so the real data cannot be
 * loaded to grab. Nothing here is imported by the app's own path.
 */
import { useState } from 'react'
import type { Employee, Group, Position } from '../lib/types'
import { joinNodes, layoutChart } from '../lib/layout'
import { layoutCircle } from '../lib/circle'
import { summariseGroups, ungroupedNodes } from '../lib/groups'
import { Chart } from '../components/Chart'
import { Home } from '../components/Home'

const VERTICALS = [
  { name: 'Buildings', accent: '#4f8cf7', teams: 5 },
  { name: 'Infrastructure', accent: '#5fbf8a', teams: 4 },
  { name: 'Water', accent: '#e3b341', teams: 4 },
]

/** A stand-in firm: three verticals, a lead each, managers, and their teams. */
function fixture() {
  const positions: Position[] = []
  const directory: Employee[] = []
  const groups: Group[] = []
  let n = 0

  const seat = (parent: string | null, name: string, title: string): string => {
    const id = `p${++n}`
    const key = `e${n}`
    positions.push({
      id,
      parent_id: parent,
      employee_key: key,
      name_override: null,
      title_override: null,
      show_title: true,
      sort_order: n,
      photo_path: null,
      linkedin_url: null,
      source: 'ajera',
      updated_at: '2026-08-01T00:00:00Z',
      updated_by: null,
    })
    directory.push({
      employee_key: key,
      full_name: name,
      employee_title: title,
      employment_status: 'Active',
      employee_email: null,
      employee_type_description: null,
      is_supervisor: null,
      supervisor_key: null,
    })
    return id
  }

  const president = seat(null, 'Dana Whitfield', 'President')

  VERTICALS.forEach((v, vi) => {
    const lead = seat(president, `${v.name} Lead ${vi + 1}`, `${v.name} Director`)
    groups.push({
      id: `g${vi + 1}`,
      root_position_id: lead,
      name: v.name,
      accent: v.accent,
      sort_order: vi,
    })
    for (let a = 0; a < 2; a++) {
      const am = seat(lead, `${v.name} Account ${a + 1}`, 'Account Manager')
      for (let m = 0; m < 2; m++) {
        const pm = seat(am, `${v.name} Project ${a + 1}.${m + 1}`, 'Project Manager')
        for (let t = 0; t < v.teams; t++) {
          seat(pm, `${v.name} Team ${a + 1}.${m + 1}.${t + 1}`, 'Engineer')
        }
      }
    }
  })

  return { nodes: joinNodes(positions, directory), groups }
}

const { nodes, groups } = fixture()

export function Fixture() {
  const [page, setPage] = useState<'home' | 'tree'>('home')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>('vertical')

  const circle = layoutCircle(nodes, groups)
  const layout = layoutChart(nodes, new Set(), orientation)
  const none = new Set<string>()

  return (
    <div className="app">
      <header className="topbar">
        <strong>Fixture</strong>
        <button className="btn-quiet" onClick={() => setPage('home')}>
          Circle
        </button>
        <button className="btn-quiet" onClick={() => setPage('tree')}>
          Tree
        </button>
        <button
          className="btn-quiet"
          onClick={() => setOrientation((o) => (o === 'vertical' ? 'horizontal' : 'vertical'))}
        >
          {orientation}
        </button>
        <span>{nodes.length} seats</span>
      </header>

      <div className="body">
        {page === 'home' ? (
          <Home
            circle={circle}
            summaries={summariseGroups(nodes, groups)}
            ungrouped={ungroupedNodes(nodes, groups)}
            totalSeats={nodes.length}
            viewerIds={none}
            onOpenGroup={() => setPage('tree')}
            onOpenAll={() => setPage('tree')}
          />
        ) : (
          <Chart
            layout={layout}
            isAdmin={false}
            selectedId={selectedId}
            matchedIds={none}
            searching={false}
            collapsed={none}
            forbiddenIds={none}
            viewerIds={none}
            orientation={orientation}
            accentOf={() => null}
            onSelect={setSelectedId}
            onToggleCollapse={() => {}}
            onReparent={() => {}}
            onDragStateChange={() => {}}
            focusId={null}
            onFocusHandled={() => {}}
          />
        )}
      </div>
    </div>
  )
}
