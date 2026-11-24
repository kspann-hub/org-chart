import { useState } from 'react'
import type { CircleLayout } from '../lib/circle'
import { CircleChart } from './CircleChart'
import { IconChevronDown, IconInfo, IconOrgChart } from './Icons'

type Props = {
  circle: CircleLayout
  verticalCount: number
  viewerIds: Set<string>
  onOpenAll: (mode: 'map') => void
  onOpenGroup: (groupId: string) => void
  /** The shared employee card for a seat; the same one every screen shows. */
  renderPerson: (id: string, onSelect: (id: string | null) => void) => React.ReactNode
}

/**
 * The landing page: the whole firm as one circle, and beside it the card of
 * whoever you clicked.
 */
export function Overview(props: Props) {
  const { circle } = props
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showTeams, setShowTeams] = useState(true)
  const [showTeamNames, setShowTeamNames] = useState(true)

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <p className="eyebrow">Company</p>
          <h1>Overview</h1>
          <p className="lede">
            {circle.nodes.length} people across {props.verticalCount}{' '}
            {props.verticalCount === 1 ? 'vertical' : 'verticals'}. Hover anyone to trace their
            line back to their vertical lead; click to keep it.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            aria-pressed={showTeams}
            onClick={() => setShowTeams((v) => !v)}
            title="Fold the outer rings away. Nobody moves — the wedges are fixed."
          >
            {showTeams ? 'Teams shown' : 'Teams folded'}
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={showTeamNames}
            onClick={() => setShowTeamNames((v) => !v)}
            disabled={!showTeams}
            title="Hide the outer ring's names when the circle gets busy"
          >
            {showTeamNames ? "Everyone's names" : "Managers' names"}
          </button>
          <button type="button" className="btn is-primary" onClick={() => props.onOpenAll('map')}>
            <IconOrgChart />
            Open full org chart
          </button>
        </div>
      </header>

      <div className="split">
        <section className="card circle-card" aria-label="The firm as a circle">
          <CircleChart
            layout={circle}
            selectedId={selectedId}
            viewerIds={props.viewerIds}
            showTeams={showTeams}
            showTeamNames={showTeamNames}
            onSelect={setSelectedId}
            onOpenWedge={props.onOpenGroup}
          />
        </section>

        <div className="split-side">
          {selectedId && circle.byId.has(selectedId) ? (
            props.renderPerson(selectedId, setSelectedId)
          ) : (
            <section className="card pad">
              <p className="muted">
                Click anyone on the circle to see who they are — and, if they lead a team, who
                works for them.
              </p>
            </section>
          )}

          <details className="card key">
            <summary>
              <IconInfo />
              Key
              <span className="key-chev">
                <IconChevronDown />
              </span>
            </summary>
            <div className="key-body">
              <p className="eyebrow">Rings, inside out</p>
              <div className="key-rings">
                {circle.rings.map((ring) => (
                  <div className="key-row" key={ring.ring}>
                    <i
                      className="key-disc"
                      style={{ width: 4 + (6 - Math.min(ring.ring, 5)) * 2.5, height: 4 + (6 - Math.min(ring.ring, 5)) * 2.5 }}
                    />
                    <span>{ring.name}</span>
                    <span className="mono muted">{ring.count}</span>
                  </div>
                ))}
              </div>
              <hr />
              <div className="key-legend">
                <i className="key-ring is-you" />
                <span>Your seat</span>
                <i className="key-ring is-stale" />
                <span>Not active in Ajera</span>
                <i className="key-ring is-vacant" />
                <span>Vacant seat</span>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
