import { useState } from 'react'
import type { HistoryEntry, SyncResult } from '../lib/types'
import {
  ADDED_WINDOW_HOURS,
  changeKind,
  dayBucket,
  describeChangeParts,
  insertedSource,
  recentAdditions,
  when,
  type ChangeKind,
} from '../lib/history'
import { IconArrowRight, IconPencil, IconPlus, IconSync, IconTrash } from './Icons'

type Props = {
  entries: HistoryEntry[]
  loading: boolean
  /** Resolves a seat id to its current name; null once a seat is deleted. */
  nameFor: (id: string | null) => string | null
  /** Null while nothing is being undone; otherwise the entry id in flight. */
  undoing: string | null
  onUndo: (entry: HistoryEntry) => void
  onRefresh: () => void
  /** The last sync run from this browser session, if any. */
  lastSync: { result: SyncResult; at: string } | null
  syncing: boolean
  onSync: () => void
}

const FILTERS: Array<{ key: ChangeKind | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'move', label: 'Moves' },
  { key: 'add', label: 'Additions' },
  { key: 'edit', label: 'Edits' },
  { key: 'delete', label: 'Deletions' },
]

const PAGE = 25

const ICONS: Record<ChangeKind, React.ReactNode> = {
  move: <IconArrowRight />,
  add: <IconPlus />,
  edit: <IconPencil />,
  delete: <IconTrash />,
}

/** Every edit to the chart, newest first, with undo. Admins only. */
export function ChangesPage(props: Props) {
  const [filter, setFilter] = useState<ChangeKind | 'all'>('all')
  const [shown, setShown] = useState(PAGE)

  const added = recentAdditions(props.entries)
  const filtered = props.entries.filter((e) => filter === 'all' || changeKind(e) === filter)
  const visible = filtered.slice(0, shown)

  // Group under day headings, keeping log order inside each. Keyed by day
  // rather than by runs, so an out-of-order entry can't repeat a heading.
  const byDay = new Map<string, HistoryEntry[]>()
  for (const e of visible) {
    const day = dayBucket(e.changed_at)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(e)
    else byDay.set(day, [e])
  }
  const days = [...byDay].map(([day, entries]) => ({ day, entries }))

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <p className="eyebrow">Admin</p>
          <h1>Recent changes</h1>
          <p className="lede">
            Every edit to the chart, newest first. Undo puts a change back. Nothing here writes
            to Ajera.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={props.onRefresh} disabled={props.loading}>
            <IconSync />
            {props.loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="split">
        <section className="card log" aria-labelledby="log-h">
          <div className="log-head">
            <h2 id="log-h">Change log</h2>
            <div className="row-wrap" role="group" aria-label="Show">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="chipbtn"
                  aria-pressed={filter === f.key}
                  onClick={() => {
                    setFilter(f.key)
                    setShown(PAGE)
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 && (
            <p className="log-empty">
              {props.entries.length === 0
                ? props.loading
                  ? 'Loading the log…'
                  : 'No edits logged yet. Anything you change from here on shows up in this list.'
                : 'Nothing of that kind in the recent log.'}
            </p>
          )}

          {days.map(({ day, entries }) => (
            <div key={day}>
              <h3 className="log-day">{day}</h3>
              {entries.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  nameFor={props.nameFor}
                  undoing={props.undoing}
                  onUndo={props.onUndo}
                />
              ))}
            </div>
          ))}

          {filtered.length > shown && (
            <div className="log-more">
              <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
                Show older changes
              </button>
            </div>
          )}
        </section>

        <div className="split-side">
          <section className="card pad stack" aria-labelledby="added-h">
            <div className="spread">
              <h2 id="added-h" className="h-sm">
                Added in the last {ADDED_WINDOW_HOURS} hours
              </h2>
              <span className="count-pill">{added.length}</span>
            </div>
            {added.length > 0 && (
              <div className="added-list">
                {added.map((p) => (
                  <div key={p.id} className="added-row">
                    <div className="grow">
                      <p className="strong">{p.name}</p>
                      <p className="meta">
                        {p.by} · {when(p.at)}
                      </p>
                    </div>
                    {p.origin && <SourceTag source={p.origin} />}
                  </div>
                ))}
              </div>
            )}
            <p className="meta">
              Everyone a sync brings in from Ajera, and anyone added by hand, shows up here first.
            </p>
          </section>

          <section className="card pad stack-sm" aria-labelledby="sync-h">
            <h2 id="sync-h" className="h-sm">
              Sync with Ajera
            </h2>
            {props.lastSync ? (
              <>
                <p className="muted">Last run {when(props.lastSync.at)}, from this browser</p>
                <p className="meta">
                  {props.lastSync.result.added} added · {props.lastSync.result.parented} placed
                  under their manager · {props.lastSync.result.departed} no longer active
                </p>
              </>
            ) : (
              <p className="meta">
                Adds anyone active in Ajera who has no seat yet, under their Ajera manager. Never
                deletes a seat, never moves one you arranged, never writes back to Ajera.
              </p>
            )}
            <div>
              <button type="button" className="btn sm" onClick={props.onSync} disabled={props.syncing}>
                {props.syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function SourceTag({ source }: { source: 'ajera' | 'manual' }) {
  return source === 'manual' ? (
    <span className="tag is-manual">Added by hand</span>
  ) : (
    <span className="tag is-ajera">From Ajera</span>
  )
}

function LogRow(props: {
  entry: HistoryEntry
  nameFor: (id: string | null) => string | null
  undoing: string | null
  onUndo: (entry: HistoryEntry) => void
}) {
  const { entry } = props
  const undone = Boolean(entry.undone_at)
  const kind = changeKind(entry)
  const source = insertedSource(entry)

  return (
    <div className={undone ? 'log-row is-undone' : 'log-row'}>
      <span className={kind === 'move' ? 'log-ico is-move' : 'log-ico'}>{ICONS[kind]}</span>
      <div className="grow">
        <p className="log-what">
          {describeChangeParts(entry, props.nameFor).map((part, i) =>
            typeof part === 'string' ? part : <b key={i}>{part.name}</b>,
          )}
        </p>
        <p className="meta">
          {entry.changed_by ?? 'someone'} · {when(entry.changed_at)}
          {undone && ` · undone by ${entry.undone_by ?? 'someone'}`}
        </p>
      </div>
      {undone ? (
        <span className="tag">Undone</span>
      ) : (
        <>
          {kind === 'move' && <span className="tag is-move">Reporting line</span>}
          {source && <SourceTag source={source} />}
          <button
            type="button"
            className="btn sm"
            disabled={props.undoing !== null}
            onClick={() => props.onUndo(entry)}
          >
            {props.undoing === entry.id ? '…' : 'Undo'}
          </button>
        </>
      )}
    </div>
  )
}
