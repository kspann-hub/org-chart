import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChartNode, MapHours, MapProject } from '../lib/types'
import { isTraveler, locate, mapDistance, MAP_H, MAP_PATHS, MAP_W, type Place } from '../lib/geo'
import { Avatar } from './Avatar'
import { IconChevronRight } from './Icons'

/**
 * The CriticalArc map: everyone at their home base, and the projects they
 * charge time to, from Ajera.
 *
 * Home base comes from the seat's home_base (typed in by an admin). Without
 * one, a person is placed where they charged the most hours in the last 90
 * days, and the card says so — Ajera itself has no home location.
 */

type Kind = 'people' | 'active' | 'potential' | 'past'

const KIND_LABEL: Record<Kind, string> = {
  people: 'Employees, at home base',
  active: 'Active projects',
  potential: 'Potential projects',
  past: 'Past projects',
}

/** Pins at one spot sit side by side in this order, so none hides another. */
const KIND_OFFSET: Record<Kind, number> = { people: -15, active: -5, potential: 5, past: 15 }

/** Map pixels (≈ 4.5 km each) before a project counts as away from home. */
const AWAY_PX = 30

export function kindOf(status: string | null): { kind: Exclude<Kind, 'people'>; onHold: boolean } {
  const s = (status ?? '').toLowerCase()
  if (s === 'active') return { kind: 'active', onHold: false }
  if (s === 'workhold' || s === 'hold') return { kind: 'active', onHold: true }
  if (s === 'preliminary' || s === 'marketing') return { kind: 'potential', onHold: false }
  return { kind: 'past', onHold: false }
}

/** The toolbar's "Show" filter: which people get pins. */
type Who = 'all' | 'traveler' | 'set' | 'missing'

const WHO_LABEL: Record<Who, string> = {
  all: 'Everyone',
  traveler: 'Full-time travelers',
  set: 'Home base set',
  missing: 'No home base yet',
}

function isWho(p: { homeSource: string | null }, who: Who): boolean {
  if (who === 'all') return true
  if (who === 'traveler') return p.homeSource === 'traveler'
  if (who === 'set') return p.homeSource === 'set'
  return p.homeSource === 'timesheets' || p.homeSource === null
}

type Proj = MapProject & { place: Place | null; kind: Exclude<Kind, 'people'>; onHold: boolean }

type Work = { project: Proj; h14: number; h90: number }

type Person = {
  node: ChartNode
  home: Place | null
  /**
   * 'set' = typed in by an admin; 'timesheets' = where they charge the most;
   * 'traveler' = marked a full-time traveler, shown where they're working now.
   */
  homeSource: 'set' | 'timesheets' | 'traveler' | null
  work: Work[]
  travelling: boolean
}

type Spot = { place: Place; people: Person[]; active: Proj[]; potential: Proj[]; past: Proj[] }

type Sel =
  | { kind: 'spot'; key: string; type: Kind }
  | { kind: 'person'; id: string; from?: { key: string; type: Kind } }
  | { kind: 'project'; key: string; from?: { key: string; type: Kind } }
  | null

type Props = {
  nodes: ChartNode[]
  projects: MapProject[] | null
  hours: MapHours[] | null
  loading: boolean
  error: string | null
  /** The shared employee card, with this map's rows added under the facts. */
  personCard: (
    id: string,
    onSelect: (id: string | null) => void,
    extra: (shownId: string) => React.ReactNode,
  ) => React.ReactNode
  /** A person to open on arrival ("Show on map"): selected, zoomed to, pulsing. */
  focusId?: string | null
  onFocusHandled?: () => void
}

