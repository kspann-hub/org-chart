import type { PlacedNode } from '../lib/types'
import { AVATAR_SIZE, NODE_H, NODE_W } from '../lib/layout'
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
