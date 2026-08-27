import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * A scrollable, zoomable viewport shared by the circle and the tree.
 *
 * It scrolls natively rather than by transform. That is the whole point: a
 * transform-panned canvas gives no scrollbars, so nothing on screen says the
 * chart continues past the edge, and people who never think to drag the
 * background conclude the rest of the firm isn't there. Real scrollbars say it
 * for us, and bring the wheel, trackpad, arrow keys and touch drag along free.
 *
 * So the content is laid out at its true pixel size times the zoom, and only
 * the scale is a transform. Zooming then has to fix up the scroll offsets
 * itself, which is what the pending ref below is for.
 */

export type ZoomPaneHandle = {
  /** Scale the content to the viewport and park it top-centre. */
  fit: () => void
  /** Bring a point in content coordinates into view, without changing zoom. */
  centerOn: (x: number, y: number) => void
}

type Props = {
  /** The content's own size, before zoom, in the units its children use. */
  contentWidth: number
  contentHeight: number
  minZoom?: number
  maxZoom?: number
  /**
   * 'width' fits the horizontal axis only. Left-to-right trees are a few
   * columns wide and as tall as the headcount; fitting both axes zooms them to
   * single digits, so they fit the width and scroll down instead.
   */
  fitAxis?: 'both' | 'width'
  /** Breathing room around the content, in screen pixels. */
  padding?: number
  /** Pointerdown inside a match never starts a pan — cards you drag, mostly. */
  panIgnore?: string
  /** Fired when a pan begins on the background. Used to clear the selection. */
  onPanStart?: () => void
  className?: string
  children: React.ReactNode
  onDragOver?: React.DragEventHandler
  onDrop?: React.DragEventHandler
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** What the scroll offsets should become once the new zoom has been laid out. */
type Pending =
  | { kind: 'anchor'; cx: number; cy: number; px: number; py: number }
  | { kind: 'fit' }

export const ZoomPane = forwardRef<ZoomPaneHandle, Props>(function ZoomPane(props, ref) {
  const {
    contentWidth,
    contentHeight,
    minZoom = 0.2,
    maxZoom = 2,
    fitAxis = 'both',
    padding = 40,
    panIgnore,
  } = props

  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const pan = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null)
  const pending = useRef<Pending | null>(null)

  /**
   * Where the content's top-left sits in scroll coordinates. Not a constant:
   * when the content is smaller than the viewport it is centred by auto
   * margins, so this has to be measured after every layout.
   */
  function origin() {
    const vp = viewportRef.current
    const el = contentRef.current
    if (!vp || !el) return null
    const vr = vp.getBoundingClientRect()
    const cr = el.getBoundingClientRect()
    return { x: cr.left - vr.left + vp.scrollLeft, y: cr.top - vr.top + vp.scrollTop }
  }

  function parkTopCentre(vp: HTMLDivElement) {
    vp.scrollTop = 0
    vp.scrollLeft = (vp.scrollWidth - vp.clientWidth) / 2
  }

  // Zoom changes the scrollable area, so the offsets can only be corrected
  // after the browser has laid the new size out — hence a layout effect, not
  // the setState call that asked for the zoom.
  useLayoutEffect(() => {
    const vp = viewportRef.current
    const want = pending.current
    if (!vp || !want) return
    pending.current = null

    if (want.kind === 'fit') {
      parkTopCentre(vp)
      return
    }
    const o = origin()
    if (!o) return
    vp.scrollLeft = o.x + want.cx * zoom - want.px
    vp.scrollTop = o.y + want.cy * zoom - want.py
  }, [zoom])

  /**
   * Zoom, keeping the content point under (px, py) where it is. `next` may be
   * a function of the current zoom so the wheel handler below never has to
   * close over it — that listener has to be registered by hand, and a stale
   * zoom in it would make the wheel fight itself.
   */
  const zoomTo = useCallback(
    (next: number | ((k: number) => number), px?: number, py?: number) => {
      const vp = viewportRef.current
      const o = origin()
      if (!vp || !o) return
      const ax = px ?? vp.clientWidth / 2
      const ay = py ?? vp.clientHeight / 2
      setZoom((k) => {
        const clamped = clamp(typeof next === 'function' ? next(k) : next, minZoom, maxZoom)
        if (clamped === k) return k
        pending.current = {
          kind: 'anchor',
          cx: (vp.scrollLeft + ax - o.x) / k,
          cy: (vp.scrollTop + ay - o.y) / k,
          px: ax,
          py: ay,
        }
        return clamped
      })
    },
    [maxZoom, minZoom],
  )

  /**
   * Wheel, by hand. React registers its onWheel at the root as a *passive*
   * listener, so preventDefault there is ignored — and without it Ctrl+scroll
   * zooms the chart and the whole browser page at the same time.
   */
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    function onWheel(e: WheelEvent) {
      // Plain wheel scrolls, because there are scrollbars now and that is what
      // they promise. Zooming keeps the modifier every canvas app uses for it,
      // which is also what a trackpad pinch arrives as.
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = vp!.getBoundingClientRect()
      zoomTo((k) => k * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  const fit = useCallback(() => {
    const vp = viewportRef.current
    if (!vp || contentWidth === 0 || contentHeight === 0) return
    const w = (vp.clientWidth - padding * 2) / contentWidth
    const h = (vp.clientHeight - padding * 2) / contentHeight
    // Never past 1:1 — a six-person vertical blown up to fill a monitor looks
    // like a mistake, and "Fit" is meant to be the reassuring button.
    const k = clamp(fitAxis === 'width' ? Math.min(1, w) : Math.min(1, w, h), minZoom, maxZoom)
    if (k === zoom) {
      // Same zoom means no re-layout, so the effect below never fires.
      parkTopCentre(vp)
      return
    }
    pending.current = { kind: 'fit' }
    setZoom(k)
  }, [contentWidth, contentHeight, fitAxis, maxZoom, minZoom, padding, zoom])

  useImperativeHandle(
    ref,
    () => ({
      fit,
      centerOn(x, y) {
        const vp = viewportRef.current
        const o = origin()
        if (!vp || !o) return
        vp.scrollLeft = o.x + x * zoom - vp.clientWidth / 2
        // A third of the way down, not halfway: what you searched for is
        // usually a manager, and you want their reports on screen too.
        vp.scrollTop = o.y + y * zoom - vp.clientHeight / 3
      },
    }),
    [fit, zoom],
  )

  function onPointerDown(e: React.PointerEvent) {
    const vp = viewportRef.current
    if (!vp || e.button !== 0) return
    // Clicks on the scrollbars land inside the viewport but belong to it.
    const r = vp.getBoundingClientRect()
    if (e.clientX - r.left > vp.clientWidth || e.clientY - r.top > vp.clientHeight) return
    if (panIgnore && (e.target as Element).closest(panIgnore)) return

    // Touching the background still means "never mind, deselect" — but touch
    // already pans by scrolling natively, and capturing the pointer for a drag
    // would only stop it. Mouse gets drag-to-pan, as it always had.
    props.onPanStart?.()
    if (e.pointerType !== 'mouse') return

    vp.setPointerCapture(e.pointerId)
    pan.current = { x: e.clientX, y: e.clientY, sx: vp.scrollLeft, sy: vp.scrollTop }
    setIsPanning(true)
  }

  function onPointerMove(e: React.PointerEvent) {
    const vp = viewportRef.current
    const start = pan.current
    if (!vp || !start) return
    vp.scrollLeft = start.sx - (e.clientX - start.x)
    vp.scrollTop = start.sy - (e.clientY - start.y)
  }

  function endPan() {
    pan.current = null
    setIsPanning(false)
  }

  const percent = Math.round(zoom * 100)
  const classes = ['zoom-viewport', props.className, isPanning && 'is-panning']
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={viewportRef}
      className={classes}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <div className="zoom-sizer">
        <div
          ref={contentRef}
          className="zoom-content"
          style={{ width: contentWidth * zoom, height: contentHeight * zoom }}
        >
          <div
            className="zoom-scaled"
            style={{ width: contentWidth, height: contentHeight, transform: `scale(${zoom})` }}
          >
            {props.children}
          </div>
        </div>
      </div>

      <div className="zoom-controls" title="Ctrl + scroll to zoom. Drag the background to pan.">
        <button aria-label="Zoom out" title="Zoom out" onClick={() => zoomTo(zoom / 1.25)}>
          −
        </button>
        <input
          className="zoom-slider"
          type="range"
          aria-label="Zoom"
          min={Math.round(minZoom * 100)}
          max={Math.round(maxZoom * 100)}
          step={1}
          value={percent}
          onChange={(e) => zoomTo(Number(e.target.value) / 100)}
        />
        <button aria-label="Zoom in" title="Zoom in" onClick={() => zoomTo(zoom * 1.25)}>
          +
        </button>
        <span className="zoom-readout">{percent}%</span>
        <button className="zoom-fit" title="Fit the whole chart on screen" onClick={fit}>
          Fit
        </button>
      </div>
    </div>
  )
})
