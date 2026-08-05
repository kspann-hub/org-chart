import type { ChartNode } from '../lib/types'
import type { GroupSummary } from '../lib/groups'
import { Avatar } from './Avatar'

type Props = {
  summaries: GroupSummary[]
  ungrouped: ChartNode[]
  totalSeats: number
  onOpenGroup: (groupId: string) => void
  onOpenAll: () => void
}

/** How many faces fit on a card before it turns into "+N". */
const AVATAR_LIMIT = 9

export function Home(props: Props) {
  const { summaries, ungrouped } = props
  const hasGroups = summaries.length > 0

  return (
    <div className="home">
      <div className="home-inner">
        {!hasGroups && (
          <div className="home-empty">
            <h2>No groups yet</h2>
            <p>
              Groups are the verticals on this page. Open the full chart, select the seat
              that should lead a group, and tick <strong>Start a group here</strong> in the
              edit panel.
            </p>
            <button className="btn-primary" onClick={props.onOpenAll}>
              Open the full chart
            </button>
          </div>
        )}

        <div className="group-grid">
          {summaries.map(({ group, root, members }) => (
            <button
              key={group.id}
              className="group-card"
              style={{ borderColor: group.accent }}
              onClick={() => props.onOpenGroup(group.id)}
            >
              <h2 style={{ color: group.accent }}>{group.name}</h2>
              <p className="group-count">
                {members.length} {members.length === 1 ? 'person' : 'people'}
              </p>

              {root && (
                <div className="group-lead">
                  <Avatar node={root} size={44} />
                  <div>
                    <div className="group-lead-name">{root.name}</div>
                    {root.title && <div className="group-lead-title">{root.title}</div>}
                  </div>
                </div>
              )}

              <div className="avatar-stack">
                {members
                  .filter((m) => m.id !== group.root_position_id)
                  .slice(0, AVATAR_LIMIT)
                  .map((m) => (
                    <Avatar key={m.id} node={m} size={28} title={m.name} />
                  ))}
                {members.length - 1 > AVATAR_LIMIT && (
                  <span className="avatar-more">+{members.length - 1 - AVATAR_LIMIT}</span>
                )}
              </div>

              <span className="group-open" style={{ color: group.accent }}>
                Open chart →
              </span>
            </button>
          ))}
        </div>

        {hasGroups && (
          <div className="home-footer">
            <button className="btn-quiet" onClick={props.onOpenAll}>
              Open the whole company ({props.totalSeats} seats)
            </button>
            {ungrouped.length > 0 && (
              <p className="home-note">
                {ungrouped.length} seat{ungrouped.length === 1 ? '' : 's'} sit above every
                group root and appear only in the full chart.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
