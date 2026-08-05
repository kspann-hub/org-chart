import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { ALLOWED_DOMAIN, isCompanyEmail } from '../lib/config'

/** Where Supabase should send people back to after they authenticate. Must
 *  also be listed under Authentication -> URL Configuration -> Redirect URLs. */
const returnTo = () => window.location.origin + window.location.pathname

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-2.7-.4-4H24v7.3h12.1c-.2 1.9-1.6 4.9-4.5 6.9l6.9 5.4c4.1-3.8 6.6-9.4 6.6-15.6z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8.1 41.1 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z"
      />
      <path
        fill="#EA4335"
        d="M24 10.5c4.1 0 6.9 1.8 8.5 3.3l6.1-6C34.9 4.4 29.9 2 24 2 15.4 2 8.1 6.9 4.4 14.1l7.1 5.5c1.8-5.3 6.7-9.1 12.5-9.1z"
      />
    </svg>
  )
}

export function Login() {
  const [showEmail, setShowEmail] = useState(false)
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function signInWithGoogle() {
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: returnTo(),
        // Nudges Google's account chooser toward company accounts. It is a
        // hint, not a restriction — a personal account can still get through
        // it, and gets stopped by RLS instead.
        queryParams: { hd: ALLOWED_DOMAIN.replace('@', '') },
      },
    })
    if (error) setError(error.message)
  }

  async function sendMagicLink(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    // The database refuses non-company addresses anyway, but failing here
    // means a typo gets an answer now rather than an email that signs you
    // into an empty chart.
    if (!isCompanyEmail(email)) {
      setError(`Use your ${ALLOWED_DOMAIN} address.`)
      return
    }

    setState('sending')
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: returnTo() },
    })

    if (error) {
      setError(error.message)
      setState('idle')
      return
    }
    setState('sent')
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Org Chart</h1>

        {state === 'sent' ? (
          <>
            <p className="login-lede">
              Check your inbox. We sent a sign-in link to <strong>{email}</strong>.
            </p>
            <p className="login-note">
              The link opens this page already signed in. It expires in about an hour,
              and it only works once.
            </p>
            <button className="btn-quiet" onClick={() => setState('idle')}>
              Back
            </button>
          </>
        ) : (
          <>
            <p className="login-lede">Sign in with your company Google account.</p>

            <button className="btn-google" onClick={() => void signInWithGoogle()}>
              <GoogleMark />
              Sign in with Google
            </button>

            {showEmail ? (
              <form onSubmit={sendMagicLink}>
                <input
                  type="email"
                  value={email}
                  autoFocus
                  required
                  placeholder={`you${ALLOWED_DOMAIN}`}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <button className="btn-quiet" type="submit" disabled={state === 'sending'}>
                  {state === 'sending' ? 'Sending…' : 'Email me a link instead'}
                </button>
              </form>
            ) : (
              <button className="btn-link" onClick={() => setShowEmail(true)}>
                Use an email link instead
              </button>
            )}

            {error && <p className="login-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Shown when someone completes sign-in with an account outside the company.
 * Without this they'd land on a chart with nothing in it — technically
 * correct, since RLS returns no rows, but it reads as a broken app.
 */
export function WrongAccount({ email }: { email: string }) {
  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Wrong account</h1>
        <p className="login-lede">
          You're signed in as <strong>{email}</strong>, which isn't a{' '}
          {ALLOWED_DOMAIN} address. The chart is only visible to company accounts.
        </p>
        <button className="btn-primary" onClick={() => void supabase.auth.signOut()}>
          Sign out and try again
        </button>
      </div>
    </div>
  )
}
