import type { HistoryEntry, SeatSource } from './types'

/**
 * Turn a logged edit into something an admin can read at a glance.
 *
 * The log stores whole rows, so working out what actually changed is done
 * here rather than in Postgres — it keeps the trigger cheap and lets the
 * wording resolve seat ids to the names currently on the chart.
 */

/** Human labels for the columns worth mentioning. Anything absent is noise. */
const FIELDS: Record<string, string> = {
  parent_id: 'reporting line',
  employee_key: 'person',
  name_override: 'name',
  title_override: 'title',
  show_title: 'title visibility',
  sort_order: 'position among siblings',
  photo_path: 'photo',
  linkedin_url: 'LinkedIn link',
}

export function changedFields(entry: HistoryEntry): string[] {
  if (entry.action !== 'update' || !entry.before_row || !entry.after_row) return []
  return Object.keys(FIELDS).filter(
    (key) => String(entry.before_row?.[key] ?? '') !== String(entry.after_row?.[key] ?? ''),
  )
}

/**
 * @param nameFor resolves a seat id to its current display name. Returns null
 *   for seats that have since been deleted, which the wording handles.
 */
export function describeChange(
  entry: HistoryEntry,
  nameFor: (id: string | null) => string | null,
): string {
  const who = entry.label ?? 'a seat'

  if (entry.action === 'insert') return `Added ${who}`
  if (entry.action === 'delete') return `Deleted ${who}`

  const fields = changedFields(entry)
  if (fields.length === 0) return `Edited ${who}`

  // A move is the change most likely to be a mistake — it's the one you can
  // cause by dragging — so it gets named explicitly rather than lumped in.
  if (fields.includes('parent_id')) {
    const from = manager(entry.before_row?.parent_id, nameFor)
    const to = manager(entry.after_row?.parent_id, nameFor)
    const rest = fields.filter((f) => f !== 'parent_id')
    const moved = `Moved ${who} from ${from} to ${to}`
    return rest.length ? `${moved}, and changed ${list(rest)}` : moved
  }

  return `Changed ${list(fields)} on ${who}`
}

/**
 * No parent genuinely means the top of the chart. A parent id that no longer
 * resolves means the manager's seat has since been deleted — saying "the top"
 * there would describe a move that never happened.
 */
function manager(id: unknown, nameFor: (id: string | null) => string | null): string {
  if (id === null || id === undefined || id === '') return 'the top'
  return nameFor(String(id)) ?? 'a seat since deleted'
}

function list(fields: string[]): string {
  const names = fields.map((f) => FIELDS[f] ?? f)
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Someone who gained a seat recently, ready to list. */
export type Addition = {
  /** The history entry this came from, so it can key a list. */
  id: string
  name: string
  /** Null for seats added before org_positions.source existed. */
  origin: SeatSource | null
  by: string
  at: string
}

export const ADDED_WINDOW_HOURS = 24

/**
 * Who has been added lately.
 *
 * "Added" is an insert that still stands — an addition that was undone is
 * left out, because the seat isn't there any more and listing it would send
 * someone looking for a box that doesn't exist.
 *
 * A sync adds everyone in one go, so several entries usually share a
 * timestamp to the second. They're kept in log order rather than being
 * grouped: the panel is short, and the list reads as one batch anyway.
 */
export function recentAdditions(
  entries: HistoryEntry[],
  hours: number = ADDED_WINDOW_HOURS,
  now: number = Date.now(),
): Addition[] {
  const cutoff = now - hours * 3_600_000

  return entries
    .filter(
      (e) =>
        e.action === 'insert' &&
        !e.undone_at &&
        new Date(e.changed_at).getTime() >= cutoff,
    )
    .map((e) => ({
      id: e.id,
      name: e.label ?? 'A seat',
      origin: seatSource(e.after_row?.source),
      by: e.changed_by ?? 'someone',
      at: e.changed_at,
    }))
}

function seatSource(value: unknown): SeatSource | null {
  return value === 'manual' || value === 'ajera' ? value : null
}

/** "3 minutes ago" — the log is only ever read for recent things. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`

  const days = Math.round(hours / 24)
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`

  return new Date(iso).toLocaleDateString()
}
