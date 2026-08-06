import { useCallback, useEffect, useRef, useState } from 'react'
import type { Layout, Orientation } from '../lib/types'
import { NODE_W } from '../lib/layout'
import { NodeCard } from './NodeCard'

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

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2
const PADDING = 80

export function Chart(props: Props) {
  const { layout, isAdmin } = props
  const viewportRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: PADDING, y: PADDING, k: 0.9 })
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const { orientation } = props
  const fit = useCallback(() => {
    const el = viewportRef.current
    if (!el || layout.width === 0) return

    // Left-to-right is only a few columns wide but as tall as the headcount.
    // Fitting both axes would zoom to ~9% and be useless, so fit the width
    // and let the page scroll vertically, which is what it's shaped for.
    const k = Math.max(
      MIN_ZOOM,
      orientation === 'horizontal'
        ? Math.min(1, (el.clientWidth - PADDING * 2) / layout.width)
        : Math.min(
            1,
            (el.clientWidth - PADDING * 2) / layout.width,
            (el.clientHeight - PADDING * 2) / layout.height,
          ),
    )
    setView({ k, x: (el.clientWidth - layout.width * k) / 2, y: PADDING })
  }, [layout.width, layout.height, orientation])

  // Fit once when the chart first has something in it, and again whenever the
  // orientation flips — the previous pan/zoom is meaningless in the new
  // geometry. Refitting on ordinary data changes would yank the view out from
  // under an admin mid-edit, so that case is deliberately excluded.
  const hasFit = useRef('')
  useEffect(() => {
    if (layout.width === 0 || hasFit.current === props.orientation) return
    hasFit.current = props.orientation
    fit()
  }, [fit, layout.width, props.orientation])

  // Recentre on a specific seat — used by search and by newly added seats.
  const { focusId, onFocusHandled } = props
  useEffect(() => {
    const target = focusId ? layout.byId.get(focusId) : null
    const el = viewportRef.current
    if (!target || !el) return
    setView((v) => ({
      ...v,
      x: el.clientWidth / 2 - (target.x + NODE_W / 2) * v.k,
      y: el.clientHeight / 3 - target.y * v.k,
    }))
    onFocusHandled()
  }, [focusId, layout.byId, onFocusHandled])

  function onWheel(e: React.WheelEvent) {
    const el = viewportRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top

    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * 0.0015)))
      // Keep whatever is under the cursor pinned there as the scale changes.
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
    })
  }

  function onPointerDown(e: React.PointerEvent) {
    // Only pan from the background. Starting a pan on a card would fight the
    // HTML5 drag that re-parents it.
    if ((e.target as HTMLElement).closest('.node')) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    setIsPanning(true)
    props.onSelect(null)
  }

  function onPointerMove(e: React.PointerEvent) {
    const start = pan.current
    if (!start) return
    setView((v) => ({ ...v, x: start.vx + (e.clientX - start.x), y: start.vy + (e.clientY - start.y) }))
  }

  function endPan() {
    pan.current = null
    setIsPanning(false)
  }

  function endDrag() {
    setDragging(null)
    setDropTarget(null)
    props.onDragStateChange(null)
  }

  const canDropOn = (id: string) =>
    dragging !== null && !props.forbiddenIds.has(id) && layout.byId.get(dragging)?.position.parent_id !== id

  return (
    <div
      ref={viewportRef}
      className={`chart-viewport ${isPanning ? 'is-panning' : ''}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
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
      <div className="chart-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
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
      </div>

      <div className="chart-controls">
        <button title="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(MIN_ZOOM, v.k / 1.25) }))}>
          −
        </button>
        <span className="zoom-readout">{Math.round(view.k * 100)}%</span>
        <button title="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(MAX_ZOOM, v.k * 1.25) }))}>
          +
        </button>
        <button title="Fit the whole chart on screen" onClick={fit}>
          Fit
        </button>
      </div>
    </div>
  )
}
