import { useEffect, useState } from 'react'
import type { CircleLayout, CircleNode } from '../lib/circle'
import { Avatar } from './Avatar'
import { CircleChart } from './CircleChart'
import { LINKEDIN_GLYPH, LINKEDIN_GLYPH_SIZE } from '../lib/linkedin'
import { IconChevronDown, IconChevronRight, IconInfo, IconOrgChart, IconPencil } from './Icons'

type Props = {
  circle: CircleLayout
  verticalCount: number
  viewerIds: Set<string>
  onOpenGroup: (groupId: string, mode: 'map' | 'tree', focusId?: string) => void
  onOpenAll: (mode: 'map' | 'tree', focusId?: string) => void
  /**
   * Admins only: draws the edit panel for a seat. Absent for everyone else,
   * which is what keeps the pencil off their screen.
   */
  renderEditor?: (args: {
    id: string
    onClose: () => void
    /** Move the selection, e.g. to a seat just added, or to nothing. */
    onSelect: (id: string | null) => void
  }) => React.ReactNode
}

/**
 * The landing page: the whole firm as one circle, and beside it whoever you
 * clicked — their team if they lead one, their details if they don't.
 */
export function Overview(props: Props) {
  const { circle } = props
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** A report picked from the lead's list, shown in place of the lead. */
  const [detailId, setDetailId] = useState<string | null>(null)
  const [showTeams, setShowTeams] = useState(true)
  const [showTeamNames, setShowTeamNames] = useState(true)
  /** The seat whose edit panel is open in place of the details card. */
  const [editingId, setEditingId] = useState<string | null>(null)

  // A new pick on the circle always starts from that seat, not from a report
  // of whoever was picked before — and closes any editor that was open.
  useEffect(() => {
    setDetailId(null)
    setEditingId(null)
  }, [selectedId])

  const selected = selectedId ? circle.byId.get(selectedId) ?? null : null
  const detail = detailId ? circle.byId.get(detailId) ?? null : null

  const reportsOf = (id: string) => circle.nodes.filter((n) => n.position.parent_id === id)
  const wedgeOf = (n: CircleNode) => circle.wedges.find((w) => w.key === n.wedgeKey) ?? null

  /** Open the tree on a seat — in its vertical when it has one. */
  const showInTree = (n: CircleNode) => {
    const g = wedgeOf(n)?.groupId
    if (g) props.onOpenGroup(g, 'tree', n.id)
    else props.onOpenAll('tree', n.id)
  }

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
            onOpenWedge={(g) => props.onOpenGroup(g, 'map')}
          />
        </section>

        <div className="split-side">
          {editingId && props.renderEditor ? (
            props.renderEditor({
              id: editingId,
              onClose: () => setEditingId(null),
              onSelect: (id) => {
                setSelectedId(id)
                setEditingId(id)
              },
            })
          ) : (
          <section className="card pad has-corner" aria-live="polite">
            {props.renderEditor && (detail ?? selected) && (
              <button
                type="button"
                className="card-corner"
                aria-label={`Edit ${(detail ?? selected)!.name}`}
                title="Edit this seat"
                onClick={() => setEditingId((detail ?? selected)!.id)}
              >
                <IconPencil />
              </button>
            )}
            {!selected ? (
              <p className="muted">
                Click anyone on the circle to see who they are — and, if they lead a team, who
                works for them.
              </p>
            ) : detail ? (
              <PersonDetail
                node={detail}
                circle={circle}
                viewer={props.viewerIds.has(detail.id)}
                back={{ label: `${selected.name}'s team`, onClick: () => setDetailId(null) }}
                onPickManager={(id) => {
                  setDetailId(null)
                  setSelectedId(id)
                }}
                onShowInTree={() => showInTree(detail)}
              />
            ) : reportsOf(selected.id).length > 0 ? (
              <LeadDetail
                node={selected}
                circle={circle}
                viewer={props.viewerIds.has(selected.id)}
                reports={reportsOf(selected.id)}
                onPickReport={setDetailId}
                onPickManager={setSelectedId}
                onShowInTree={() => showInTree(selected)}
                onShowMap={(() => {
                  const g = wedgeOf(selected)?.groupId
                  return g ? () => props.onOpenGroup(g, 'map') : undefined
                })()}
              />
            ) : (
              <PersonDetail
                node={selected}
                circle={circle}
                viewer={props.viewerIds.has(selected.id)}
                onPickManager={setSelectedId}
                onShowInTree={() => showInTree(selected)}
              />
            )}
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

/** "March 2021" from an ISO date, read as a calendar date (no timezone shift). */
function hireMonth(iso: string | null | undefined): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}

function Who({ node, viewer, size = 48 }: { node: CircleNode; viewer: boolean; size?: number }) {
  const photo = (
    <span className="ringed" style={{ borderColor: node.accent }}>
      <Avatar node={node} size={size} />
    </span>
  )
  return (
    <div className="who">
      {/* With a profile attached, the photo is the link to it and wears the
          same LinkedIn badge the tree's boxes do. */}
      {node.linkedinUrl ? (
        <a
          className="who-photo"
          href={node.linkedinUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${node.name} on LinkedIn`}
          title={`${node.name} on LinkedIn`}
        >
          {photo}
          <span className="who-li" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <g fill="#fff" transform={`translate(4.5 5) scale(${15 / LINKEDIN_GLYPH_SIZE})`}>
                <path d={LINKEDIN_GLYPH} />
              </g>
            </svg>
          </span>
        </a>
      ) : (
        <span className="who-photo">{photo}</span>
      )}
      <div className="who-text">
        <h2>
          {node.name}
          {viewer && <span className="tag is-you">You</span>}
        </h2>
        {node.title && <p className="muted">{node.title}</p>}
      </div>
    </div>
  )
}

function Pills({ node, circle }: { node: CircleNode; circle: CircleLayout }) {
  const wedge = circle.wedges.find((w) => w.key === node.wedgeKey)
  if (!wedge && !node.stale && !node.vacant) return null
  return (
    <div className="pills">
      {wedge && (
        <span className="pill">
          <i className="dot" style={{ background: wedge.accent }} />
          {wedge.name}
        </span>
      )}
      {node.stale && <span className="pill is-stale">Not active in Ajera</span>}
      {node.vacant && <span className="pill is-vacant">Vacant</span>}
    </div>
  )
}

/** The same four facts for everyone, leads included. */
function Facts(props: {
  node: CircleNode
  circle: CircleLayout
  onPickManager: (id: string) => void
}) {
  const { node, circle } = props
  const manager = node.position.parent_id ? circle.byId.get(node.position.parent_id) : null
  const email = node.employee?.employee_email
  return (
    <dl className="facts">
      <dt>Title</dt>
      <dd>{node.title ?? '—'}</dd>
      <dt>Hire date</dt>
      <dd>{hireMonth(node.employee?.hire_date) ?? '—'}</dd>
      <dt>Reports to</dt>
      <dd>
        {manager ? (
          <button type="button" className="link" onClick={() => props.onPickManager(manager.id)}>
            {manager.name}
          </button>
        ) : (
          'Top of the chart'
        )}
      </dd>
      <dt>Email</dt>
      <dd>{email ? <a href={`mailto:${email}`}>{email}</a> : '—'}</dd>
    </dl>
  )
}

function LeadDetail(props: {
  node: CircleNode
  circle: CircleLayout
  viewer: boolean
  reports: CircleNode[]
  onPickReport: (id: string) => void
  onPickManager: (id: string) => void
  onShowInTree: () => void
  onShowMap?: () => void
}) {
  const { node, reports } = props
  const first = node.name.split(/\s+/)[0]
  return (
    <div className="stack">
      <p className="eyebrow">Team lead</p>
      <Who node={node} viewer={props.viewer} />
      <Pills node={node} circle={props.circle} />
      <Facts node={node} circle={props.circle} onPickManager={props.onPickManager} />
      <div className="plist">
        <div className="plist-head">
          <p className="eyebrow">Reporting to {first}</p>
          <p className="eyebrow mono">{reports.length}</p>
        </div>
        {reports.map((r) => (
          <button key={r.id} type="button" className="prow" onClick={() => props.onPickReport(r.id)}>
            <Avatar node={r} size={32} />
            <span className="prow-text">
              <span className="prow-name">{r.name}</span>
              <span className="prow-sub">
                {[r.title, r.childCount > 0 && `${r.childCount} direct`].filter(Boolean).join(' · ')}
              </span>
            </span>
            <IconChevronRight />
          </button>
        ))}
      </div>
      <div className="row-wrap">
        <button type="button" className="btn" onClick={props.onShowInTree}>
          Show in tree
        </button>
        {props.onShowMap && (
          <button type="button" className="btn" onClick={props.onShowMap}>
            Map overview
          </button>
        )}
      </div>
    </div>
  )
}

function PersonDetail(props: {
  node: CircleNode
  circle: CircleLayout
  viewer: boolean
  back?: { label: string; onClick: () => void }
  onPickManager: (id: string) => void
  onShowInTree: () => void
}) {
  const { node } = props
  return (
    <div className="stack">
      {props.back && (
        <button type="button" className="back" onClick={props.back.onClick}>
          ‹ {props.back.label}
        </button>
      )}
      <Who node={node} viewer={props.viewer} />
      <Pills node={node} circle={props.circle} />
      <Facts node={node} circle={props.circle} onPickManager={props.onPickManager} />
      <div className="row-wrap">
        <button type="button" className="btn" onClick={props.onShowInTree}>
          Show in tree
        </button>
      </div>
    </div>
  )
}
