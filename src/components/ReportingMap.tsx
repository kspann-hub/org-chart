import { useEffect, useRef } from 'react'
import type { ChartNode } from '../lib/types'
import { countBelow, type Forest } from '../lib/tree'
import { Avatar } from './Avatar'

/** Test mode's hooks into the map. Absent outside test mode. */
export type MapTest = {
  selectedId: string | null
  /** The seat being dragged right now, if any. */
  dragId: string | null
  /** The drop target under the pointer, so it can light up. */
  overKey: string | null
  /** Seats moved or added in this sandbox, drawn in test purple. */
  changed: Set<string>
  onPick: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onOver: (key: string | null) => void
  /** Whether the dragged seat may report to `managerId` (no loops, no no-ops). */
  canDrop: (managerId: string) => boolean
  /** Make the dragged seat report to `managerId`. */
  onDrop: (managerId: string) => void
}

/**
 * Drag-and-drop wiring for one element in test mode. `managerId` is who the
 * dropped seat will report to; `key` names this target for the hover glow.
 */
function dnd(test: MapTest | undefined, managerId: string, key: string, dragId?: string) {
  if (!test) return {}
  return {
    draggable: dragId !== undefined,
    onDragStart: (e: React.DragEvent) => {
      if (dragId === undefined) return
      e.stopPropagation()
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', dragId)
      test.onDragStart(dragId)
    },
    onDragEnd: () => test.onDragEnd(),
    onDragOver: (e: React.DragEvent) => {
      if (!test.dragId || !test.canDrop(managerId)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (test.overKey !== key) test.onOver(key)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (test.overKey === key && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
        test.onOver(null)
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      test.onDrop(managerId)
    },
  }
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
  /** The person whose card is open: ringed, and pulsing as it arrives. */
  selectedId?: string | null
  /** Scroll this seat into view once it is drawn, then call onFocusHandled. */
  focusId?: string | null
  onFocusHandled?: () => void
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
  const { forest, focusId, onFocusHandled } = props
  const rootRef = useRef<HTMLDivElement>(null)

  // No dependency list on purpose: the seat may only appear a render later,
  // once its managers have been unfolded, so keep looking until it is there.
  // A page can hold several maps (one per vertical); only the one holding the
  // seat answers, the rest leave the request alone.
  useEffect(() => {
    if (!focusId) return
    const el = rootRef.current?.querySelector(`[data-seat="${CSS.escape(focusId)}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    onFocusHandled?.()
  })

  return (
    <div className="rmap" ref={rootRef}>
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
    props.selectedId === node.id && 'is-found',
    props.test?.selectedId === node.id && 'is-on',
    props.test?.changed.has(node.id) && 'is-moved',
    props.test?.dragId === node.id && 'is-dragging',
    props.test?.overKey === node.id && 'is-drop',
  ]
    .filter(Boolean)
    .join(' ')
  const test = props.test

  return (
    <button
      type="button"
      className={cls}
      data-seat={node.id}
      onClick={() => (test ? test.onPick(node.id) : props.onOpen(node.id))}
      aria-pressed={test ? test.selectedId === node.id : undefined}
      title={
        test
          ? 'Drag onto a person or team to move. Click to select.'
          : `Show ${node.name}'s card`
      }
      {...dnd(test, node.id, node.id, node.id)}
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
  const teamKey = `team:${manager.id}`
  const cls = [
    'rmap-team',
    test && 'is-test',
    test?.overKey === teamKey && 'is-drop',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} {...dnd(test, manager.id, teamKey)}>
      <div className="rmap-team-head">
        <span className="eyebrow">
          {team.length} direct {team.length === 1 ? 'report' : 'reports'}
        </span>
      </div>
      <div className="rmap-chips">
        {team.map((p) => {
          const picked = test?.selectedId === p.id
          const moved = test?.changed.has(p.id)
          const cls = [
            'chip',
            p.stale && 'is-stale',
            p.vacant && 'is-vacant',
            p.manual && 'is-manual',
            props.viewerIds.has(p.id) && 'is-you',
            props.selectedId === p.id && 'is-found',
            picked && 'is-on',
            moved && 'is-moved',
            test?.dragId === p.id && 'is-dragging',
            test?.overKey === p.id && 'is-drop',
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
              data-seat={p.id}
              aria-pressed={test ? picked : undefined}
              title={note || undefined}
              onClick={() => (test ? test.onPick(p.id) : props.onOpen(p.id))}
              {...dnd(test, p.id, p.id, p.id)}
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
