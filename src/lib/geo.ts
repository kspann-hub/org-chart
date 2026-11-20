import { geoAlbersUsa, geoPath } from 'd3-geo'
import { feature, mesh } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, Geometry } from 'geojson'
import statesTopo from 'us-atlas/states-albers-10m.json'
import placesJson from '../data/places.json'

/**
 * Where things are, for the CriticalArc map.
 *
 * Ajera stores locations as free text — almost always "City, ST", sometimes
 * just a state, sometimes "Multiple". Cities are looked up in the Census
 * Bureau's list of US places (src/data/places.json, built from the 2024
 * Gazetteer), so there is no geocoding service and nothing leaves the
 * browser. Anything that can't be placed is counted, not guessed.
 *
 * Coordinates are the map's own: us-atlas draws the states already projected
 * to 975×610 with Albers USA (Alaska and Hawaii as insets), and this module
 * projects places with the same settings so they land on top of it.
 */

export const MAP_W = 975
export const MAP_H = 610

const projection = geoAlbersUsa().scale(1300).translate([487.5, 305])

const topo = statesTopo as unknown as Topology<{
  states: GeometryCollection<{ name: string }>
  nation: GeometryCollection
}>

const stateFeatures = feature(topo, topo.objects.states).features as Array<
  Feature<Geometry, { name: string }>
>

const flatPath = geoPath()

/** SVG path data for the map: state fills, borders between them, the coast. */
export const MAP_PATHS = {
  states: stateFeatures.map((f) => ({ name: f.properties.name, d: flatPath(f) ?? '' })),
  borders: flatPath(mesh(topo, topo.objects.states, (a, b) => a !== b)) ?? '',
  nation: flatPath(mesh(topo, topo.objects.nation)) ?? '',
}

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
}

const ABBR_BY_NAME = new Map(Object.entries(STATES).map(([abbr, name]) => [name.toLowerCase(), abbr]))

/** Centre of each state in map coordinates, for locations that are only a state. */
const STATE_CENTRE = new Map(
  stateFeatures.map((f) => {
    const abbr = ABBR_BY_NAME.get(f.properties.name.toLowerCase()) ?? f.properties.name
    return [abbr, flatPath.centroid(f) as [number, number]]
  }),
)

const PLACES = placesJson as unknown as Record<string, Record<string, [number, number]>>

export type Place = {
  x: number
  y: number
  /** How it reads on the card: "Sparks, NV", or "New Mexico" for a state. */
  label: string
  /** Groups everything at one spot onto one set of pins. */
  key: string
  /** True when only the state was known, so the pin sits mid-state. */
  approximate: boolean
}

function toState(raw: string): string | null {
  const t = raw.trim().replace(/\.$/, '')
  if (/^[A-Za-z]{2}$/.test(t) && STATES[t.toUpperCase()]) return t.toUpperCase()
  return ABBR_BY_NAME.get(t.toLowerCase()) ?? null
}

function cityKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^st\.?\s+/, 'st. ')
    .replace(/^ft\.?\s+/, 'fort ')
    .replace(/^mt\.?\s+/, 'mount ')
    .replace(/\s+/g, ' ')
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

function atCity(name: string, st: string): Place | null {
  const table = PLACES[st]
  if (!table) return null
  let key = cityKey(name)
  let hit = table[key]
  // "St. George" is filed as "st. george"; Ajera might say "Saint George".
  if (!hit && key.startsWith('saint ')) hit = table[(key = 'st. ' + key.slice(6))]
  if (!hit) return null
  const xy = projection([hit[1], hit[0]])
  if (!xy) return null
  return { x: xy[0], y: xy[1], label: `${titleCase(key)}, ${st}`, key: `${st}|${key}`, approximate: false }
}

function atState(st: string): Place | null {
  const c = STATE_CENTRE.get(st)
  if (!c) return null
  return { x: c[0], y: c[1], label: STATES[st] ?? st, key: `${st}|*`, approximate: true }
}

/**
 * Place a free-text location, or null when it can't be placed.
 *
 * @param preferStates for a city with no state ("Los Angeles"), the states
 *   to try first, most likely first — the app passes the states its other
 *   projects are in, so "San Diego" lands in California rather than Texas.
 */
export function locate(text: string | null | undefined, preferStates: string[] = []): Place | null {
  const raw = (text ?? '').trim()
  if (!raw || /^(multiple|various|tbd|n\/?a|none|remote)$/i.test(raw)) return null

  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)

  if (parts.length >= 2) {
    // "City, ST" or "City, ST 12345" or "Street, City, ST".
    const st = toState(parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, ''))
    if (st) return atCity(parts[parts.length - 2], st) ?? atState(st)
  }

  const only = toState(raw)
  if (only) return atState(only)

  // A city with no state: the first preferred state that has it, else the
  // only state that has it. Ambiguous and unpreferred means unplaced.
  const name = parts[0]
  for (const st of preferStates) {
    const hit = atCity(name, st)
    if (hit) return hit
  }
  const states = Object.keys(PLACES).filter((st) => PLACES[st][cityKey(name)])
  return states.length === 1 ? atCity(name, states[0]) : null
}

/** The state part of a placed location's key. */
export const stateOf = (p: Place) => p.key.split('|')[0]

/** Rough distance in map pixels between two places (1px ≈ 4.5 km). */
export const mapDistance = (a: Place, b: Place) => Math.hypot(a.x - b.x, a.y - b.y)
