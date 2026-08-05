import type { Employee } from '../lib/types'

type Props = {
  /** Active people in Ajera who have no box on the chart. */
  unseated: Employee[]
  /** Name of the currently selected seat, if any — new hires land under it. */
  selectedName: string | null
  onSeat: (employee: Employee) => void
  onClose: () => void
}

export function UnseatedTray(props: Props) {
  return (
    <aside className="panel">
      <div className="panel-head">
        <h2>Not on the chart</h2>
        <button className="btn-quiet" onClick={props.onClose} title="Close">
          ✕
        </button>
      </div>

      {props.unseated.length === 0 ? (
        <p className="panel-empty">
          Everyone active in Ajera has a seat. Nothing to do here.
        </p>
      ) : (
        <>
          <p className="panel-lede">
            {props.unseated.length} active {props.unseated.length === 1 ? 'person' : 'people'} in
            Ajera with no box on the chart — usually new hires.
          </p>
          <p className="panel-note">
            {props.selectedName
              ? `They'll be added reporting to ${props.selectedName}. Select a different box to change that.`
              : 'Select a box on the chart first, and they’ll be added reporting to it. Otherwise they land at the top.'}
          </p>

          <ul className="tray-list">
            {props.unseated.map((e) => (
              <li key={e.employee_key}>
                <div>
                  <strong>{e.full_name}</strong>
                  {e.employee_title && <span className="tray-title">{e.employee_title}</span>}
                </div>
                <button className="btn-quiet" onClick={() => props.onSeat(e)}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
