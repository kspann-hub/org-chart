import type { HistoryEntry } from '../lib/types'
import { describeChange, relativeTime } from '../lib/history'

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
