/**
 * The company email domain.
 *
 * This is a UI convenience only — it prefills hints, filters the Google
 * account chooser, and gives a clear message to someone who signs in with the
 * wrong account. The actual enforcement is `public.org_email_allowed()` in
 * Postgres, which every RLS policy calls. Changing this constant alone grants
 * nobody anything; change the SQL function too.
 */
export const ALLOWED_DOMAIN = '@criticalarccx.com'

export function isCompanyEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase().endsWith(ALLOWED_DOMAIN)
}
