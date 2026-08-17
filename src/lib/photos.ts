import { supabase } from './supabase'

export const HEADSHOT_BUCKET = 'headshots'

/**
 * Longest edge of a stored headshot.
 *
 * Nothing ever displays one larger than this. The chart cards draw avatars at
 * AVATAR_SIZE (44px), the edit panel at 56px, and the PNG export runs the whole
 * canvas at 2x — so 112px is the biggest any caller actually asks for. 256
 * leaves room for a retina screen and for AVATAR_SIZE to grow, and still lands
 * around 20 KB per photo instead of the ~724 KB a phone camera produces.
 */
export const HEADSHOT_PX = 256

const HEADSHOT_QUALITY = 0.82

/**
 * A year. A stored path never changes content (uploadHeadshot timestamps every
 * filename), so there is nothing to invalidate — and without this Storage
 * defaults to an hour, which throws away almost every chance of a CDN hit.
 */
export const HEADSHOT_CACHE_CONTROL = '31536000'

/**
 * How long a minted signed URL stays valid.
 *
 * Long enough for Supabase's CDN to be worth anything. The CDN keys its cache
 * on the entire URL including the token, so a freshly minted token is always a
 * miss and always billed as uncached egress — which is how 78 photos became
 * ~19 GB of it in a month. Combined with the reuse cache below, the second and
 * later views of a face become CDN hits instead.
 *
 * A leaked URL still stops working the same day, which is the property the
 * original one-hour TTL was picked for.
 */
const SIGNED_URL_TTL_SECONDS = 86_400

/** Re-mint once a URL is within an hour of expiring, so none goes stale while
 *  someone still has the tab open. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000

const CACHE_KEY = 'orgchart.photoUrls.v1'

type CachedUrl = { url: string; expiresAt: number }

/**
 * path -> signed URL, kept across reloads.
 *
 * Two jobs. Within a session it stops `load()` from re-minting every URL on
 * every realtime edit, which used to hand each <img> a brand new src and
 * re-download the entire company. Across sessions it means a returning viewer
 * asks for the *same* URL, which is the only way the CDN can answer instead of
 * the origin.
 */
const urlCache = new Map<string, CachedUrl>()
let cacheHydrated = false

function hydrateCache(): void {
  if (cacheHydrated) return
  cacheHydrated = true
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return
    const stored = JSON.parse(raw) as Record<string, CachedUrl>
    for (const [path, entry] of Object.entries(stored)) {
      if (entry && typeof entry.url === 'string' && typeof entry.expiresAt === 'number') {
        urlCache.set(path, entry)
      }
    }
  } catch {
    // A corrupt or unreadable cache just means we mint fresh URLs. Not fatal.
  }
}

function persistCache(): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(urlCache)))
  } catch {
    // Private mode, or quota exceeded. Minting still works; only reuse is lost.
  }
}

function isFresh(entry: CachedUrl | undefined, now: number): entry is CachedUrl {
  return Boolean(entry && entry.expiresAt - REFRESH_MARGIN_MS > now)
}

/**
 * Mint signed URLs for headshots, reusing any that are still good.
 *
 * The bucket is private, so there is no permanent public URL to store — a path
 * in the database plus a signed link is what keeps photos invisible to anyone
 * who isn't signed in.
 *
 * Returns path -> URL. Paths that fail (deleted file, bucket missing) are
 * simply absent, and the caller falls back to initials.
 */
export async function signPhotoPaths(paths: string[]): Promise<Map<string, string>> {
  hydrateCache()
  const now = Date.now()

  const unique = [...new Set(paths.filter(Boolean))]
  const urls = new Map<string, string>()
  if (unique.length === 0) return urls

  const stale: string[] = []
  for (const path of unique) {
    const cached = urlCache.get(path)
    if (isFresh(cached, now)) urls.set(path, cached.url)
    else stale.push(path)
  }

  // The common case once warm: every face already has a live URL, so this makes
  // no request at all. That matters because load() runs on mount, after every
  // mutation, and on every realtime change to org_positions.
  if (stale.length === 0) return urls

  const { data, error } = await supabase.storage
    .from(HEADSHOT_BUCKET)
    .createSignedUrls(stale, SIGNED_URL_TTL_SECONDS)

  // A missing bucket shouldn't take the whole chart down with it.
  if (error || !data) return urls

  const expiresAt = now + SIGNED_URL_TTL_SECONDS * 1000
  for (const row of data) {
    if (row.signedUrl && row.path) {
      urls.set(row.path, row.signedUrl)
      urlCache.set(row.path, { url: row.signedUrl, expiresAt })
    }
  }

  // Expired entries are dead weight in localStorage — drop them so replacing
  // photos over time can't grow the cache without bound.
  for (const [path, entry] of [...urlCache]) {
    if (entry.expiresAt <= now) urlCache.delete(path)
  }

  persistCache()
  return urls
}

