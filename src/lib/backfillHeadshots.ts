/**
 * One-time cleanup for headshots uploaded before uploadHeadshot began
 * downscaling them.
 *
 * The bucket holds 78 camera originals averaging ~724 KB (largest 4.5 MB), and
 * the chart never displays more than 112 pixels of any of them. Re-encoding
 * them to the same 256px WebP a new upload now produces cuts each to ~20 KB.
 *
 * WHY THIS RUNS IN THE BROWSER
 *
 *     Rewriting storage objects needs admin rights. This project deliberately
 *     keeps the `service_role` key out of the repo (see .env.example), so there
 *     is no credential a Node script could use. A signed-in admin already has
 *     exactly the rights required via the headshots_insert / _update / _delete
 *     policies, and already has a browser that can decode and re-encode images
 *     — so the work happens there, reusing shrinkHeadshot unchanged.
 *
 * HOW TO RUN IT
 *
 *     npm run dev, sign in as an admin, then in the devtools console:
 *
 *         await __backfillHeadshots()            // do it
 *         await __backfillHeadshots({ dryRun: true })   // just report
 *
 *     It is safe to re-run: anything already at or under the target size is
 *     skipped, so a second pass reports every seat as skipped and changes
 *     nothing.
 *
 * ORDER OF OPERATIONS
 *
 *     Upload the new object, point the row at it, and only then delete the old
 *     one — the same order onPickPhoto uses. A failure part way through leaves
 *     the seat showing a working photo, never a broken one. The originals are
 *     gone afterwards, which is the point; the chart has no use for them and
 *     they are what the egress was being spent on.
 */

import { supabase } from './supabase'
import {
  HEADSHOT_BUCKET,
  HEADSHOT_CACHE_CONTROL,
  HEADSHOT_PX,
  shrinkHeadshot,
} from './photos'

type Options = {
  /** Report what would change without writing anything. */
  dryRun?: boolean
}

type Outcome = {
  seats: number
  converted: number
  skipped: number
  failed: number
  bytesBefore: number
  bytesAfter: number
  orphans: number
}

/** Anything this small is already fine — a 256px WebP lands well under it. */
const ALREADY_SMALL_BYTES = 60_000

export async function backfillHeadshots(options: Options = {}): Promise<Outcome> {
  const dryRun = options.dryRun ?? false

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_org_admin')
  if (adminError) throw new Error(`Couldn't check admin rights: ${adminError.message}`)
  if (isAdmin !== true) {
    throw new Error('Only an org admin can rewrite headshots. Sign in as one and retry.')
  }

  const { data: seats, error: seatError } = await supabase
    .from('org_positions')
    .select('id, photo_path')
    .not('photo_path', 'is', null)

  if (seatError) throw new Error(`Couldn't read seats: ${seatError.message}`)

  const rows = (seats ?? []) as Array<{ id: string; photo_path: string }>
  const outcome: Outcome = {
    seats: rows.length,
    converted: 0,
    skipped: 0,
    failed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    orphans: 0,
  }

  console.log(
    `${rows.length} seat(s) with a photo. Target ${HEADSHOT_PX}px WebP.` +
      (dryRun ? ' DRY RUN — nothing will be written.' : ''),
  )

  // What each seat points at once we are finished — the orphan count below has
  // to compare against these, not the paths we started with.
  const livePaths = new Set(rows.map((r) => r.photo_path))

  for (const [index, row] of rows.entries()) {
    const label = `${index + 1}/${rows.length} ${row.photo_path}`
    try {
      const { data: original, error: downloadError } = await supabase.storage
        .from(HEADSHOT_BUCKET)
        .download(row.photo_path)

      if (downloadError || !original) {
        // The row points at a file that is gone. Leave it alone — the chart
        // already falls back to initials for it.
        console.warn(`${label}: missing in storage, leaving the row as it is`)
        outcome.failed += 1
        continue
      }

      outcome.bytesBefore += original.size

      if (original.size <= ALREADY_SMALL_BYTES) {
        console.log(`${label}: ${kb(original.size)} — already small, skipped`)
        outcome.skipped += 1
        outcome.bytesAfter += original.size
        continue
      }

      const { blob, extension, contentType } = await shrinkHeadshot(original, row.photo_path)
      outcome.bytesAfter += blob.size

      if (dryRun) {
        console.log(`${label}: ${kb(original.size)} -> ${kb(blob.size)} (would convert)`)
        outcome.converted += 1
        continue
      }

      const nextPath = `${row.id}-${Date.now()}.${extension}`

      const { error: uploadError } = await supabase.storage
        .from(HEADSHOT_BUCKET)
        .upload(nextPath, blob, {
          upsert: true,
          contentType,
          cacheControl: HEADSHOT_CACHE_CONTROL,
        })
      if (uploadError) throw new Error(uploadError.message)

      const { error: updateError } = await supabase
        .from('org_positions')
        .update({ photo_path: nextPath })
        .eq('id', row.id)
      if (updateError) {
        // The row still points at the original, so the chart is unharmed. Clear
        // up the object we just wrote rather than leaving it orphaned.
        await supabase.storage.from(HEADSHOT_BUCKET).remove([nextPath])
        throw new Error(updateError.message)
      }

      await supabase.storage.from(HEADSHOT_BUCKET).remove([row.photo_path])
      livePaths.delete(row.photo_path)
      livePaths.add(nextPath)

      console.log(`${label}: ${kb(original.size)} -> ${kb(blob.size)}`)
      outcome.converted += 1
    } catch (e) {
      console.error(`${label}: FAILED — ${e instanceof Error ? e.message : String(e)}`)
      outcome.failed += 1
    }
  }

  outcome.orphans = await countOrphans(livePaths, dryRun)

  console.log(
    `Done. ${outcome.converted} converted, ${outcome.skipped} already small, ` +
      `${outcome.failed} failed. ${kb(outcome.bytesBefore)} -> ${kb(outcome.bytesAfter)} ` +
      `per full chart load.`,
  )
  if (outcome.orphans > 0) {
    console.log(
      `${outcome.orphans} object(s) in the bucket are referenced by no seat. They cost ` +
        'storage but no egress, since nothing fetches them.',
    )
  }
  if (!dryRun && outcome.converted > 0) {
    console.log('Reload the chart to pick up the new paths.')
  }

  return outcome
}

/** Objects in the bucket that no seat points at — left over from replaced
 *  photos before this ran. Reported, never deleted: this function has no way to
 *  know whether something else put them there. */
async function countOrphans(live: Set<string>, dryRun: boolean): Promise<number> {
  if (dryRun) return 0
  const { data, error } = await supabase.storage.from(HEADSHOT_BUCKET).list('', { limit: 1000 })
  if (error || !data) return 0
  return data.filter((o) => !live.has(o.name)).length
}

function kb(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(bytes / 1000)} KB`
}
