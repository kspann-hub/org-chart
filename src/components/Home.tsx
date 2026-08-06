import { useState } from 'react'
import type { ChartNode } from '../lib/types'
import type { CircleLayout } from '../lib/circle'
import type { GroupSummary } from '../lib/groups'
import { Avatar } from './Avatar'
import { CircleChart } from './CircleChart'

type Props = {
  circle: CircleLayout
  summaries: GroupSummary[]
  ungrouped: ChartNode[]
  totalSeats: number
  viewerIds: Set<string>
  onOpenGroup: (groupId: string) => void
  onOpenAll: () => void
}

/**
 * The landing page: the whole firm as one circle, with a way into each
 * vertical beside it.
 *
 * The circle answers "what does this place look like" — every seat at once,
 * no scrolling, verticals readable as shapes. The moment you want to know who
 * reports to whom, you open a vertical and get the tree, which is the shape
 * that question actually wants.
 */
export function Home(props: Props) {
  const { circle, summaries, ungrouped } = props
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showTeams, setShowTeams] = useState(true)
  const [showTeamNames, setShowTeamNames] = useState(true)

  const selected = selectedId ? circle.byId.get(selectedId) ?? null : null
  const hasGroups = summaries.length > 0

  return (
    <div className="home">
      <CircleChart
        layout={circle}
        selectedId={selectedId}
        viewerIds={props.viewerIds}
        showTeams={showTeams}
        showTeamNames={showTeamNames}
        onSelect={setSelectedId}
        onOpenWedge={props.onOpenGroup}
      />

      <aside className="home-rail">
        <div className="home-toggles">
          <button
            className="btn-quiet"
            aria-pressed={showTeams}
            onClick={() => setShowTeams((v) => !v)}
            title="Fold the outer rings away. Nobody moves — the wedges are fixed."
          >
            Teams: {showTeams ? 'shown' : 'folded'}
          </button>
          <button
            className="btn-quiet"
            aria-pressed={showTeamNames}
            onClick={() => setShowTeamNames((v) => !v)}
            disabled={!showTeams}
            title="Hide the outer ring's names when the circle gets busy"
          >
            Names: {showTeamNames ? 'everyone' : 'managers'}
          </button>
        </div>

        <section>
          <p className="rail-eyebrow">Selected</p>
          <div className="rail-readout">
            {selected ? (
              <>
                <Avatar node={selected} size={46} />
                <div className="rail-readout-body">
                  <h2>{selected.name}</h2>
                  {selected.title && <p className="rail-role">{selected.title}</p>}
                  <div className="rail-pills">
                    <span
                      className="rail-pill"
                      style={{ color: selected.accent, borderColor: `${selected.accent}66` }}
                    >
                      {circle.wedges.find((w) => w.key === selected.wedgeKey)?.name ?? 'No vertical'}
                    </span>
                    <span className="rail-pill">
                      {circle.rings.find((r) => r.ring === selected.ring)?.name}
                    </span>
                    {selected.childCount > 0 && (
                      <span className="rail-pill">
                        {selected.childCount} direct · {selected.descendantCount} below
                      </span>
                    )}
                    {props.viewerIds.has(selected.id) && (
                      <span className="rail-pill is-you">Your seat</span>
                    )}
                    {selected.stale && <span className="rail-pill is-stale">Not active in Ajera</span>}
                    {selected.vacant && <span className="rail-pill">Vacant</span>}
                  </div>
                </div>
              </>
            ) : (
              <p className="rail-hint">
                Hover anyone to trace their line back to their vertical lead. Click to keep it.
              </p>
            )}
          </div>
        </section>

        <section>
          <p className="rail-eyebrow">Verticals</p>
          {!hasGroups && (
            <p className="rail-hint">
              No groups yet. Open the full chart, select the seat that should lead a vertical,
              and tick <strong>Start a group here</strong> in the edit panel.
            </p>
          )}
          <div className="vertical-list">
            {summaries.map(({ group, root, members }) => (
              <button
                key={group.id}
                className="vertical-btn"
                style={{ borderLeftColor: group.accent }}
                onClick={() => props.onOpenGroup(group.id)}
              >
                {root && <Avatar node={root} size={34} />}
                <span className="vertical-btn-body">
                  <span className="vertical-name" style={{ color: group.accent }}>
                    {group.name}
                  </span>
                  <span className="vertical-meta">
                    {members.length} {members.length === 1 ? 'person' : 'people'}
                    {root && ` · ${root.name}`}
                  </span>
                </span>
                <span className="vertical-open" style={{ color: group.accent }}>
                  →
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="rail-eyebrow">Rings</p>
          <div className="ring-list">
            {circle.rings.map((ring) => (
              <div className="ring-row" key={ring.ring}>
                <i style={{ width: 6 + ring.ring * 2, height: 6 + ring.ring * 2 }} />
                <b>{ring.name}</b>
                <span>{ring.count}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="home-footer">
          <button className="btn-primary" onClick={props.onOpenAll}>
            Open the whole company ({props.totalSeats} seats)
          </button>
          {ungrouped.length > 0 && (
            <p className="rail-hint">
              {ungrouped.length} seat{ungrouped.length === 1 ? '' : 's'} belong to no vertical.
              They sit in their own wedge here, and in the full chart.
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}
