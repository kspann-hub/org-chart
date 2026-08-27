import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Layout, Orientation } from '../lib/types'
import { NODE_W } from '../lib/layout'
import { NodeCard } from './NodeCard'
import { ZoomPane, type ZoomPaneHandle } from './ZoomPane'

type Props = {
  layout: Layout
  isAdmin: boolean
  selectedId: string | null
  matchedIds: Set<string>
  searching: boolean
  collapsed: Set<string>
  /** Seats the in-flight drag may not land on (itself and its own reports). */
  forbiddenIds: Set<string>
  /** Seats belonging to the signed-in user — one person can hold several. */
  viewerIds: Set<string>
  orientation: Orientation
  /** Group colour for a seat, so a branch reads as one unit. */
  accentOf: (id: string) => string | null
  onSelect: (id: string | null) => void
  onToggleCollapse: (id: string) => void
  onReparent: (childId: string, newParentId: string | null) => void
  onDragStateChange: (draggingId: string | null) => void
  /** Set by the parent when it wants the view recentred on a seat. */
  focusId: string | null
  onFocusHandled: () => void
}

export function Chart(props: Props) {
  const { layout, isAdmin } = props
  const paneRef = useRef<ZoomPaneHandle>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // Fit once when the chart first has something in it, and again whenever the
  // orientation flips — the previous pan/zoom is meaningless in the new
  // geometry. Refitting on ordinary data changes would yank the view out from
  // under an admin mid-edit, so that case is deliberately excluded.
  // Layout effect, not effect: fitting after the browser has painted shows
  // one frame of the chart at 100% before it snaps down to size.
  const hasFit = useRef('')
  useLayoutEffect(() => {
    if (layout.width === 0 || hasFit.current === props.orientation) return
    hasFit.current = props.orientation
    paneRef.current?.fit()
  }, [layout.width, props.orientation])

  // Recentre on a specific seat — used by search and by newly added seats.
  const { focusId, onFocusHandled } = props
  useEffect(() => {
    const target = focusId ? layout.byId.get(focusId) : null
    if (!target) return
    paneRef.current?.centerOn(target.x + NODE_W / 2, target.y)
    onFocusHandled()
  }, [focusId, layout.byId, onFocusHandled])

  function endDrag() {
    setDragging(null)
    setDropTarget(null)
    props.onDragStateChange(null)
  }

  const canDropOn = (id: string) =>
    dragging !== null && !props.forbiddenIds.has(id) && layout.byId.get(dragging)?.position.parent_id !== id

  return (
    <ZoomPane
      ref={paneRef}
      className="chart-viewport"
      contentWidth={Math.max(layout.width, 1)}
      contentHeight={Math.max(layout.height, 1)}
      fitAxis={props.orientation === 'horizontal' ? 'width' : 'both'}
      padding={80}
      // Starting a pan on a card would fight the HTML5 drag that re-parents it.
      panIgnore=".node"
      onPanStart={() => props.onSelect(null)}
      // Dropping on empty canvas promotes a seat to the top of the chart.
      onDragOver={(e) => {
        if (!isAdmin || !dragging) return
        e.preventDefault()
        setDropTarget(null)
      }}
      onDrop={(e) => {
        if (!isAdmin || !dragging) return
        e.preventDefault()
        props.onReparent(dragging, null)
        endDrag()
      }}
    >
      <svg className="chart-links" width={Math.max(layout.width, 1)} height={Math.max(layout.height, 1)}>
        {layout.links.map((link) => (
          <path key={link.id} d={link.path} />
        ))}
      </svg>

      {layout.nodes.map((node) => (
        <NodeCard
          key={node.id}
          node={node}
          isAdmin={isAdmin}
          selected={props.selectedId === node.id}
          matched={props.matchedIds.has(node.id)}
          isViewer={props.viewerIds.has(node.id)}
          accent={props.accentOf(node.id)}
          dimmed={
            (props.searching && !props.matchedIds.has(node.id)) ||
            (dragging !== null && props.forbiddenIds.has(node.id) && node.id !== dragging)
          }
          collapsed={props.collapsed.has(node.id)}
          isDropTarget={dropTarget === node.id && canDropOn(node.id)}
          onSelect={props.onSelect}
          onToggleCollapse={props.onToggleCollapse}
          onDragStart={(id) => {
            setDragging(id)
            props.onDragStateChange(id)
          }}
          onDragEnd={endDrag}
          onDragOver={(id) => setDropTarget(id)}
          onDropOn={(id) => {
            if (dragging && canDropOn(id)) props.onReparent(dragging, id)
            endDrag()
          }}
        />
      ))}
    </ZoomPane>
  )
}
