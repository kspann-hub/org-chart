import { useId } from 'react'
import type { ChartNode, Group } from '../lib/types'
import { Avatar } from './Avatar'
import {
  IconBrand,
  IconClock,
  IconDownload,
  IconOrgChart,
  IconOverview,
  IconSignOut,
  IconSync,
} from './Icons'

/** Which screen is open. Lives here because the sidebar is what changes it. */
export type Page =
  | { kind: 'home' }
  | { kind: 'all'; mode: 'map' | 'tree' }
  | { kind: 'group'; id: string; mode: 'map' | 'tree' }
  | { kind: 'changes' }

type Props = {
  page: Page
  verticals: Array<{ group: Group; count: number }>
  isAdmin: boolean
  email: string | null

  query: string
  onQuery: (q: string) => void
  /** Best matches for the query, already trimmed to a handful. */
  results: ChartNode[]
  onPickResult: (id: string) => void

  onNavigate: (page: Page) => void
  syncing: boolean
  exporting: boolean
  onSync: () => void
  onExport: () => void
  onSignOut: () => void
}

/**
 * The left rail: who you are, where you can go, and the admin tools.
 *
 * Replaces the old top bar, which had grown to eleven buttons and wrapped onto
 * two lines on a laptop. Navigation that never changes sits here; anything that
 * belongs to one screen moved into that screen's own header.
 */
export function Sidebar(props: Props) {
  const { page } = props
  const searchId = useId()
  const resultsId = useId()
  const showResults = props.query.trim().length > 0

  const groupId = page.kind === 'group' ? page.id : null

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <span className="sb-mark">
          <IconBrand size={18} />
        </span>
        <span className="sb-brand-text">
          <span className="sb-name">CriticalArc</span>
          <span className="sb-sub">Organization chart</span>
        </span>
      </div>

      <div className="sb-search">
        <label htmlFor={searchId} className="sb-eyebrow">
          Search people
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Name or title"
          autoComplete="off"
          value={props.query}
          aria-controls={showResults ? resultsId : undefined}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && props.results[0]) props.onPickResult(props.results[0].id)
            if (e.key === 'Escape') props.onQuery('')
          }}
        />
        {showResults && (
          <ul className="sb-results" id={resultsId} aria-label="Matches">
            {props.results.length === 0 && <li className="sb-noresult">Nobody matches.</li>}
            {props.results.map((n) => (
              <li key={n.id}>
                <button type="button" className="sb-result" onClick={() => props.onPickResult(n.id)}>
                  <Avatar node={n} size={28} />
                  <span className="sb-result-text">
                    <span className="sb-result-name">{n.name}</span>
                    {n.title && <span className="sb-result-title">{n.title}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <nav className="sb-nav" aria-label="Company">
        <p className="sb-eyebrow">Company</p>
        <NavButton
          on={page.kind === 'home'}
          onClick={() => props.onNavigate({ kind: 'home' })}
          icon={<IconOverview />}
          label="Overview"
        />
        <NavButton
          on={page.kind === 'all'}
          onClick={() => props.onNavigate({ kind: 'all', mode: 'map' })}
          icon={<IconOrgChart />}
          label="Full org chart"
        />
      </nav>

      {props.verticals.length > 0 && (
        <nav className="sb-nav" aria-label="Verticals">
          <p className="sb-eyebrow">Verticals</p>
          {props.verticals.map(({ group, count }) => (
            <NavButton
              key={group.id}
              on={groupId === group.id}
              onClick={() => props.onNavigate({ kind: 'group', id: group.id, mode: 'map' })}
              icon={<span className="sb-dot" style={{ background: group.accent }} />}
              label={group.name}
              count={count}
            />
          ))}
        </nav>
      )}

      <nav className="sb-nav sb-foot" aria-label={props.isAdmin ? 'Admin' : 'Account'}>
        <p className="sb-eyebrow">{props.isAdmin ? 'Admin' : 'Account'}</p>
        {props.isAdmin && (
          <>
            <NavButton
              onClick={props.onSync}
              disabled={props.syncing}
              icon={<IconSync />}
              label={props.syncing ? 'Syncing…' : 'Sync with Ajera'}
              title="Add anyone new from Ajera. Never deletes, never writes back to Ajera."
            />
            <NavButton
              on={page.kind === 'changes'}
              onClick={() => props.onNavigate({ kind: 'changes' })}
              icon={<IconClock />}
              label="Recent changes"
            />
          </>
        )}
        <NavButton
          onClick={props.onExport}
          disabled={props.exporting}
          icon={<IconDownload />}
          label={props.exporting ? 'Rendering…' : 'Export PNG'}
          title="Download the chart you're looking at as an image"
        />
        <NavButton onClick={props.onSignOut} icon={<IconSignOut />} label="Sign out" />
        {props.email && (
          <p className="sb-email" title={props.email}>
            {props.email}
            {props.isAdmin && <span className="sb-badge">Admin</span>}
          </p>
        )}
      </nav>
    </aside>
  )
}

function NavButton(props: {
  on?: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count?: number
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      className={props.on ? 'nav is-on' : 'nav'}
      aria-current={props.on ? 'page' : undefined}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.icon}
      <span className="nav-label">{props.label}</span>
      {props.count !== undefined && <span className="nav-count">{props.count}</span>}
    </button>
  )
}
