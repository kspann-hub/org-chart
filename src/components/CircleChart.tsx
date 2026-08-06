import { useState } from 'react'
import type { CircleLayout, CircleNode } from '../lib/circle'
import { bandLabel, bandPath, spokePath } from '../lib/circle'
import { initials } from './Avatar'

type Props = {
  layout: CircleLayout
  selectedId: string | null
  /** Seats belonging to the signed-in user — one person can hold several. */
  viewerIds: Set<string>
  /** Names shown on the outer rings. The inner rings are always labelled. */
  showTeamNames: boolean
  /** False folds the outer rings away without moving anyone. */
  showTeams: boolean
  onSelect: (id: string | null) => void
  /** Opening a vertical from its band, or from its lead's name. */
  onOpenWedge: (groupId: string) => void
}

/** Rings past this one are the ones the "Teams" toggle folds away. */
const TEAM_RING = 4

export function CircleChart(props: Props) {
  const { layout, showTeams } = props
  const [hoverId, setHoverId] = useState<string | null>(null)

  if (layout.nodes.length === 0) return null

  const activeId = hoverId ?? props.selectedId
  const visible = (n: CircleNode) => showTeams || n.ring < TEAM_RING

  // The lit path: everyone between this seat and its vertical's lead, plus
  // its own direct reports. After "who is this" the next question is always
  // "who works for them".
  const lit = new Set<string>()
  const active = activeId ? layout.byId.get(activeId) ?? null : null
  if (active) {
    // Stay inside the wedge. A lead's own manager sits in another vertical and
    // that line isn't drawn here, so lighting them would leave a box glowing
    // with nothing joining it to anything.
    let id: string | null = active.id
    while (id && !lit.has(id)) {
      lit.add(id)
      const parent: string | null = layout.byId.get(id)?.position.parent_id ?? null
      id = parent && layout.byId.get(parent)?.wedgeKey === active.wedgeKey ? parent : null
    }
    for (const n of layout.nodes) {
      if (n.position.parent_id === active.id && n.wedgeKey === active.wedgeKey) lit.add(n.id)
    }
  }

  const focused = lit.size > 0
  const isLit = (id: string) => lit.has(id)

  return (
    <div className="circle-stage">
      <svg
        className={`circle-chart ${focused ? 'has-focus' : ''}`}
        viewBox={`0 0 ${layout.size} ${layout.size}`}
        role="img"
        aria-label={`Circular chart of ${layout.nodes.length} people across ${layout.wedges.length} verticals.`}
        onPointerDown={(e) => {
          if (!(e.target as Element).closest('.cnode, .cband')) props.onSelect(null)
        }}
      >
        <defs>
          {layout.nodes.filter((n) => n.hasDisc && n.photoUrl).map((n) => (
            <clipPath key={n.id} id={`circle-clip-${n.id}`}>
              <circle cx={n.x} cy={n.y} r={n.size} />
            </clipPath>
          ))}
        </defs>

        {/* Ring guides, named in the wedge gap held open at the top. */}
        {layout.rings.map((ring) => (
          <g key={ring.ring} className={ring.ring >= TEAM_RING && !showTeams ? 'is-folded' : ''}>
            {ring.ring > 1 && (
              <circle className="cring-guide" cx={layout.center} cy={layout.center} r={ring.r} />
            )}
            <rect
              className="cring-label-bg"
              x={layout.center - (ring.name.length * 3 + 7)}
              y={layout.center - ring.r - 7}
              width={ring.name.length * 6 + 14}
              height={14}
            />
            <text className="cring-label" x={layout.center} y={layout.center - ring.r + 3}>
              {ring.name}
            </text>
          </g>
        ))}

        {/* One band per vertical, and a click target for opening it. */}
        {layout.wedges.map((wedge) => {
          const label = bandLabel(wedge, layout.center, layout.bandInner, layout.bandOuter)
          return (
            <g
              key={wedge.key}
              className={`cband ${wedge.groupId ? 'is-openable' : ''}`}
              onClick={() => wedge.groupId && props.onOpenWedge(wedge.groupId)}
            >
              <title>
                {wedge.groupId
                  ? `Open ${wedge.name} — ${wedge.count} people`
                  : `${wedge.name} — ${wedge.count} people`}
              </title>
              <path
                className="cband-arc"
                fill={wedge.accent}
                d={bandPath(wedge, layout.center, layout.bandInner, layout.bandOuter)}
              />
              <text
                className="cband-label"
                fill={wedge.accent}
                x={label.x}
                y={label.y}
                transform={`rotate(${label.rotate.toFixed(1)} ${label.x.toFixed(1)} ${label.y.toFixed(1)})`}
              >
                {wedge.name} · {wedge.count}
              </text>
            </g>
          )
        })}

        {/* The firm ties to each lead; the leadership ring ties them to
            each other. Neither is a reporting line. */}
        {layout.wedges.map((wedge) => {
          const spoke = spokePath(
            wedge,
            layout.center,
            layout.centerRadius + 6,
            layout.leadershipRadius - 40,
          )
          return (
            <line
              key={wedge.key}
              className="cspoke"
              stroke={wedge.accent}
              x1={spoke.x1}
              y1={spoke.y1}
              x2={spoke.x2}
              y2={spoke.y2}
            />
          )
        })}

        <circle
          className="cleadership-ring"
          cx={layout.center}
          cy={layout.center}
          r={layout.leadershipRadius}
        />

        <circle
          className="ccenter-disc"
          cx={layout.center}
          cy={layout.center}
          r={layout.centerRadius}
        />
        <text className="ccenter-mark" x={layout.center} y={layout.center - 20}>
          CriticalArc
        </text>
        <text className="ccenter-num" x={layout.center} y={layout.center + 14}>
          {layout.nodes.length}
        </text>
        <text className="ccenter-unit" x={layout.center} y={layout.center + 34}>
          {layout.nodes.length === 1 ? 'Person' : 'People'}
        </text>

        {layout.links.map((link) => {
          const childId = link.id.split('->')[1]
          const child = layout.byId.get(childId)
          if (!child || !visible(child)) return null
          return (
            <path
              key={link.id}
              className={`clink ${isLit(childId) ? 'is-lit' : ''}`}
              stroke={child.accent}
              d={link.path}
            />
          )
        })}

        {layout.nodes.filter(visible).map((node) => (
          <Node
            key={node.id}
            node={node}
            lit={isLit(node.id)}
            selected={props.selectedId === node.id}
            isViewer={props.viewerIds.has(node.id)}
            showName={node.ring < TEAM_RING || props.showTeamNames}
            onSelect={props.onSelect}
            onHover={setHoverId}
          />
        ))}
      </svg>
    </div>
  )
}

