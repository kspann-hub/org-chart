import type { ChartNode } from '../lib/types'
import { countBelow, type Forest } from '../lib/tree'
import { Avatar } from './Avatar'

/** Test mode's hooks into the map. Absent outside test mode. */
export type MapTest = {
  selectedId: string | null
  /** How the "Move … here" button refers to the picked seat. */
  selectedName: string
  /** Seats moved in this sandbox: seat id -> the manager it was moved to. */
  moved: Map<string, string>
  onPick: (id: string) => void
  onMoveHere: (managerId: string) => void
}

type Props = {
  forest: Forest
  accentOf: (id: string) => string | null
  viewerIds: Set<string>
  /** Click on a person outside test mode: opens their employee card. */
  onOpen: (id: string) => void
  test?: MapTest
  /** When set, each manager gets a +/− tab and only open ones show reports. */
  open?: Set<string>
  onToggle?: (id: string) => void
}

const FALLBACK_ACCENT = '#6b7280'

/**
 * The reporting line as columns: lead, then managers, then their teams.
 *
 * The tree view (Chart) answers the same question with boxes on a canvas you
 * pan around. This one fits a whole vertical on a page that scrolls normally,
 * because individual contributors collapse into a compact team box instead of
 * each getting a card of their own — they are most of the firm, and most of
 * the width of the tree.
 */
export function ReportingMap(props: Props) {
  const { forest } = props
  return (
    <div className="rmap">
      {forest.roots.map((root) => (
        <div className="rmap-root" key={root.id}>
          <Branch {...props} node={root} depth={0} />
        </div>
      ))}
    </div>
  )
}

function Branch(props: Props & { node: ChartNode; depth: number }) {
  const { node, depth, forest } = props
  const kids = forest.kids.get(node.id) ?? []
  const collapsible = Boolean(props.open && props.onToggle)
  const isOpen = !collapsible || props.open!.has(node.id)

  if (kids.length === 0) {
    // A root with no reports, e.g. a lone seat outside every vertical.
    return depth === 0 ? <Card {...props} node={node} depth={depth} below={0} /> : null
  }

  const managers = kids.filter((k) => (forest.kids.get(k.id)?.length ?? 0) > 0)
  const team = kids.filter((k) => !forest.kids.has(k.id))
  const below = countBelow(node.id, forest.kids)
  const items = managers.length + (team.length > 0 ? 1 : 0)

  return (
    <div className="rmap-row">
      <div className="rmap-cardwrap">
        <Card {...props} node={node} depth={depth} below={below} direct={kids.length} />
        {collapsible && (
          <button
            type="button"
            className="rmap-tog"
            aria-expanded={isOpen}
            aria-label={
              isOpen ? `Fold ${node.name}'s team` : `Show ${node.name}'s ${below} people`
            }
            onClick={() => props.onToggle!(node.id)}
          >
            {isOpen ? '−' : `+${below}`}
          </button>
        )}
      </div>

      {isOpen && (
        <>
          <div className="rmap-stub" />
          {managers.length === 0 ? (
            <TeamBox {...props} manager={node} team={team} />
          ) : (
            <div className="rmap-br">
              {managers.map((m, i) => (
                <div className={`rmap-it ${position(i, items)}`} key={m.id}>
                  <Branch {...props} node={m} depth={depth + 1} />
                </div>
              ))}
              {team.length > 0 && (
                <div className={`rmap-it ${position(items - 1, items)}`}>
                  <TeamBox {...props} manager={node} team={team} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function position(i: number, len: number) {
  if (len === 1) return 'is-only'
  if (i === 0) return 'is-first'
  if (i === len - 1) return 'is-last'
  return ''
}

function Card(
  props: Props & { node: ChartNode; depth: number; below: number; direct?: number },
) {
  const { node, depth } = props
  const accent = props.accentOf(node.id) ?? FALLBACK_ACCENT
  const size = depth === 0 ? 48 : depth === 1 ? 36 : 28
  const cls = [
    'rmap-node',
    depth === 0 && 'is-lead',
    depth >= 2 && 'is-small',
    node.stale && 'is-stale',
    node.vacant && 'is-vacant',
    node.manual && 'is-manual',
    props.viewerIds.has(node.id) && 'is-you',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={cls}
      onClick={() => props.onOpen(node.id)}
      disabled={Boolean(props.test)}
      title={props.test ? undefined : `Show ${node.name}'s card`}
    >
      <span className="ringed" style={{ borderColor: accent }}>
        <Avatar node={node} size={size} />
      </span>
      <span className="rmap-node-text">
        <span className="rmap-name">{node.name}</span>
        {node.title && <span className="rmap-sub">{node.title}</span>}
        {depth === 0 && props.direct !== undefined ? (
          <span className="rmap-sub">
            {props.direct} direct · {props.below} below
          </span>
        ) : depth === 1 ? (
          <span className="rmap-sub">{props.below} below</span>
        ) : null}
        {node.stale && <span className="rmap-flag">Not active in Ajera</span>}
      </span>
    </button>
  )
}

function TeamBox(props: Props & { manager: ChartNode; team: ChartNode[] }) {
  const { manager, team, test } = props
  const canDrop =
    test?.selectedId != null &&
    test.selectedId !== manager.id &&
    !team.some((t) => t.id === test.selectedId)

  return (
    <div className={test ? 'rmap-team is-test' : 'rmap-team'}>
      <div className="rmap-team-head">
        <span className="eyebrow">
          {team.length} direct {team.length === 1 ? 'report' : 'reports'}
        </span>
        {canDrop && (
          <button type="button" className="btn sm is-test" onClick={() => test!.onMoveHere(manager.id)}>
            Move {test!.selectedName} here
          </button>
        )}
      </div>
      <div className="rmap-chips">
        {team.map((p) => {
          const picked = test?.selectedId === p.id
          const moved = test?.moved.has(p.id)
          const cls = [
            'chip',
            p.stale && 'is-stale',
            p.vacant && 'is-vacant',
            p.manual && 'is-manual',
            props.viewerIds.has(p.id) && 'is-you',
            picked && 'is-on',
            moved && 'is-moved',
          ]
            .filter(Boolean)
            .join(' ')
          const note = [
            p.title,
            p.stale && 'not active in Ajera',
            p.vacant && 'no one in this seat yet',
            p.manual && 'added by hand',
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <button
              key={p.id}
              type="button"
              className={cls}
              aria-pressed={test ? picked : undefined}
              title={note || undefined}
              onClick={() => (test ? test.onPick(p.id) : props.onOpen(p.id))}
            >
              <span className="chip-name">
                <i
                  className="dot"
                  style={{
                    background: p.stale
                      ? 'var(--warn)'
                      : p.vacant
                        ? 'var(--line-strong)'
                        : props.accentOf(p.id) ?? FALLBACK_ACCENT,
                  }}
                />
                {p.vacant ? 'Vacant seat' : p.name}
              </span>
              {p.title && <span className="chip-sub">{p.title}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