export function CAMap(props: Props) {
  const [sel, setSel] = useState<Sel>(null)
  const [who, setWho] = useState<Who>('all')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<Record<Kind, boolean>>({
    people: true,
    active: true,
    potential: true,
    past: true,
  })

  // ------------------------------------------------------------- the data

  const model = useMemo(() => {
    const projects = props.projects ?? []
    const hours = props.hours ?? []

    // States the firm works in, busiest first: where "San Diego" with no
    // state is looked for before anywhere else.
    const stateCounts = new Map<string, number>()
    for (const p of projects) {
      const m = (p.location ?? '').match(/,\s*([A-Za-z]{2})\s*$/)
      if (m) stateCounts.set(m[1].toUpperCase(), (stateCounts.get(m[1].toUpperCase()) ?? 0) + 1)
    }
    const prefer = [...stateCounts].sort((a, b) => b[1] - a[1]).map(([st]) => st)

    const projByKey = new Map<string, Proj>()
    for (const p of projects) {
      projByKey.set(p.project_key, { ...p, place: locate(p.location, prefer), ...kindOf(p.status) })
    }

    const seatByEmployee = new Map<string, ChartNode>()
    for (const n of props.nodes) {
      const key = n.position.employee_key
      if (key && !seatByEmployee.has(key)) seatByEmployee.set(key, n)
    }

    const workByEmployee = new Map<string, Work[]>()
    for (const h of hours) {
      const project = projByKey.get(h.project_key)
      if (!project) continue
      const list = workByEmployee.get(h.employee_key) ?? []
      list.push({ project, h14: h.hours_14d ?? 0, h90: h.hours_90d })
      workByEmployee.set(h.employee_key, list)
    }

    const people: Person[] = []
    for (const [key, node] of seatByEmployee) {
      if (node.stale) continue
      const work = (workByEmployee.get(key) ?? []).sort((a, b) => b.h14 - a.h14 || b.h90 - a.h90)
      const roaming = isTraveler(node.position.home_base)
      const set = roaming ? null : locate(node.position.home_base, prefer)
      let home = set
      let homeSource: Person['homeSource'] = set ? 'set' : null
      if (roaming) {
        // No base to show, so put them where the work is: this fortnight's
        // biggest project, or failing that the last 90 days'.
        const now = work.find((w) => w.h14 > 0 && w.project.place)
        const top = now ?? [...work].sort((a, b) => b.h90 - a.h90).find((w) => w.project.place)
        home = top?.project.place ?? null
        homeSource = 'traveler'
      } else if (!home) {
        const top = [...work].sort((a, b) => b.h90 - a.h90).find((w) => w.project.place)
        if (top) {
          home = top.project.place
          homeSource = 'timesheets'
        }
      }
      const travelling =
        homeSource === 'set' &&
        work.some((w) => w.h14 > 0 && w.project.place && mapDistance(home!, w.project.place) > AWAY_PX)
      people.push({ node, home, homeSource, work, travelling })
    }

    const spots = new Map<string, Spot>()
    const spotFor = (place: Place) => {
      let s = spots.get(place.key)
      if (!s) {
        s = { place, people: [], active: [], potential: [], past: [] }
        spots.set(place.key, s)
      }
      return s
    }
    for (const p of people) if (p.home) spotFor(p.home).people.push(p)
    for (const p of projByKey.values()) if (p.place) spotFor(p.place)[p.kind].push(p)

    const byId = new Map(people.map((p) => [p.node.id, p]))
    const byEmployee = new Map(people.map((p) => [p.node.position.employee_key ?? '', p]))

    return {
      spots,
      byId,
      byEmployee,
      projByKey,
      unplacedPeople: people.filter((p) => !p.home).length,
      unplacedProjects: [...projByKey.values()].filter((p) => !p.place).length,
      counts: {
        people: people.filter((p) => p.home).length,
        active: [...projByKey.values()].filter((p) => p.kind === 'active' && p.place).length,
        potential: [...projByKey.values()].filter((p) => p.kind === 'potential' && p.place).length,
        past: [...projByKey.values()].filter((p) => p.kind === 'past' && p.place).length,
      },
    }
  }, [props.nodes, props.projects, props.hours])

  // ------------------------------------------------------------ filtering

  /** The spots with only the people the filter keeps. Projects are untouched. */
  const spots = useMemo(() => {
    if (who === 'all') return model.spots
    const out = new Map<string, Spot>()
    for (const [key, spot] of model.spots) {
      out.set(key, { ...spot, people: spot.people.filter((p) => isWho(p, who)) })
    }
    return out
  }, [model, who])

  const everyone = useMemo(
    () => [...model.byId.values()].sort((a, b) => a.node.name.localeCompare(b.node.name)),
    [model],
  )
  const filtered = useMemo(() => everyone.filter((p) => isWho(p, who)), [everyone, who])

  // Every word, any order, against name, title and email, like the sidebar.
  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!q) return []
    const words = q.split(/\s+/)
    return everyone
      .filter((p) => {
        const hay = [p.node.name, p.node.title, p.node.employee?.full_name, p.node.employee?.employee_email]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return words.every((w) => hay.includes(w))
      })
      .sort(
        (a, b) =>
          Number(!a.node.name.toLowerCase().startsWith(q)) -
            Number(!b.node.name.toLowerCase().startsWith(q)) ||
          a.node.name.localeCompare(b.node.name),
      )
      .slice(0, 8)
  }, [everyone, q])

  // ------------------------------------------------------------ pan / zoom

  const vpRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const fitK = useRef(1)
  const drag = useRef<{ sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null)

  const fit = useCallback(() => {
    const vp = vpRef.current
    if (!vp) return
    const k = Math.min(vp.clientWidth / MAP_W, vp.clientHeight / MAP_H) * 0.96
    fitK.current = k
    setView({ k, x: (vp.clientWidth - MAP_W * k) / 2, y: (vp.clientHeight - MAP_H * k) / 2 })
  }, [])

  useLayoutEffect(fit, [fit])

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const vp = vpRef.current
    if (!vp) return
    const ax = px ?? vp.clientWidth / 2
    const ay = py ?? vp.clientHeight / 2
    setView((v) => {
      const k = Math.min(fitK.current * 16, Math.max(fitK.current * 0.8, v.k * factor))
      const r = k / v.k
      return { k, x: ax - (ax - v.x) * r, y: ay - (ay - v.y) * r }
    })
  }, [])

  // Registered by hand: React's onWheel is passive, so it can't stop the page
  // scrolling while the map zooms.
  useEffect(() => {
    const vp = vpRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = vp.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Arriving from "Show on map": once the data is in, select the person and
  // fly to their home base. Someone the map can't place still gets their card,
  // with a line saying why there is no pin.
  /** Select a person and zoom to their pin, if they have one. */
  const flyTo = useCallback(
    (id: string) => {
      setSel({ kind: 'person', id })
      const home = model.byId.get(id)?.home
      const vp = vpRef.current
      if (!home || !vp) return
      const k = fitK.current * 5
      setView({ k, x: vp.clientWidth / 2 - home.x * k, y: vp.clientHeight / 2 - home.y * k })
    },
    [model],
  )

  const { focusId, onFocusHandled } = props
  useEffect(() => {
    if (!focusId || props.loading) return
    onFocusHandled?.()
    flyTo(focusId)
  }, [focusId, props.loading, flyTo, onFocusHandled])

  function pickResult(id: string) {
    setQuery('')
    // A filter that hides them would leave the zoom pointing at an empty spot.
    const p = model.byId.get(id)
    if (p && !isWho(p, who)) setWho('all')
    flyTo(id)
  }

  // ------------------------------------------------------------- selection

  const selPerson = sel?.kind === 'person' ? model.byId.get(sel.id) ?? null : null
  const selProject = sel?.kind === 'project' ? model.projByKey.get(sel.key) ?? null : null

  /** Spots and kinds to keep bright; everything else dims. */
  const lit = useMemo(() => {
    const out = new Set<string>()
    if (sel?.kind === 'spot') out.add(`${sel.key}|${sel.type}`)
    if (selPerson) {
      if (selPerson.home) out.add(`${selPerson.home.key}|people`)
      for (const w of selPerson.work) if (w.h14 > 0 && w.project.place) out.add(`${w.project.place.key}|${w.project.kind}`)
    }
    if (selProject?.place) out.add(`${selProject.place.key}|${selProject.kind}`)
    return out
  }, [sel, selPerson, selProject])

  const pickPerson = (id: string | null, from?: { key: string; type: Kind }) =>
    setSel(id ? { kind: 'person', id, from } : null)

  // ------------------------------------------------------------------ draw

  const pins: Array<{ spot: Spot; kind: Kind; count: number }> = []
  for (const spot of spots.values()) {
    for (const kind of ['past', 'potential', 'active', 'people'] as Kind[]) {
      const count = spot[kind].length
      if (count && shown[kind]) pins.push({ spot, kind, count })
    }
  }

  const links =
    selPerson?.home && shown.active
      ? selPerson.work
          .filter((w) => w.h14 > 0 && w.project.place && w.project.place.key !== selPerson.home!.key)
          .map((w) => ({ from: selPerson.home!, to: w.project.place! }))
      : []

  const fitted = Math.round((view.k / fitK.current) * 100)

  let panel: React.ReactNode
  if (props.error) {
    panel = (
      <section className="card pad stack-sm">
        <h2 className="h-sm">The map needs one more setup step</h2>
        <p className="meta">{props.error}</p>
      </section>
    )
  } else if (selPerson) {
    const p = selPerson
    const from = sel?.kind === 'person' ? sel.from : undefined
    panel = (
      <div className="stack">
        {from && (
          <button type="button" className="back" onClick={() => setSel({ kind: 'spot', ...from })}>
            ‹ {model.spots.get(from.key)?.place.label ?? 'Back'}
          </button>
        )}
        {props.personCard(p.node.id, (id) => pickPerson(id), (shownId) => (
          <WorkRows
            person={model.byId.get(shownId) ?? null}
            onProject={(key) => setSel({ kind: 'project', key })}
          />
        ))}
      </div>
    )
  } else if (sel?.kind === 'person' && props.nodes.some((n) => n.id === sel.id)) {
    // Selected, but not on the map: no home base, no recent timesheets, or
    // not active in Ajera.
    panel = (
      <div className="stack">
        <section className="card pad">
          <p className="meta">
            Not on the map: there's no home base set for this person and no recent timesheets to
            place them by. Admins can add a home base from the pencil on the card.
          </p>
        </section>
        {props.personCard(sel.id, (id) => pickPerson(id), () => null)}
      </div>
    )
  } else if (selProject) {
    panel = (
      <ProjectCard
        project={selProject}
        manager={selProject.manager_key ? model.byEmployee.get(selProject.manager_key) ?? null : null}
        people={[...model.byId.values()]
          .map((p) => ({ p, w: p.work.find((w) => w.project.project_key === selProject.project_key) }))
          .filter((x): x is { p: Person; w: Work } => Boolean(x.w && x.w.h14 > 0))
          .sort((a, b) => b.w.h14 - a.w.h14)}
        back={
          sel?.kind === 'project' && sel.from
            ? { label: model.spots.get(sel.from.key)?.place.label ?? 'Back', go: () => setSel({ kind: 'spot', ...sel.from! }) }
            : undefined
        }
        onPerson={(id) => pickPerson(id)}
      />
    )
  } else if (sel?.kind === 'spot' && spots.get(sel.key)) {
    const spot = spots.get(sel.key)!
    panel = (
      <SpotCard
        spot={spot}
        type={sel.type}
        onType={(type) => setSel({ kind: 'spot', key: spot.place.key, type })}
        onPerson={(id) => pickPerson(id, { key: spot.place.key, type: 'people' })}
        onProject={(key) => setSel({ kind: 'project', key, from: { key: spot.place.key, type: sel.type } })}
      />
    )
  } else if (who !== 'all' && !props.loading) {
    // With a filter on, the panel lists who it kept, so nobody without a pin
    // (no home base and no timesheets) is missing from the answer.
    panel = (
      <section className="card pad stack">
        <div className="plist-head">
          <h2 className="h-sm">{WHO_LABEL[who]}</h2>
          <p className="eyebrow mono">{filtered.length}</p>
        </div>
        {filtered.length === 0 ? (
          <p className="meta">Nobody right now.</p>
        ) : (
          <div className="plist">
            {filtered.map((p) => (
              <button key={p.node.id} type="button" className="prow" onClick={() => flyTo(p.node.id)}>
                <Avatar node={p.node} size={32} />
                <span className="prow-text">
                  <span className="prow-name">{p.node.name}</span>
                  <span className="prow-sub">{whereLabel(p)}</span>
                </span>
                <IconChevronRight />
              </button>
            ))}
          </div>
        )}
      </section>
    )
  } else {
    panel = (
      <section className="card pad stack-sm">
        <h2 className="h-sm">{props.loading ? 'Loading the map…' : 'Everyone, and the work'}</h2>
        <p className="meta">
          Click a blue pin for who's based there, or a project pin for what's there. Click a
          person to see the projects they've charged time to in the last two weeks.
        </p>
        {!props.loading && (
          <dl className="facts">
            <dt>People placed</dt>
            <dd>{model.counts.people}</dd>
            <dt>Active projects</dt>
            <dd>{model.counts.active}</dd>
            <dt>Potential</dt>
            <dd>{model.counts.potential}</dd>
            <dt>Past</dt>
            <dd>{model.counts.past}</dd>
            {(model.unplacedPeople > 0 || model.unplacedProjects > 0) && (
              <>
                <dt>Not placed</dt>
                <dd>
                  {model.unplacedPeople} {model.unplacedPeople === 1 ? 'person' : 'people'} ·{' '}
                  {model.unplacedProjects} {model.unplacedProjects === 1 ? 'project' : 'projects'}
                </dd>
              </>
            )}
          </dl>
        )}
        {model.unplacedPeople > 0 && (
          <p className="meta">
            People not placed have no home base and no recent timesheets. Admins can add a home
            base from the pencil on their card.
          </p>
        )}
      </section>
    )
  }

  return (
    <div className="split">
      <div className="camap-main">
        <div className="camap-bar" role="search">
          <div className="camap-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results[0]) pickResult(results[0].node.id)
                else if (e.key === 'Escape') setQuery('')
              }}
              placeholder="Search people on the map"
              aria-label="Search people on the map"
            />
            {q && (
              <ul className="sb-results camap-results" aria-label="Matches">
                {results.length === 0 && <li className="sb-noresult">Nobody matches.</li>}
                {results.map((p) => (
                  <li key={p.node.id}>
                    <button type="button" className="sb-result" onClick={() => pickResult(p.node.id)}>
                      <Avatar node={p.node} size={28} />
                      <span className="sb-result-text">
                        <span className="sb-result-name">{p.node.name}</span>
                        <span className="sb-result-title">
                          {[p.node.title, whereLabel(p)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className="camap-filter">
            <span>Show</span>
            <select
              value={who}
              onChange={(e) => {
                setWho(e.target.value as Who)
                setSel(null)
              }}
            >
              {(Object.keys(WHO_LABEL) as Who[]).map((w) => (
                <option key={w} value={w}>
                  {w === 'all'
                    ? WHO_LABEL[w]
                    : `${WHO_LABEL[w]} (${everyone.filter((p) => isWho(p, w)).length})`}
                </option>
              ))}
            </select>
          </label>
        </div>
      <section className="card camap-card" aria-label="Map of people and projects">
        <div
          ref={vpRef}
          className={drag.current?.moved ? 'camap-vp is-panning' : 'camap-vp'}
          tabIndex={0}
          role="region"
          aria-label="Map. Scroll to zoom, drag to move, plus and minus keys to zoom, 0 for the whole country."
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as Element).closest('button')) return
            drag.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const dx = e.clientX - d.sx
            const dy = e.clientY - d.sy
            if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
            if (!d.moved) {
              d.moved = true
              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            }
            setView((v) => ({ ...v, x: d.x + dx, y: d.y + dy }))
          }}
          onPointerUp={() => {
            // A click on bare map (not a drag) clears the selection.
            if (drag.current && !drag.current.moved) setSel(null)
            drag.current = null
          }}
          onPointerCancel={() => (drag.current = null)}
          onKeyDown={(e) => {
            if (e.key === '+' || e.key === '=') zoomAt(1.25)
            else if (e.key === '-' || e.key === '_') zoomAt(0.8)
            else if (e.key === '0') fit()
            else return
            e.preventDefault()
          }}
        >
          <svg className="camap-svg" width="100%" height="100%" aria-hidden="true">
            <defs>
              <pattern id="camap-hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
                <rect width="5" height="5" fill="#5a2a0b" />
                <rect width="2.5" height="5" fill="var(--pin-potential)" />
              </pattern>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {MAP_PATHS.states.map((s) => (
                <path key={s.name} d={s.d} className="camap-state" />
              ))}
              <path d={MAP_PATHS.borders} className="camap-border" vectorEffect="non-scaling-stroke" />
              <path d={MAP_PATHS.nation} className="camap-coast" vectorEffect="non-scaling-stroke" />
              {links.map((l, i) => (
                <line
                  key={i}
                  x1={l.from.x}
                  y1={l.from.y}
                  x2={l.to.x}
                  y2={l.to.y}
                  className="camap-link"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          </svg>

          {pins.map(({ spot, kind, count }) => {
            const key = `${spot.place.key}|${kind}`
            const dim = (sel !== null && !lit.has(key)) || undefined
            const label =
              kind === 'people'
                ? `${count} ${count === 1 ? 'person' : 'people'} based in ${spot.place.label}`
                : `${count} ${KIND_LABEL[kind].toLowerCase().replace(/s$/, count === 1 ? '' : 's')} in ${spot.place.label}`
            return (
              <button
                key={key}
                type="button"
                className={`pin is-${kind}${dim ? ' is-dim' : ''}${lit.has(key) ? ' is-lit' : ''}${
                  kind === 'people' && selPerson?.home?.key === spot.place.key ? ' is-found' : ''
                }`}
                style={{
                  left: spot.place.x * view.k + view.x + KIND_OFFSET[kind],
                  top: spot.place.y * view.k + view.y,
                }}
                aria-label={label}
                title={label}
                onClick={() => {
                  // One person at a spot opens their card straight away.
                  if (kind === 'people' && count === 1) pickPerson(spot.people[0].node.id)
                  else setSel({ kind: 'spot', key: spot.place.key, type: kind })
                }}
              >
                <svg width="22" height="30" viewBox="0 0 24 32" aria-hidden="true">
                  <path
                    d="M12 1C5.9 1 1 5.9 1 12c0 8.3 11 19 11 19s11-10.7 11-19C23 5.9 18.1 1 12 1z"
                    className="pin-body"
                  />
                  <circle cx="12" cy="12" r="4.5" className="pin-dot" />
                </svg>
                {count > 1 && <span className="pin-n">{count}</span>}
              </button>
            )
          })}
        </div>

        <div className="camap-legend" role="group" aria-label="Show on the map">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`legend-btn is-${k}`}
              aria-pressed={shown[k]}
              onClick={() => setShown((s) => ({ ...s, [k]: !s[k] }))}
            >
              <i className="sw-pin" />
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="zoom-controls camap-zoom">
          <button aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(0.8)}>
            −
          </button>
          <span className="zoom-readout">{fitted}%</span>
          <button aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.25)}>
            +
          </button>
          <button className="zoom-fit" title="Show the whole country" onClick={fit}>
            Whole country
          </button>
        </div>
      </section>
      </div>

      <div className="split-side side-sticky">{panel}</div>
    </div>
  )
}

// ================================================================== panels

/** Where someone shows on the map, in a few words. */
function whereLabel(p: Person): string {
  if (p.homeSource === 'traveler') {
    return p.home ? `Full-time traveler · now near ${p.home.label}` : 'Full-time traveler'
  }
  if (!p.home) return 'Not on the map'
  return p.homeSource === 'timesheets' ? `${p.home.label} · from timesheets` : p.home.label
}

function hrs(n: number) {
  return `${Math.round(n * 10) / 10} hrs`
}

function WorkRows(props: { person: Person | null; onProject: (key: string) => void }) {
  const p = props.person
  if (!p) return null
  const recent = p.work.filter((w) => w.h14 > 0)
  const total = recent.reduce((s, w) => s + w.h14, 0)
  return (
    <div className="stack-sm">
      <dl className="facts">
        <dt>Home base</dt>
        <dd>
          {p.homeSource === 'traveler' ? (
            <>
              Full-time traveler
              {p.home && <span className="meta"> · now near {p.home.label}</span>}
            </>
          ) : (
            <>
              {p.home ? p.home.label : '—'}
              {p.homeSource === 'timesheets' && <span className="meta"> · from timesheets</span>}
            </>
          )}
          {p.travelling && <span className="tag is-travel">Traveling</span>}
        </dd>
      </dl>
      <div className="plist-head">
        <p className="eyebrow">Working on</p>
        <p className="eyebrow">Last 2 weeks of timesheets</p>
      </div>
      {recent.length === 0 ? (
        <p className="meta">No time charged to a project in the last two weeks.</p>
      ) : (
        recent.map((w) => (
          <button
            key={w.project.project_key}
            type="button"
            className="prow"
            onClick={() => props.onProject(w.project.project_key)}
          >
            <i className={`sw-pin is-${w.project.kind}`} />
            <span className="prow-text">
              <span className="prow-name">{w.project.name ?? `Project ${w.project.project_key}`}</span>
              <span className="prow-sub">
                {[
                  w.project.place?.label ?? w.project.location ?? 'No location',
                  p.homeSource === 'set' &&
                    p.home &&
                    w.project.place &&
                    mapDistance(p.home, w.project.place) > AWAY_PX &&
                    'away from home base',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className="prow-right">
              <b>{total ? Math.round((w.h14 / total) * 100) : 0}%</b>
              <span className="meta">{hrs(w.h14)}</span>
            </span>
          </button>
        ))
      )}
    </div>
  )
}

function SpotCard(props: {
  spot: Spot
  type: Kind
  onType: (t: Kind) => void
  onPerson: (id: string) => void
  onProject: (key: string) => void
}) {
  const { spot, type } = props
  const kinds = (Object.keys(KIND_LABEL) as Kind[]).filter((k) => spot[k].length > 0)
  return (
    <section className="card pad stack">
      <div>
        <p className="eyebrow">{spot.place.approximate ? 'State (no city given)' : 'Location'}</p>
        <h2 className="h-md">{spot.place.label}</h2>
      </div>
      {kinds.length > 1 && (
        <div className="row-wrap" role="group" aria-label="Show">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className="chipbtn"
              aria-pressed={k === type}
              onClick={() => props.onType(k)}
            >
              {k === 'people' ? 'People' : k[0].toUpperCase() + k.slice(1)} · {spot[k].length}
            </button>
          ))}
        </div>
      )}
      <div className="plist">
        {type === 'people'
          ? spot.people
              .slice()
              .sort((a, b) => a.node.name.localeCompare(b.node.name))
              .map((p) => (
                <button key={p.node.id} type="button" className="prow" onClick={() => props.onPerson(p.node.id)}>
                  <Avatar node={p.node} size={32} />
                  <span className="prow-text">
                    <span className="prow-name">{p.node.name}</span>
                    <span className="prow-sub">
                      {[
                        p.node.title,
                        p.work.filter((w) => w.h14 > 0).map((w) => w.project.name).slice(0, 2).join(', '),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {p.homeSource === 'traveler' ? (
                    <span className="tag is-travel">Full-time traveler</span>
                  ) : (
                    p.travelling && <span className="tag is-travel">Traveling</span>
                  )}
                  <IconChevronRight />
                </button>
              ))
          : spot[type]
              .slice()
              .sort((a, b) => (b.last_work_date ?? '').localeCompare(a.last_work_date ?? ''))
              .map((pr) => (
                <button key={pr.project_key} type="button" className="prow" onClick={() => props.onProject(pr.project_key)}>
                  <i className={`sw-pin is-${pr.kind}`} />
                  <span className="prow-text">
                    <span className="prow-name">{pr.name ?? `Project ${pr.project_key}`}</span>
                    <span className="prow-sub">
                      {[pr.client, pr.onHold ? 'On hold' : pr.status].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <IconChevronRight />
                </button>
              ))}
      </div>
    </section>
  )
}

function monthYear(iso: string | null) {
  const m = iso?.match(/^(\d{4})-(\d{2})/)
  return m
    ? new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : null
}

function ProjectCard(props: {
  project: Proj
  manager: Person | null
  people: Array<{ p: Person; w: Work }>
  back?: { label: string; go: () => void }
  onPerson: (id: string) => void
}) {
  const pr = props.project
  return (
    <section className="card pad stack">
      {props.back && (
        <button type="button" className="back" onClick={props.back.go}>
          ‹ {props.back.label}
        </button>
      )}
      <div className="who">
        <i className={`sw-pin lg is-${pr.kind}`} />
        <div className="who-text">
          <h2>{pr.name ?? `Project ${pr.project_key}`}</h2>
          <p className="muted">
            {[pr.place?.label ?? pr.location ?? 'No location', pr.onHold ? 'On hold' : pr.status]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </div>
      <dl className="facts">
        <dt>Client</dt>
        <dd>{pr.client ?? '—'}</dd>
        <dt>Project manager</dt>
        <dd>
          {props.manager ? (
            <button type="button" className="link" onClick={() => props.onPerson(props.manager!.node.id)}>
              {props.manager.node.name}
            </button>
          ) : (
            '—'
          )}
        </dd>
        <dt>Last time charged</dt>
        <dd>{monthYear(pr.last_work_date) ?? '—'}</dd>
      </dl>
      {pr.kind !== 'past' && (
        <div className="plist">
          <div className="plist-head">
            <p className="eyebrow">Charging time · last 2 weeks</p>
            <p className="eyebrow mono">{props.people.length}</p>
          </div>
          {props.people.length === 0 && <p className="meta">Nobody in the last two weeks.</p>}
          {props.people.map(({ p, w }) => (
            <button key={p.node.id} type="button" className="prow" onClick={() => props.onPerson(p.node.id)}>
              <Avatar node={p.node} size={32} />
              <span className="prow-text">
                <span className="prow-name">{p.node.name}</span>
                <span className="prow-sub">
                  {[p.home?.label, p.travelling && 'traveling'].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="prow-right">
                <span className="meta">{hrs(w.h14)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

