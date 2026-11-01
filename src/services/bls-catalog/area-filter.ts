/**
 * @fileoverview The `area` grammar of catalog search. A USPS code or two-digit
 * state FIPS code names a state; an all-digit code of 3, 4, 5, or 7 digits
 * names the CSA, CPI area, county or metro area, or city it encodes. Both
 * resolve to decoded area names in every indexed survey. Any other value is a
 * case-insensitive substring of the area name, title, or SeriesID.
 * @module services/bls-catalog/area-filter
 */

/** A state, DC, or Puerto Rico: its FIPS code, USPS code, and the name the catalog decodes. */
interface State {
  fips: string;
  name: string;
  usps: string;
}

/** The 52 statewide LAUS areas (`LASST{fips}…`): the 50 states, DC, and Puerto Rico. */
const STATES: readonly State[] = (
  [
    ['01', 'AL', 'Alabama'],
    ['02', 'AK', 'Alaska'],
    ['04', 'AZ', 'Arizona'],
    ['05', 'AR', 'Arkansas'],
    ['06', 'CA', 'California'],
    ['08', 'CO', 'Colorado'],
    ['09', 'CT', 'Connecticut'],
    ['10', 'DE', 'Delaware'],
    ['11', 'DC', 'District of Columbia'],
    ['12', 'FL', 'Florida'],
    ['13', 'GA', 'Georgia'],
    ['15', 'HI', 'Hawaii'],
    ['16', 'ID', 'Idaho'],
    ['17', 'IL', 'Illinois'],
    ['18', 'IN', 'Indiana'],
    ['19', 'IA', 'Iowa'],
    ['20', 'KS', 'Kansas'],
    ['21', 'KY', 'Kentucky'],
    ['22', 'LA', 'Louisiana'],
    ['23', 'ME', 'Maine'],
    ['24', 'MD', 'Maryland'],
    ['25', 'MA', 'Massachusetts'],
    ['26', 'MI', 'Michigan'],
    ['27', 'MN', 'Minnesota'],
    ['28', 'MS', 'Mississippi'],
    ['29', 'MO', 'Missouri'],
    ['30', 'MT', 'Montana'],
    ['31', 'NE', 'Nebraska'],
    ['32', 'NV', 'Nevada'],
    ['33', 'NH', 'New Hampshire'],
    ['34', 'NJ', 'New Jersey'],
    ['35', 'NM', 'New Mexico'],
    ['36', 'NY', 'New York'],
    ['37', 'NC', 'North Carolina'],
    ['38', 'ND', 'North Dakota'],
    ['39', 'OH', 'Ohio'],
    ['40', 'OK', 'Oklahoma'],
    ['41', 'OR', 'Oregon'],
    ['42', 'PA', 'Pennsylvania'],
    ['44', 'RI', 'Rhode Island'],
    ['45', 'SC', 'South Carolina'],
    ['46', 'SD', 'South Dakota'],
    ['47', 'TN', 'Tennessee'],
    ['48', 'TX', 'Texas'],
    ['49', 'UT', 'Utah'],
    ['50', 'VT', 'Vermont'],
    ['51', 'VA', 'Virginia'],
    ['53', 'WA', 'Washington'],
    ['54', 'WV', 'West Virginia'],
    ['55', 'WI', 'Wisconsin'],
    ['56', 'WY', 'Wyoming'],
    ['72', 'PR', 'Puerto Rico'],
  ] as const
).map(([fips, usps, name]) => ({ fips, usps, name }));

const BY_FIPS = new Map(STATES.map((s) => [s.fips, s]));
const BY_USPS = new Map(STATES.map((s) => [s.usps, s]));

/** Code lengths with a meaning: CSA, CPI area, county FIPS or metro area, state + place FIPS. */
const CODE_LENGTHS: ReadonlySet<number> = new Set([3, 4, 5, 7]);

