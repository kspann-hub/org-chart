import type { PlacedNode } from '../lib/types'
import { AVATAR_SIZE, NODE_H, NODE_W } from '../lib/layout'
import { LINKEDIN_GLYPH, LINKEDIN_GLYPH_SIZE } from '../lib/linkedin'
import { Avatar } from './Avatar'

type Props = {
  node: PlacedNode
  isAdmin: boolean
  selected: boolean
  matched: boolean
  dimmed: boolean
  /** The signed-in user's own box. */
  isViewer: boolean
  collapsed: boolean
  isDropTarget: boolean
  accent: string | null
  onSelect: (id: string) => void
  onToggleCollapse: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDropOn: (id: string) => void
  onDragOver: (id: string | null) => void
}

export function NodeCard(props: Props) {
  const { node, isAdmin, selected, matched, dimmed, collapsed, isDropTarget, isViewer } = props

  const classes = [
    'node',
    selected && 'is-selected',
    matched && 'is-matched',
    dimmed && 'is-dimmed',
    isDropTarget && 'is-drop-target',
    node.vacant && 'is-vacant',
    node.manual && 'is-manual',
    node.stale && 'is-stale',
    isViewer && 'is-viewer',
    !node.title && 'is-compact',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      style={{
        left: node.x,
        top: node.y,
        width: NODE_W,
        height: NODE_H,
        // Group colour tints the card so a branch reads as one unit.
        ...(props.accent ? { '--node-accent': props.accent } : {}),
      } as React.CSSProperties}
      // The dashed outline says "this box isn't from Ajera"; this says why.
      title={node.manual ? 'Added by hand — this seat is not from Ajera' : undefined}
      // Admins drag boxes to re-parent them. For everyone else the chart is
      // inert — but that's presentation only; the database is what refuses
      // their writes.
      draggable={isAdmin}
      onClick={() => props.onSelect(node.id)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', node.id)
        props.onDragStart(node.id)
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(e) => {
        if (!isAdmin) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        props.onDragOver(node.id)
      }}
      onDragLeave={() => props.onDragOver(null)}
      onDrop={(e) => {
        if (!isAdmin) return
        e.preventDefault()
        e.stopPropagation()
        props.onDropOn(node.id)
      }}
    >
      <div className="node-avatar-slot">
        <Avatar node={node} size={AVATAR_SIZE} />

        {/* Only shown when an admin has attached a profile. The click has to
            be kept to itself: bubbling would select the box behind it, and a
            link is draggable by default, which would fight the re-parent drag. */}
        {node.linkedinUrl && (
          <a
            className="node-linkedin"
            href={node.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
            aria-label={`${node.name} on LinkedIn`}
            title={`${node.name} on LinkedIn`}
            onClick={(e) => e.stopPropagation()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <g
                fill="#fff"
                transform={`translate(4.5 5) scale(${15 / LINKEDIN_GLYPH_SIZE})`}
              >
                <path d={LINKEDIN_GLYPH} />
              </g>
            </svg>
          </a>
        )}
      </div>

      <div className="node-card">
        <div className="node-name" title={node.name}>
          {node.name}
          {isViewer && <span className="node-you">You</span>}
        </div>
        {node.title && (
          <div className="node-title" title={node.title}>
            {node.title}
          </div>
        )}
        {node.stale && <div className="node-flag">Not active in Ajera</div>}
      </div>

      {node.descendantCount > 0 && (
        <button
          className="node-toggle"
          title={
            collapsed
              ? `Show ${node.descendantCount} below ${node.name}`
              : `Hide ${node.descendantCount} below ${node.name}`
          }
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleCollapse(node.id)
          }}
        >
          {collapsed ? `+${node.descendantCount}` : '−'}
        </button>
      )}
    </div>
  )
}
