import { supabase } from './supabase'

export const HEADSHOT_BUCKET = 'headshots'

/** An hour is comfortably longer than anyone keeps the tab open, and short
 *  enough that a leaked URL stops working the same day. */
const SIGNED_URL_TTL_SECONDS = 3600

/**
 * Mint signed URLs for headshots.
 *
 * The bucket is private, so there is no permanent public URL to store — a
 * path in the database plus a short-lived signed link is what keeps photos
 * invisible to anyone who isn't signed in.
 *
 * Returns path -> URL. Paths that fail (deleted file, bucket missing) are
 * simply absent, and the caller falls back to initials.
 */
export async function signPhotoPaths(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))]
  const urls = new Map<string, string>()
  if (unique.length === 0) return urls

  const { data, error } = await supabase.storage
    .from(HEADSHOT_BUCKET)
    .createSignedUrls(unique, SIGNED_URL_TTL_SECONDS)

  // A missing bucket shouldn't take the whole chart down with it.
  if (error || !data) return urls

  for (const row of data) {
    if (row.signedUrl && row.path) urls.set(row.path, row.signedUrl)
  }
  return urls
}

/**
 * Upload a headshot for a seat and return its storage path.
 *
 * The filename carries a timestamp because browsers cache images by URL and
 * an admin replacing a photo expects to see the new one immediately.
 */
export async function uploadHeadshot(positionId: string, file: File): Promise<string> {
  const extension = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `${positionId}-${Date.now()}.${extension || 'jpg'}`

  const { error } = await supabase.storage
    .from(HEADSHOT_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined })

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