/** What an `area` value names. */
export type AreaForm =
  /** A USPS code or two-digit FIPS code; no `state` when the FIPS code names none. */
  | { kind: 'state'; state: State | undefined }
  /** An all-digit area code of a recognized length. */
  | { kind: 'code'; code: string }
  /** Any other all-digit value: a substring, which the tool reports in a notice. */
  | { kind: 'fragment' }
  /** Anything holding a non-digit, other than a USPS code: a substring. */
  | { kind: 'text' };

/**
 * Classify an `area` value, case-insensitively. Two anchored single-class
 * patterns, so the cost stays linear in the value's length.
 */
export function areaForm(area: string): AreaForm {
  if (/^[a-z]{2}$/i.test(area)) {
    const state = BY_USPS.get(area.toUpperCase());
    return state ? { kind: 'state', state } : { kind: 'text' };
  }
  if (!/^\d+$/.test(area)) return { kind: 'text' };
  if (area.length === 2) return { kind: 'state', state: BY_FIPS.get(area) };
  return CODE_LENGTHS.has(area.length) ? { kind: 'code', code: area } : { kind: 'fragment' };
}

/** USPS codes joined by `-` at the start of a comma-separated part: `WA`, `DE-MD-NJ`. */
const POSTAL_GROUP = /^[A-Z]{2}(?:-[A-Z]{2})*(?=\s|$)/;

/** The states a postal group at the start of `part` names. */
function postalStates(part: string): string[] {
  const group = POSTAL_GROUP.exec(part)?.[0];
  return group ? group.split('-').filter((code) => BY_USPS.has(code)) : [];
}

/**
 * The states (USPS codes) a decoded area name lies in or reaches into. A
 * metro name lists them after a comma (`Seattle-Tacoma-Bellevue, WA
 * Metropolitan Statistical Area`, `Wilmington, DE-MD-NJ Metropolitan
 * Division`), or after its last space when it has no comma (CPI's
 * `Seattle-Tacoma-Bellevue WA`); a closing `NJ part` confines it to that
 * state. A name with none is in the state its first part ends with
 * (`Texas`, `Balance of California`, `Urban Alaska`), the longest such name
 * winning (`West Virginia`, not `Virginia`). `Texas County, MO` is in Missouri.
 */
export function statesOf(area: string): string[] {
  const [first = '', ...rest] = area.split(', ');
  const last = rest.at(-1);
  if (last !== undefined && /^[A-Z]{2} part$/.test(last)) return postalStates(last);
  const postal =
    rest.length > 0
      ? rest.flatMap(postalStates)
      : postalStates(first.slice(first.lastIndexOf(' ') + 1));
  if (postal.length > 0) return [...new Set(postal)];
  let named: State | undefined;
  for (const s of STATES) {
    if (
      (first === s.name || first.endsWith(` ${s.name}`)) &&
      s.name.length > (named?.name.length ?? 0)
    )
      named = s;
  }
  return named ? [named.usps] : [];
}

/** Trailing area-type words a survey may add to or drop from the same area's name; longest first. */
const KEY_SUFFIXES = [
  'metropolitan statistical area',
  'micropolitan statistical area',
  'combined statistical area',
  'census division',
  'census region',
  'division',
  'region',
  'csa',
  'msa',
];

/**
 * A decoded area name reduced to the form other surveys share for the same
 * area: lowercase letter-and-digit words, less a trailing area-type suffix.
 * LAUS `Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area` and CPI
 * `Seattle-Tacoma-Bellevue WA` both become `seattle tacoma bellevue wa`; CPI
 * `Pacific` and LAUS `Pacific division` both become `pacific`. A metropolitan
 * division keeps its suffix: it can share its name with the metro area it
 * divides (`Atlanta-Sandy Springs-Roswell, GA`).
 */
