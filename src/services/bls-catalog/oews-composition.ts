/**
 * @fileoverview OEWS SeriesIDs composed from the OE code tables (#119). The
 * survey's `oe.series` file is 1.26 GB and stays out of the default index, but
 * OEWS IDs are positional and their code tables are small: `OE`, seasonal (`U`),
 * areatype, area (7), industry (6), occupation (6), and data type (2). Under
 * `survey: "OE"`, while the index holds no OE rows, `composeOewsSearch` matches
 * the query's occupation, area, and data type and composes IDs by BLS's
 * existence rules; a query that is an OEWS SeriesID decodes into its row with or
 * without the filter. Many occupation–area cells stay unpublished, which no
 * small LABSTAT file predicts, so every composed row is marked `composed`:
 * unconfirmed until a data request returns it. `oewsFallbacks` names the state
 * and national rows that answer when such a cell does not.
 * @module services/bls-catalog/oews-composition
 */

import { areaForm } from './area-filter.js';
import type { CatalogSearchInput, CatalogSearchResult, CatalogSeries } from './types.js';

/** The OE code tables composition reads, by LABSTAT file suffix (`oe.area` …). */
export const OEWS_TABLE_NAMES = ['area', 'occupation', 'datatype'] as const;
export type OewsTableName = (typeof OEWS_TABLE_NAMES)[number];

/** Rows one query composes at most, ranked before the cut: one keyed bls_get_series batch. */
export const OEWS_COMPOSED_LIMIT = 50;

type Areatype = 'N' | 'S' | 'M';

/** An `oe.area` row. A metro or nonmetro area (`M`) belongs to the state `stateCode`. */
export interface OewsArea {
  areatype: Areatype;
  code: string;
  name: string;
  stateCode: string;
}

/** An `oe.occupation` row; `level` is its `display_level`. */
export interface OewsOccupation {
  code: string;
  /** 0 a major group (All Occupations included), 1 minor, 2 broad, 3 detailed. */
  level: number;
  name: string;
}

/** An `oe.datatype` row. */
export interface OewsDatatype {
  code: string;
  name: string;
}

/** Each entry's match words, computed once per table set rather than per query. */
interface Vocabulary {
  /** Every area-name word of 3+ characters. */
  areaVocabulary: ReadonlySet<string>;
  /** By area code: every word of 3+ characters, and the ones that identify a place. */
  areaWords: ReadonlyMap<string, { all: ReadonlySet<string>; places: ReadonlySet<string> }>;
  /** Per data type, in table order: the stems that tell it from the others. */
  datatypeStems: readonly (readonly string[])[];
  /** Every data-type-name stem. */
  datatypeVocabulary: ReadonlySet<string>;
  /** Per occupation, in table order: its name's stems. */
  occupationStems: readonly ReadonlySet<string>[];
  /** Every occupation-name stem. */
  occupationVocabulary: ReadonlySet<string>;
}

/** The parsed OE code tables. */
export interface OewsTables {
  /** By area code, in file order. */
  areas: ReadonlyMap<string, OewsArea>;
  datatypes: readonly OewsDatatype[];
  /** In file order, which is BLS's `sort_sequence`. */
  occupations: readonly OewsOccupation[];
  vocabulary: Vocabulary;
}

/** An OEWS SeriesID: seasonal, areatype, area, industry, occupation, data type. */
const OEWS_ID = /^OE([SU])([NSM])(\d{7})([0-9A-Z-]{6})(\d{6})(\d{2})$/;

const NATIONAL_AREA = '0000000';
const ALL_INDUSTRIES = '000000';
const ALL_OCCUPATIONS = '000000';
/** BLS publishes no national employment per 1,000 jobs (16) or location quotient (17). */
const SUBNATIONAL_DATATYPES: ReadonlySet<string> = new Set(['16', '17']);
/** Employment, hourly mean wage, annual mean wage: composed when the query names no data type. */
const DEFAULT_DATATYPES = ['01', '03', '04'];

/** Distinct query words matched, as the catalog search bounds its tokens. */
const MAX_QUERY_WORDS = 32;

