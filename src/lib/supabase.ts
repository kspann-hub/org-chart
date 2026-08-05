import { createClient } from '@supabase/supabase-js'

const rawUrl = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

if (!rawUrl || !anonKey) {
  throw new Error(
    'Missing Supabase config. Copy .env.example to .env and fill it in ' +
      '(or set the VITE_SUPABASE_* repository secrets if this is a deploy).',
  )
}

/**
 * The client wants the bare project origin. Supabase's Data API settings page
 * shows both a "Project URL" and a "RESTful endpoint" ending in /rest/v1, and
 * pasting the latter produces requests to /rest/v1/auth/v1/authorize — which
 * fails with a confusing "No API key found in request". Normalise instead of
 * relying on people picking the right one.
 */
function projectOrigin(value: string): string {
  const cleaned = value.trim().replace(/\/+$/, '')
  try {
    return new URL(cleaned).origin
  } catch {
    throw new Error(`VITE_SUPABASE_URL is not a valid URL: "${value}"`)
  }
}

const url = projectOrigin(rawUrl)

export const supabase = createClient(url, anonKey, {
  auth: {
    // Magic links come back as a hash fragment on the page URL; let the
    // client consume it and then clean up after itself.
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
})
