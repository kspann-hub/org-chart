import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = createRoot(document.getElementById('root') as HTMLElement)

// /?fixture draws the chart from a synthetic firm instead of Supabase, so the
// view code can be worked on while the project is behind its egress block.
// DEV-guarded and dynamically imported, so it never reaches the deployed
// bundle — same reasoning as the backfill below.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) {
  void import('./dev/Fixture').then(({ Fixture }) =>
    root.render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    ),
  )
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

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