/** Words that name no occupation, place, or data type on their own. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'all',
  'and',
  'are',
  'does',
  'except',
  'for',
  'from',
  'how',
  'many',
  'much',
  'other',
  'the',
  'what',
  'who',
  'with',
]);

/** Data-type words shared too widely to select one: every wage type, and "per 1,000 jobs". */
const GENERIC_DATATYPE_STEMS: ReadonlySet<string> = new Set(['wage', 'per', 'job']);

/** Everyday words for a data type's own words. */
const DATATYPE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['average', 'mean'],
  ['salary', 'annual'],
  ['salarie', 'annual'],
]);

/** Area-name words that describe a place without identifying one. */
const PLACE_STOP_WORDS: ReadonlySet<string> = new Set([
  'area',
  'central',
  'city',
  'county',
  'east',
  'eastern',
  'metropolitan',
  'national',
  'new',
  'nonmetropolitan',
  'north',
  'northeast',
  'northern',
  'northwest',
  'south',
  'southeast',
  'southern',
  'southwest',
  'west',
  'western',
]);

/** Lowercase words, with thousands separators dropped ("1,000" → "1000"). */
function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/(\d),(?=\d)/g, '$1')
      .match(/[a-z0-9]+/g) ?? []
  );
}

/** A word in singular form, so "nurse" and "nurses" match. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/** The stems of a name's words of 3+ characters, stop words aside. */
function nameStems(name: string): Set<string> {
  return new Set(
    words(name)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .map(stem),
  );
}

/** A table's rows as the named columns, by header; undefined when a column is missing. */
function columns(text: string, names: readonly string[]): string[][] | undefined {
  const [headerLine = '', ...lines] = text.split('\n');
  const header = headerLine.split('\t').map((h) => h.trim().toLowerCase());
  const indices = names.map((n) => header.indexOf(n));
  if (indices.includes(-1)) return;
  return lines
    .filter((line) => line.trim())
    .map((line) => {
      const fields = line.split('\t');
      return indices.map((i) => (fields[i] ?? '').trim());
    });
}

function isAreatype(value: string): value is Areatype {
  return value === 'N' || value === 'S' || value === 'M';
}

/**
 * Parse the three OE code tables by header. Rows whose codes do not fit their
 * SeriesID positions are skipped; a set where any table lacks a required column
 * or a usable row is refused whole (undefined), since composition needs all three.
 */
export function parseOewsTables(
  bodies: Readonly<Record<OewsTableName, string>>,
): OewsTables | undefined {
  const areaRows = columns(bodies.area, ['state_code', 'area_code', 'areatype_code', 'area_name']);
  const occupationRows = columns(bodies.occupation, [
    'occupation_code',
    'occupation_name',
    'display_level',
  ]);
  const datatypeRows = columns(bodies.datatype, ['datatype_code', 'datatype_name']);
  if (!areaRows || !occupationRows || !datatypeRows) return;

  const areas = new Map<string, OewsArea>();
  for (const [stateCode = '', code = '', areatype = '', name = ''] of areaRows) {
    if (/^\d{2}$/.test(stateCode) && /^\d{7}$/.test(code) && isAreatype(areatype) && name) {
      areas.set(code, { code, name, areatype, stateCode });
    }
  }
  const occupations: OewsOccupation[] = [];
  for (const [code = '', name = '', level = ''] of occupationRows) {
    if (/^\d{6}$/.test(code) && /^[0-3]$/.test(level) && name) {
      occupations.push({ code, name, level: Number(level) });
    }
  }
  const datatypes: OewsDatatype[] = [];
  for (const [code = '', name = ''] of datatypeRows) {
    if (/^\d{2}$/.test(code) && name) datatypes.push({ code, name });
  }
  if (areas.size === 0 || occupations.length === 0 || datatypes.length === 0) return;
  return { areas, occupations, datatypes, vocabulary: vocabularyOf(areas, occupations, datatypes) };
}