export function areaKey(name: string): string {
  const key = (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
  if (key.endsWith(' metropolitan division')) return key;
  const suffix = KEY_SUFFIXES.find((s) => key.endsWith(` ${s}`));
  return suffix ? key.slice(0, -suffix.length - 1) : key;
}

/**
 * Where a survey's SeriesIDs carry an all-digit area code: its 1-based
 * `start` and `length`, on LAUS rows only of the area `types` the SeriesID
 * holds at characters 4–5. CPI areas with a letter (`S49D`) are not
 * all-digit and stay substring matches.
 */
interface AreaCodeSource {
  length: number;
  start: number;
  survey: string;
  types?: readonly string[];
}

/** The area codes the grammar resolves, by the SeriesIDs that carry them. */
export const AREA_CODE_SOURCES: readonly AreaCodeSource[] = [
  /** Combined statistical area: `LAUCA535000000000003` → 500. */
  { survey: 'LA', types: ['CA'], start: 8, length: 3 },
  /** CPI area: `CUUR0100SA0`, `CWUR0100SA0`, `APU0100701111` → 0100. */
  { survey: 'CU', start: 5, length: 4 },
  { survey: 'CW', start: 5, length: 4 },
  { survey: 'AP', start: 4, length: 4 },
  /** County FIPS: `LAUCN530330000000003` → 53033. */
  { survey: 'LA', types: ['CN'], start: 6, length: 5 },
  /**
   * Metro or micro area (CBSA), metropolitan division, a multi-state metro's
   * part in one state, and labor market area: `LAUMT534266000000003` → 42660.
   */
  { survey: 'LA', types: ['MT', 'MC', 'DV', 'IM', 'ID', 'SA'], start: 8, length: 5 },
  /** City or town, and its parts by county (state + place FIPS): `LAUCT536300000000003` → 5363000. */
  { survey: 'LA', types: ['CT', 'CS', 'PT'], start: 6, length: 7 },
];

/** The decoded areas each state and area code resolves to. */
export interface AreaIndex {
  /** All-digit area code → the areas it names, in every survey that decodes them. */
  codes: ReadonlyMap<string, ReadonlySet<string>>;
  /** USPS code → the areas inside or reaching into the state, its statewide area included. */
  states: ReadonlyMap<string, ReadonlySet<string>>;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/**
 * Index the decoded area names by state, and the area codes `coded` reads
 * from SeriesIDs (`AREA_CODE_SOURCES`) by the areas they name. A code's area
 * expands to every decoded name sharing its `areaKey`, so a code one survey's
 * IDs carry reaches each survey that names the same area.
 */
export function indexAreas(
  areas: Iterable<string>,
  coded: Iterable<{ area: string; code: string }>,
): AreaIndex {
  const byKey = new Map<string, Set<string>>();
  const states = new Map<string, Set<string>>();
  for (const area of areas) {
    addTo(byKey, areaKey(area), area);
    for (const usps of statesOf(area)) addTo(states, usps, area);
  }
  const codes = new Map<string, Set<string>>();
  for (const { area, code } of coded) {
    if (!/^\d+$/.test(code)) continue;
    for (const name of byKey.get(areaKey(area)) ?? [area]) addTo(codes, code, name);
  }
  return { codes, states };
}

/**
 * The rows a state or area code selects: those whose decoded area is one of
 * `areas`, and for a state, those with no decoded area whose title names it
 * as a comma-separated part (CPS `…, 18 years and over, Texas`) — `state` is
 * its lowercased name.
 */
export interface ResolvedArea {
  areas: ReadonlySet<string>;
  state?: string;
}

const NO_AREAS: ReadonlySet<string> = new Set();

/**
 * Resolve an `area` value against the index. `undefined` means the value is
 * a substring of the area name, title, or SeriesID; a state or code that
 * names no indexed area resolves to no rows.
 */
export function resolveArea(area: string, index: AreaIndex): ResolvedArea | undefined {
  const form = areaForm(area);
  switch (form.kind) {
    case 'state':
      return form.state
        ? {
            areas: index.states.get(form.state.usps) ?? NO_AREAS,
            state: form.state.name.toLowerCase(),
          }
        : { areas: NO_AREAS };
    case 'code':
      return { areas: index.codes.get(form.code) ?? NO_AREAS };
    case 'fragment':
    case 'text':
      return undefined;
    default: {
      const unreachable: never = form;
      return unreachable;
    }
  }
}