type NodeProps = {
  node: CircleNode
  lit: boolean
  selected: boolean
  isViewer: boolean
  showName: boolean
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
}

function Node({ node, lit, selected, isViewer, showName, ...handlers }: NodeProps) {
  // The signed URL is minted after the chart is already on screen, and can
  // expire mid-session. Initials sit underneath either way, so a photo that
  // never arrives just leaves them showing.
  const [photoFailed, setPhotoFailed] = useState(false)
  const showPhoto = node.hasDisc && node.photoUrl && !photoFailed
  const { label } = node

  const classes = [
    'cnode',
    `is-ring-${node.ring}`,
    lit && 'is-lit',
    selected && 'is-selected',
    node.vacant && 'is-vacant',
    node.stale && 'is-stale',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <g
      className={classes}
      onClick={() => handlers.onSelect(node.id)}
      onPointerEnter={() => handlers.onHover(node.id)}
      onPointerLeave={() => handlers.onHover(null)}
    >
      <title>{node.title ? `${node.name} — ${node.title}` : node.name}</title>

      {node.hasDisc ? (
        <>
          <circle className="cavatar" cx={node.x} cy={node.y} r={node.size} stroke={node.accent} />
          <text
            className="cavatar-initials"
            x={node.x}
            y={node.y}
            fontSize={Math.round(node.size * 0.78)}
          >
            {node.vacant ? '+' : initials(node.name)}
          </text>
          {showPhoto && (
            <image
              href={node.photoUrl as string}
              x={node.x - node.size}
              y={node.y - node.size}
              width={node.size * 2}
              height={node.size * 2}
              clipPath={`url(#circle-clip-${node.id})`}
              preserveAspectRatio="xMidYMid slice"
              onError={() => setPhotoFailed(true)}
            />
          )}
        </>
      ) : (
        <circle className="cdot" cx={node.x} cy={node.y} r={node.size} fill={node.accent} />
      )}

      {isViewer && <circle className="cmarker is-you" cx={node.x} cy={node.y} r={node.size + 4} />}
      {node.stale && <circle className="cmarker is-stale" cx={node.x} cy={node.y} r={node.size + 4} />}
      {node.vacant && <circle className="cmarker is-vacant" cx={node.x} cy={node.y} r={node.size + 4} />}

      {showName && label.mode === 'chip' && (
        <>
          <text className="clabel is-lead" x={label.x} y={label.y}>
            {node.name}
          </text>
          {node.title && (
            <text className="clabel is-lead-role" x={label.x} y={label.y + 16}>
              {node.title}
            </text>
          )}
        </>
      )}

      {showName && label.mode !== 'chip' && (
        <text
          className={`clabel ${label.mode === 'radial' ? 'is-leaf' : 'is-manager'}`}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
          dominantBaseline="middle"
          transform={`rotate(${label.rotate.toFixed(1)} ${label.x.toFixed(1)} ${label.y.toFixed(1)})`}
        >
          {node.name}
        </text>
      )}

      <circle className="chit" cx={node.x} cy={node.y} r={Math.max(node.size, 13)} />
    </g>
  )
}
