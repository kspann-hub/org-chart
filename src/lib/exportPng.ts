import type { Layout, PlacedNode } from './types'
import { AVATAR_SIZE, NODE_H, NODE_W } from './layout'
import { initials } from '../components/Avatar'
import { LINKEDIN_BLUE, LINKEDIN_GLYPH, LINKEDIN_GLYPH_SIZE } from './linkedin'

/**
 * Render the chart to a PNG.
 *
 * Drawn onto a canvas from the layout data rather than screenshotting the
 * DOM. A DOM-to-image library would have to round-trip the whole stylesheet
 * through an SVG foreignObject, which is fragile and blurry; here the node
 * positions are already exact, so the output is deterministic and can be
 * rendered at any scale.
 */

const PADDING = 56
const TITLE_H = 64
const BG = '#161719'
const CARD_TOP = 26

type Options = {
  title: string
  subtitle?: string
  accentOf: (id: string) => string | null
  /** 2 gives a crisp image on high-DPI screens and when scaled into a deck. */
  scale?: number
}

export async function exportChartPng(layout: Layout, options: Options): Promise<Blob> {
  const scale = options.scale ?? 2
  const width = layout.width + PADDING * 2
  const height = layout.height + PADDING * 2 + TITLE_H

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get a 2D canvas context.')
  ctx.scale(scale, scale)

  ctx.fillStyle = BG
  ctx.fillRect(0, 0, width, height)

  // Heading
  ctx.fillStyle = '#eceef1'
  ctx.font = '600 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillText(options.title, PADDING, PADDING - 24)
  if (options.subtitle) {
    ctx.fillStyle = '#9aa1ac'
    ctx.font = '13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    ctx.fillText(options.subtitle, PADDING, PADDING + 6)
  }

  ctx.save()
  ctx.translate(PADDING, PADDING + TITLE_H)

  // Connectors first, so cards sit on top of them.
  ctx.strokeStyle = '#43474e'
  ctx.lineWidth = 1.5
  for (const link of layout.links) {
    // Path2D parses SVG path syntax, so the exact same geometry the screen
    // uses is reused here rather than being re-derived.
    ctx.stroke(new Path2D(link.path))
  }

  const photos = await loadPhotos(layout.nodes)
  for (const node of layout.nodes) {
    drawNode(ctx, node, options.accentOf(node.id) ?? '#2f5fd0', photos.get(node.id) ?? null)
  }

  ctx.restore()

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('The browser refused to encode the image.')),
      'image/png',
    )
  })
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: PlacedNode,
  accent: string,
  photo: HTMLImageElement | null,
) {
  const cardTop = node.y + (node.title ? CARD_TOP : 32)
  const cardH = node.y + NODE_H - cardTop

  ctx.beginPath()
  ctx.roundRect(node.x, cardTop, NODE_W, cardH, 12)
  if (node.vacant) {
    ctx.strokeStyle = '#43474e'
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.stroke()
    ctx.setLineDash([])
  } else {
    ctx.fillStyle = accent
    ctx.fill()
  }

  const centreX = node.x + NODE_W / 2
  const textTop = node.title ? cardTop + cardH / 2 - 16 : cardTop + cardH / 2 - 8

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = node.vacant ? '#9aa1ac' : '#ffffff'
  ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(ellipsize(ctx, node.name, NODE_W - 20), centreX, textTop)

  if (node.title) {
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    ctx.font = '11.5px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    ctx.fillText(ellipsize(ctx, node.title, NODE_W - 20), centreX, textTop + 18)
  }

  // Avatar, drawn last so it overlaps the top edge of the card.
  const r = AVATAR_SIZE / 2
  const cy = node.y + r

  ctx.save()
  ctx.beginPath()
  ctx.arc(centreX, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = '#3a3d43'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = BG
  ctx.stroke()
  ctx.clip()

  if (photo) {
    ctx.drawImage(photo, centreX - r, cy - r, AVATAR_SIZE, AVATAR_SIZE)
  } else {
    ctx.fillStyle = '#9aa1ac'
    ctx.font = '600 15px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(node.vacant ? '+' : initials(node.name), centreX, cy)
    ctx.textBaseline = 'top'
  }
  ctx.restore()

  if (node.linkedinUrl) drawLinkedInBadge(ctx, centreX + r, node.y + AVATAR_SIZE)
}

/**
 * The same badge the chart shows, at the bottom-right of the headshot.
 * `(edgeX, edgeY)` is that corner of the avatar; the badge straddles it, as
 * the negative offsets in the stylesheet do on screen.
 */
function drawLinkedInBadge(ctx: CanvasRenderingContext2D, edgeX: number, edgeY: number) {
  const size = 18
  const x = edgeX - size + 3
  const y = edgeY - size + 1

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, size, size, 5)
  ctx.fillStyle = LINKEDIN_BLUE
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = BG
  ctx.stroke()

  // The glyph is drawn in its own 448-unit space, so it is scaled rather than
  // redrawn at this size — same shape as the SVG on screen.
  const glyph = 9
  ctx.translate(x + (size - glyph) / 2, y + (size - glyph) / 2)
  ctx.scale(glyph / LINKEDIN_GLYPH_SIZE, glyph / LINKEDIN_GLYPH_SIZE)
  ctx.fillStyle = '#ffffff'
  ctx.fill(new Path2D(LINKEDIN_GLYPH))
  ctx.restore()
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let cut = text
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return `${cut}…`
}

/**
 * Load the headshots so they can be drawn.
 *
 * crossOrigin is essential: an image drawn from another origin without CORS
 * headers taints the canvas, and toBlob() then throws a SecurityError that
 * would fail the whole export. A photo that won't load is skipped and the
 * card falls back to initials — a chart missing a face beats no chart.
 */
async function loadPhotos(nodes: PlacedNode[]): Promise<Map<string, HTMLImageElement>> {
  const withPhotos = nodes.filter((n) => n.photoUrl)
  const loaded = new Map<string, HTMLImageElement>()

  await Promise.all(
    withPhotos.map(
      (node) =>
        new Promise<void>((resolve) => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            loaded.set(node.id, img)
            resolve()
          }
          img.onerror = () => resolve()
          img.src = node.photoUrl as string
        }),
    ),
  )

  return loaded
}

/** Hand the blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
