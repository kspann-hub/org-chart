import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The one-time headshot backfill, reachable from the devtools console. Kept
// behind import.meta.env.DEV and loaded dynamically so it never reaches the
// deployed bundle — it rewrites storage objects and deletes the originals, which
// is not something a published page should hand to whoever opens a console.
if (import.meta.env.DEV) {
  void import('./lib/backfillHeadshots').then(({ backfillHeadshots }) => {
    ;(window as unknown as Record<string, unknown>).__backfillHeadshots = backfillHeadshots
    console.log(
      'Dev build. Signed in as an admin, run:\n' +
        '  await __backfillHeadshots({ dryRun: true })   // preview\n' +
        '  await __backfillHeadshots()                   // convert',
    )
  })
}