/**
 * Upload a headshot for a seat and return its storage path.
 *
 * The image is centre-cropped and downscaled before it leaves the browser.
 * Storing the camera original was the single largest cost in this project: 78
 * photos averaging 724 KB, re-fetched on every chart load, accounted for
 * essentially all of ~19 GB of Supabase egress in one month — while the chart
 * never displayed more than 112 of those pixels. Supabase can do this
 * server-side with Storage Image Transformations, but that is a paid feature and
 * this project is on the free plan, so it happens here.
 *
 * The filename carries a timestamp because browsers and the CDN cache images by
 * URL, and an admin replacing a photo expects to see the new one immediately.
 * That immutability is also what makes the long cacheControl below safe.
 */
export async function uploadHeadshot(positionId: string, file: File): Promise<string> {
  const { blob, extension, contentType } = await shrinkHeadshot(file, file.name)
  const path = `${positionId}-${Date.now()}.${extension}`

  const { error } = await supabase.storage.from(HEADSHOT_BUCKET).upload(path, blob, {
    upsert: true,
    contentType,
    cacheControl: HEADSHOT_CACHE_CONTROL,
  })

  if (error) {
    throw new Error(
      error.message.toLowerCase().includes('not found')
        ? `Storage bucket "${HEADSHOT_BUCKET}" doesn't exist yet. Create it in ` +
          'Supabase under Storage → New bucket, with Public bucket OFF.'
        : error.message,
    )
  }
  return path
}

/** Best-effort cleanup of a replaced photo. Failure here is not worth
 *  surfacing — the row already points at the new file. */
export async function removeHeadshot(path: string | null): Promise<void> {
  if (!path) return
  await supabase.storage.from(HEADSHOT_BUCKET).remove([path])
}

/**
 * Decode, centre-crop to a square, and re-encode small.
 *
 * Cropping rather than squashing matches the `object-fit: cover` the chart
 * already applies on screen, and it fixes the PNG export as a side effect —
 * exportPng draws into a fixed AVATAR_SIZE box, which stretched a portrait
 * photo into the round avatar.
 */
export async function shrinkHeadshot(
  source: Blob,
  label: string,
): Promise<{ blob: Blob; extension: string; contentType: string }> {
  const bitmap = await decodeImage(source, label)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const target = Math.min(HEADSHOT_PX, side)

    const canvas = document.createElement('canvas')
    canvas.width = target
    canvas.height = target

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D canvas context to resize the photo.')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      target,
      target,
    )

    // WebP runs roughly 30% smaller than JPEG at matched quality. A browser
    // that can't encode it hands back a PNG from toBlob regardless of the type
    // asked for, and a PNG headshot is larger than the JPEG — so check what
    // actually came back rather than trusting the request.
    const webp = await encodeCanvas(canvas, 'image/webp', HEADSHOT_QUALITY)
    if (webp?.type === 'image/webp') {
      return { blob: webp, extension: 'webp', contentType: 'image/webp' }
    }

    const jpeg = await encodeCanvas(canvas, 'image/jpeg', HEADSHOT_QUALITY)
    if (jpeg?.type === 'image/jpeg') {
      return { blob: jpeg, extension: 'jpg', contentType: 'image/jpeg' }
    }

    throw new Error('The browser could not re-encode that image. Try a JPEG or PNG.')
  } finally {
    bitmap.close()
  }
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * Decode to an ImageBitmap.
 *
 * A format the browser can't decode — HEIC straight off an iPhone is the one
 * that turns up — is refused here rather than uploaded as-is. A file the
 * browser cannot decode is also one it cannot draw on the chart, so passing it
 * through would store a large object that never renders.
 */
async function decodeImage(source: Blob, label: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(source)
  } catch {
    throw new Error(
      `Couldn't read "${label}". Save it as a JPEG or PNG and try again — ` +
        'HEIC files from an iPhone need converting first.',
    )
  }
}