function vocabularyOf(
  areas: ReadonlyMap<string, OewsArea>,
  occupations: readonly OewsOccupation[],
  datatypes: readonly OewsDatatype[],
): Vocabulary {
  const areaWords = new Map<string, { all: Set<string>; places: Set<string> }>();
  for (const { code, name } of areas.values()) {
    const all = new Set(words(name).filter((w) => w.length >= 3));
    areaWords.set(code, { all, places: new Set([...all].filter((w) => !PLACE_STOP_WORDS.has(w))) });
  }
  const occupationStems = occupations.map((o) => nameStems(o.name));
  const datatypeNameStems = datatypes.map((d) => words(d.name).map(stem));
  return {
    areaWords,
    areaVocabulary: new Set([...areaWords.values()].flatMap(({ all }) => [...all])),
    datatypeStems: datatypeNameStems.map((stems) =>
      stems.filter((s) => !GENERIC_DATATYPE_STEMS.has(s)),
    ),
    datatypeVocabulary: new Set(datatypeNameStems.flat()),
    occupationStems,
    occupationVocabulary: new Set(occupationStems.flatMap((s) => [...s])),
  };
}

/**
 * Whether BLS publishes this combination at all (May 2025 estimates): detailed
 * occupations and major groups in every area, minor and broad groups only
 * nationally, and no national employment per 1,000 jobs or location quotient.
 * Industry estimates are national-only, so composition keeps `000000` throughout.
 */
function published(area: OewsArea, occupation: OewsOccupation, datatype: OewsDatatype): boolean {
  if (area.areatype === 'N') return !SUBNATIONAL_DATATYPES.has(datatype.code);
  return occupation.level === 0 || occupation.level === 3;
}

/** A composed row, titled as BLS titles the series. Coverage is unknown, so absent. */
function composedRow(
  area: OewsArea,
  occupation: OewsOccupation,
  datatype: OewsDatatype,
): CatalogSeries {
  const place = area.areatype === 'N' ? 'the United States' : area.name;
  return {
    seriesId: `OEU${area.areatype}${area.code}${ALL_INDUSTRIES}${occupation.code}${datatype.code}`,
    title: `${datatype.name} for ${occupation.name} in All Industries in ${place}`,
    surveyAbbr: 'OE',
    areaName: area.name,
    itemName: occupation.name,
    seasonal: false,
    composed: true,
  };
}

/** The ranked list, paged. */
function page(
  rows: CatalogSeries[],
  input: CatalogSearchInput,
  capped: boolean,
): CatalogSearchResult {
  const offset = input.offset ?? 0;
  return {
    series: rows.slice(offset, offset + input.limit),
    total: rows.length,
    capped,
    composed: true,
  };
}

/**
 * The areas an `area` filter names: a USPS state code or two-digit state FIPS
 * code names the state, a five-digit CBSA code or a seven-digit OEWS area code
 * names that area; any other value matches area names as a case-insensitive
 * substring.
 */
function areasByFilter(tables: OewsTables, filter: string): OewsArea[] {
  const form = areaForm(filter);
  const value = form.kind === 'state' && form.state ? form.state.fips : filter.toLowerCase();
  if (/^\d+$/.test(value)) {
    const code =
      value.length === 2
        ? `${value}00000`
        : value.length === 5
          ? `00${value}`
          : value.length === 7
            ? value
            : undefined;
    const area = code === undefined ? undefined : tables.areas.get(code);
    return area ? [area] : [];
  }
  return [...tables.areas.values()].filter((a) => a.name.toLowerCase().includes(value));
}

/**
 * The areas place words in the query name: those sharing the most identifying
 * words with it, narrowed to the ones whose whole name it gives ("Washington"
 * the state, not the DC metro) when there are any.
 */
function areasByWords(tables: OewsTables, placeWords: ReadonlySet<string>): OewsArea[] {
  if (placeWords.size === 0) return [];
  let best = 0;
  let named: OewsArea[] = [];
  const whole: OewsArea[] = [];
  for (const area of tables.areas.values()) {
    const vocabulary = tables.vocabulary.areaWords.get(area.code);
    if (!vocabulary) continue;
    let score = 0;
    for (const w of vocabulary.places) if (placeWords.has(w)) score++;
    if (score === 0) continue;
    if ([...vocabulary.all].every((w) => placeWords.has(w))) whole.push(area);
    if (score > best) {
      best = score;
      named = [area];
    } else if (score === best) {
      named.push(area);
    }
  }
  return whole.length > 0 ? whole : named;
}

