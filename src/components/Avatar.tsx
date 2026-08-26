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
        width={size}
        height={size}
        // The chart lays out every seat in the company, but most of them are
        // scrolled well out of view — and a face nobody looks at should not be
        // fetched. Together with the URL reuse in lib/photos, this is what stops
        // panning around the chart from pulling all 78 headshots.
        loading="lazy"
        decoding="async"
        // Shares one browser cache entry with the PNG export, which has to set
        // this to keep the canvas untainted. Browsers file CORS and non-CORS
        // responses separately, so without it an export re-downloads every
        // face the chart is already showing.
        crossOrigin="anonymous"
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
