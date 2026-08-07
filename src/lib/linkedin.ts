/**
 * LinkedIn profile links.
 *
 * Stored per seat on org_positions.linkedin_url, alongside photo_path — a
 * seat, not a person, is what the chart draws, and a placeholder seat with no
 * Ajera record can still have a link.
 */

/** The "in" letters, in a 448-unit square. Scale it to whatever size you need. */
export const LINKEDIN_GLYPH =
  'M100.28 448H7.4V148.9h92.88zM53.79 108.1C24.09 108.1 0 83.5 0 53.8a53.79 53.79 0 0 1 ' +
  '107.58 0c0 29.7-24.1 54.3-53.79 54.3zM447.9 448h-92.68V302.4c0-34.7-.7-79.2-48.29-79.2-48.29 ' +
  '0-55.69 37.7-55.69 76.7V448h-92.78V148.9h89.08v40.8h1.3c12.4-23.5 42.69-48.3 87.88-48.3 94 0 ' +
  '111.28 61.9 111.28 142.3V448z'

export const LINKEDIN_GLYPH_SIZE = 448

/** LinkedIn's brand blue, used for the badge on the chart and in the PNG. */
export const LINKEDIN_BLUE = '#0a66c2'

const PROFILE = /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\/.+/i

/**
 * Clean up whatever an admin pasted, or say why it can't be used.
 *
 * Accepts a full URL, one without the scheme, or a bare `linkedin.com/in/...`,
 * and throws with a readable message otherwise. Returns null for an empty box,
 * which is how a link gets removed.
 */
export function normaliseLinkedIn(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  const withScheme = /^https?:\/\//i.test(value)
    ? value
    : `https://${value.replace(/^\/+/, '')}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(
      'That is not a web address. Paste the whole link, e.g. https://www.linkedin.com/in/jane-doe',
    )
  }

  const host = url.hostname.toLowerCase()
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
    throw new Error(
      'That is not a LinkedIn address. It should start with https://www.linkedin.com/',
    )
  }

  // Trailing slash and the ?utm_… tail LinkedIn's own share button adds are
  // noise; keep just the profile so two people pasting the same profile store
  // the same string.
  const path = url.pathname.replace(/\/+$/, '')
  if (path.length < 2) {
    throw new Error(
      'That is only the LinkedIn home page. Open the person’s profile and copy that address.',
    )
  }

  return `https://${host}${path}`
}

/**
 * The value to put in an href, or null.
 *
 * The database has the same rule as a CHECK constraint, so this is a second
 * line rather than the only one — but it means a row edited by hand in the SQL
 * editor can never put a `javascript:` URL behind a link on the chart.
 */
export function linkedInHref(stored: string | null): string | null {
  if (!stored) return null
  return PROFILE.test(stored) ? stored : null
}