/**
 * The named areas, then each metro's state, then the nation — or the nation
 * alone when nothing is named. A filter that names no area composes nothing.
 */
function rankedAreas(named: OewsArea[], areas: ReadonlyMap<string, OewsArea>): OewsArea[] {
  const ranked = [...named];
  const seen = new Set(named.map((a) => a.code));
  const add = (area: OewsArea | undefined) => {
    if (area && !seen.has(area.code)) {
      seen.add(area.code);
      ranked.push(area);
    }
  };
  for (const area of named) if (area.areatype === 'M') add(areas.get(`${area.stateCode}00000`));
  add(areas.get(NATIONAL_AREA));
  return ranked;
}

/**
 * The data types the query names: those matching the most of their own words
 * (generic "wage", "per", "jobs" aside), then the largest share of them. With
 * none named, employment and the hourly and annual means.
 */
function selectDatatypes(tables: OewsTables, stems: ReadonlySet<string>): OewsDatatype[] {
  let best: OewsDatatype[] = [];
  let bestMatched = 0;
  let bestOf = 1;
  for (const [i, datatype] of tables.datatypes.entries()) {
    const own = tables.vocabulary.datatypeStems[i] ?? [];
    const matched = own.filter((s) => stems.has(s)).length;
    if (matched === 0) continue;
    // Compare matched/own.length against bestMatched/bestOf without floating point.
    const share = matched * bestOf - bestMatched * own.length;
    if (matched > bestMatched || (matched === bestMatched && share > 0)) {
      best = [datatype];
      bestMatched = matched;
      bestOf = own.length;
    } else if (matched === bestMatched && share === 0) {
      best.push(datatype);
    }
  }
  return best.length > 0
    ? best
    : tables.datatypes.filter((d) => DEFAULT_DATATYPES.includes(d.code));
}

/**
 * The occupations the query names, ranked: the most query words matched, then
 * the largest share of the occupation's own words, then BLS's order. A query
 * whose words name no occupation composes All Occupations; one whose occupation
 * words match none composes nothing.
 */
function rankOccupations(tables: OewsTables, stems: readonly string[]): OewsOccupation[] {
  if (stems.length === 0) {
    return tables.occupations.filter((o) => o.code === ALL_OCCUPATIONS);
  }
  const scored: Array<{ occupation: OewsOccupation; matched: number; of: number; i: number }> = [];
  for (const [i, occupation] of tables.occupations.entries()) {
    const own = tables.vocabulary.occupationStems[i];
    if (!own) continue;
    const matched = stems.filter((s) => own.has(s)).length;
    if (matched > 0) scored.push({ occupation, matched, of: own.size, i });
  }
  scored.sort((a, b) => b.matched - a.matched || a.of * b.matched - b.of * a.matched || a.i - b.i);
  return scored.map((s) => s.occupation);
}

/** Every published combination, in rank order: occupation, then area, then data type. */
function* combinations(
  occupations: readonly OewsOccupation[],
  areas: readonly OewsArea[],
  datatypes: readonly OewsDatatype[],
): Generator<CatalogSeries> {
  for (const occupation of occupations) {
    for (const area of areas) {
      for (const datatype of datatypes) {
        if (published(area, occupation, datatype)) yield composedRow(area, occupation, datatype);
      }
    }
  }
}

/** The row an OEWS SeriesID names, when the tables know its codes and BLS publishes the combination. */
function decode(tables: OewsTables, id: string): CatalogSeries | undefined {
  const match = OEWS_ID.exec(id);
  if (!match) return;
  const [, seasonal, areatype, areaCode = '', industry, occupationCode, datatypeCode] = match;
  const area = tables.areas.get(areaCode);
  const occupation = tables.occupations.find((o) => o.code === occupationCode);
  const datatype = tables.datatypes.find((d) => d.code === datatypeCode);
  if (seasonal !== 'U' || industry !== ALL_INDUSTRIES || area?.areatype !== areatype) return;
  if (!area || !occupation || !datatype || !published(area, occupation, datatype)) return;
  return composedRow(area, occupation, datatype);
}

