import type { HistoryEntry } from '../lib/types'
import {
  ADDED_WINDOW_HOURS,
  describeChange,
  recentAdditions,
  relativeTime,
} from '../lib/history'

type Props = {
  entries: HistoryEntry[]
  /** Resolves a seat id to its current name; null once a seat is deleted. */
  nameFor: (id: string | null) => string | null
  /** Null while nothing is being undone; otherwise the entry id in flight. */
  undoing: string | null
  onUndo: (entry: HistoryEntry) => void
  onRefresh: () => void
  onClose: () => void
}

export function HistoryPanel(props: Props) {
  // Answered up front because it's the question people actually open this
  // panel with. The full log below still lists these as ordinary additions.
  const added = recentAdditions(props.entries)

  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <h2>Recent changes</h2>
          <p className="panel-sub">Newest first. Undo puts a change back.</p>
        </div>
        <button className="btn-quiet" onClick={props.onClose} title="Close">
          ✕
        </button>
      </div>

      <section className="history-added">
        <h3>
          Added in the last {ADDED_WINDOW_HOURS} hours
          {added.length > 0 && <span className="history-added-count">{added.length}</span>}
        </h3>

        {added.length === 0 ? (
          <p className="history-added-none">
            Nobody new. A sync that brings people in from Ajera, and anyone you
            add by hand, both show up here.
          </p>
        ) : (
          <ul className="history-added-list">
            {added.map((person) => (
              <li key={person.id}>
                <span className="history-added-name">{person.name}</span>
                {person.origin && (
                  <span
                    className={
                      person.origin === 'manual'
                        ? 'history-tag is-manual'
                        : 'history-tag'
                    }
                  >
                    {person.origin === 'manual' ? 'added by hand' : 'from Ajera'}
                  </span>
                )}
                <span className="history-meta">
                  {person.by} · {relativeTime(person.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {props.entries.length === 0 ? (
        <p className="history-empty">
          No edits logged yet. Anything you change from here on shows up in this
          list.
        </p>
      ) : (
        <ul className="history-list">
          {props.entries.map((entry) => {
            const undone = Boolean(entry.undone_at)
            return (
              <li key={entry.id} className={undone ? 'history-item is-undone' : 'history-item'}>
                <div className="history-text">
                  <span className="history-what">{describeChange(entry, props.nameFor)}</span>
                  <span className="history-meta">
                    {entry.changed_by ?? 'someone'} · {relativeTime(entry.changed_at)}
                    {undone && ` · undone by ${entry.undone_by ?? 'someone'}`}
                  </span>
                </div>

                {!undone && (
                  <button
                    className="btn-quiet"
                    disabled={props.undoing !== null}
                    onClick={() => props.onUndo(entry)}
                  >
                    {props.undoing === entry.id ? '…' : 'Undo'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="panel-actions">
        <button className="btn-quiet" onClick={props.onRefresh}>
          Refresh
        </button>
      </div>
    </aside>
  )
}
