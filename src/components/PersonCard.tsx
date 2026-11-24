import { useEffect, useRef, useState } from 'react'
import type { ChartNode } from '../lib/types'
import { LINKEDIN_GLYPH, LINKEDIN_GLYPH_SIZE } from '../lib/linkedin'
import { Avatar } from './Avatar'
import { IconChevronRight, IconClose, IconPencil } from './Icons'

/** What a card needs to know about the chart around the person. */
export type PersonContext = {
  byId: Map<string, ChartNode>
  /** Direct reports, by manager id. */
  kids: Map<string, ChartNode[]>
  accentOf: (id: string) => string | null
  verticalOf: (id: string) => { id: string; name: string; accent: string } | null
  viewerIds: Set<string>
}

type Props = {
  /** The person picked on the circle, map or tree. */
  id: string
  ctx: PersonContext
  /** Move the selection on whatever screen hosts the card (null clears it). */
  onSelect: (id: string | null) => void
  /** Open the person on their vertical's map view, highlighted. */
  onShowOnMap?: (id: string) => void
  /**
   * Admins only: draws the edit panel. Absent for everyone else, which is what
   * keeps the pencil off their screen — the database refuses their writes
   * regardless.
   */
  renderEditor?: PersonEditor
  /** Extra rows for the screen hosting the card, under the four facts. */
  extra?: (shownId: string) => React.ReactNode
}

export type PersonEditor = (args: {
  id: string
  onClose: () => void
  /** Select a different seat, optionally straight into its editor. */
  onSelect: (id: string | null, edit?: boolean) => void
}) => React.ReactNode

const FALLBACK_ACCENT = '#6b7280'

/**
 * The one employee card. The Overview, the map overviews and the trees all
 * show this, so a person looks the same wherever you click them.
 *
 * A lead's card lists their team; picking someone from that list shows that
 * person's card in place, with a way back.
 */
export function PersonCard(props: Props) {
  const { ctx } = props
  /** A report picked from the lead's list, shown in place of the lead. */
  const [detailId, setDetailId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  /** Set when a selection change should land straight in the editor. */
  const editNext = useRef<string | null>(null)

  useEffect(() => {
    setDetailId(null)
    setEditing(editNext.current === props.id)
    editNext.current = null
  }, [props.id])

  const lead = ctx.byId.get(props.id) ?? null
  const shown = (detailId && ctx.byId.get(detailId)) || lead
  if (!lead || !shown) return null

  if (editing && props.renderEditor) {
    return (
      <>
        {props.renderEditor({
          id: shown.id,
          onClose: () => setEditing(false),
          onSelect: (id, edit) => {
            if (id && edit) editNext.current = id
            props.onSelect(id)
          },
        })}
      </>
    )
  }

  const reports = ctx.kids.get(shown.id) ?? []
  const vertical = ctx.verticalOf(shown.id)
  const isLead = reports.length > 0

  return (
    <section
      className={`card pad has-corner person-card${props.renderEditor ? ' has-two-corners' : ''}`}
      aria-live="polite"
    >
      <div className="card-corners">
        {props.renderEditor && (
          <button
            type="button"
            className="card-corner"
            aria-label={`Edit ${shown.name}`}
            title="Edit this seat"
            onClick={() => setEditing(true)}
          >
            <IconPencil />
          </button>
        )}
        <button
          type="button"
          className="card-corner"
          aria-label="Close this card"
          title="Close"
          onClick={() => props.onSelect(null)}
        >
          <IconClose />
        </button>
      </div>

      <div className="stack">
        {detailId ? (
          <button type="button" className="back" onClick={() => setDetailId(null)}>
            ‹ {lead.name}'s team
          </button>
        ) : (
          isLead && <p className="eyebrow">Team lead</p>
        )}

        <Who
          node={shown}
          accent={ctx.accentOf(shown.id) ?? FALLBACK_ACCENT}
          viewer={ctx.viewerIds.has(shown.id)}
        />

        {(vertical || shown.stale || shown.vacant) && (
          <div className="pills">
            {vertical && (
              <span className="pill">
                <i className="dot" style={{ background: vertical.accent }} />
                {vertical.name}
              </span>
            )}
            {shown.stale && <span className="pill is-stale">Not active in Ajera</span>}
            {shown.vacant && <span className="pill is-vacant">Vacant</span>}
          </div>
        )}

        <Facts
          node={shown}
          manager={shown.position.parent_id ? ctx.byId.get(shown.position.parent_id) ?? null : null}
          onPickManager={(id) => props.onSelect(id)}
        />

        {props.extra?.(shown.id)}

        {isLead && (
          <div className="plist">
            <div className="plist-head">
              <p className="eyebrow">Reporting to {shown.name.split(/\s+/)[0]}</p>
              <p className="eyebrow mono">{reports.length}</p>
            </div>
            {reports.map((r) => {
              const below = ctx.kids.get(r.id)?.length ?? 0
              return (
                <button
                  key={r.id}
                  type="button"
                  className="prow"
                  // From a lead's card, a report opens in place with a way
                  // back. From a report's card, go to the person properly.
                  onClick={() => (detailId ? props.onSelect(r.id) : setDetailId(r.id))}
                >
                  <Avatar node={r} size={32} />
                  <span className="prow-text">
                    <span className="prow-name">{r.vacant ? 'Vacant seat' : r.name}</span>
                    <span className="prow-sub">
                      {[r.title, below > 0 && `${below} direct`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <IconChevronRight />
                </button>
              )
            })}
          </div>
        )}

        {props.onShowOnMap && (
          <div className="row-wrap">
            <button type="button" className="btn" onClick={() => props.onShowOnMap!(shown.id)}>
              Show on map
            </button>
          </div>
        )}
      </div>
    </section>
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

function Who({ node, accent, viewer }: { node: ChartNode; accent: string; viewer: boolean }) {
  const photo = (
    <span className="ringed" style={{ borderColor: accent }}>
      <Avatar node={node} size={48} />
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
          {node.vacant ? 'Vacant seat' : node.name}
          {viewer && <span className="tag is-you">You</span>}
        </h2>
        {node.title && <p className="muted">{node.title}</p>}
      </div>
    </div>
  )
}

/** The same four facts for everyone, leads included. */
function Facts(props: {
  node: ChartNode
  manager: ChartNode | null
  onPickManager: (id: string) => void
}) {
  const { node, manager } = props
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