/**
 * Compose the OEWS rows for a search, or undefined when composition does not
 * apply: another survey's filter, or an unscoped query that is not a decodable
 * OEWS SeriesID. The caller runs it only while the index holds no OE rows.
 * Under `survey: "OE"` it always answers, with no rows when nothing matches; an
 * `area` filter names the areas, place words in the query do without one, and
 * a named metro or state also composes its state and national rows. OEWS
 * publishes no seasonally adjusted series.
 */
export function composeOewsSearch(
  tables: OewsTables,
  input: CatalogSearchInput,
): CatalogSearchResult | undefined {
  const survey = input.survey?.trim().toUpperCase() || undefined;
  if (survey !== undefined && survey !== 'OE') return;
  const area = input.area?.trim() || undefined;
  const seriesId = input.query.trim().toUpperCase();

  if (OEWS_ID.test(seriesId)) {
    const row = decode(tables, seriesId);
    if (!row) return survey ? page([], input, false) : undefined;
    const areaCode = seriesId.slice(4, 11);
    const passes =
      input.seasonal_adjustment !== true &&
      (area === undefined || areasByFilter(tables, area).some((a) => a.code === areaCode));
    return page(passes ? [row] : [], input, false);
  }
  if (!survey) return;
  if (input.seasonal_adjustment === true) return page([], input, false);

  const { vocabulary } = tables;
  const queryWords = [...new Set(words(input.query))]
    .slice(0, MAX_QUERY_WORDS)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const datatypeStems = new Set(queryWords.map((w) => DATATYPE_ALIASES.get(stem(w)) ?? stem(w)));
  const remaining = queryWords.filter(
    (w) => !vocabulary.datatypeVocabulary.has(DATATYPE_ALIASES.get(stem(w)) ?? stem(w)),
  );
  // A word that is also an occupation word never names a place ("Mobile" stays an occupation word).
  const placeWords = new Set(
    area
      ? []
      : remaining.filter(
          (w) => vocabulary.areaVocabulary.has(w) && !vocabulary.occupationVocabulary.has(stem(w)),
        ),
  );
  const occupationStems = [...new Set(remaining.filter((w) => !placeWords.has(w)).map(stem))];

  const named = area ? areasByFilter(tables, area) : areasByWords(tables, placeWords);
  const areas = area && named.length === 0 ? [] : rankedAreas(named, tables.areas);
  const occupations = rankOccupations(tables, occupationStems);
  const datatypes = selectDatatypes(tables, datatypeStems);

  const rows: CatalogSeries[] = [];
  let capped = false;
  for (const row of combinations(occupations, areas, datatypes)) {
    if (rows.length === OEWS_COMPOSED_LIMIT) {
      capped = true;
      break;
    }
    rows.push(row);
  }
  return page(rows, input, capped);
}

/**
 * The rows that answer for an OEWS SeriesID BLS does not publish: a metro or
 * nonmetro area's state row (when the tables know its state and the occupation
 * is published below national), then the national row (unless the data type is
 * one BLS publishes only below national). An industry-specific ID falls back to
 * its national row alone, since industry estimates are national-only. Empty for
 * a national ID and for any other survey's ID.
 */
export function oewsFallbacks(seriesId: string, tables: OewsTables | undefined): string[] {
  const match = OEWS_ID.exec(seriesId);
  if (!match) return [];
  const [, , areatype, areaCode = '', industry, occupationCode, datatype = ''] = match;
  if (areatype === 'N') return [];
  const id = (type: Areatype, code: string) =>
    `OEU${type}${code}${industry}${occupationCode}${datatype}`;
  const fallbacks: string[] = [];
  const level = tables?.occupations.find((o) => o.code === occupationCode)?.level;
  if (areatype === 'M' && industry === ALL_INDUSTRIES && level !== 1 && level !== 2) {
    const stateCode = tables?.areas.get(areaCode)?.stateCode;
    const state = stateCode === undefined ? undefined : tables?.areas.get(`${stateCode}00000`);
    if (state) fallbacks.push(id('S', state.code));
  }
  if (!SUBNATIONAL_DATATYPES.has(datatype)) fallbacks.push(id('N', NATIONAL_AREA));
  return fallbacks;
}
