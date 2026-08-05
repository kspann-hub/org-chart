import type { ChartNode } from '../lib/types'

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

type Props = {
  node: ChartNode
  size: number
  title?: string
}

/** Headshot if there is one, initials otherwise. Vacant seats get a plus. */
export function Avatar({ node, size, title }: Props) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.34) }

  if (node.photoUrl) {
    return (
      <img
        className="avatar"
        style={style}
        src={node.photoUrl}
        alt={node.name}
        title={title}
        // A signed URL that expired mid-session shouldn't leave a broken-image
        // icon on the chart; drop back to the initials underneath.
        onError={(e) => {
          e.currentTarget.style.display = 'none'
        }}
      />
    )
  }

  return (
    <span className="avatar" style={style} title={title} aria-hidden="true">
      {node.vacant ? '+' : initials(node.name)}
    </span>
  )
}
