/**
 * @fileoverview Shared OE code-table fixtures for the OEWS composition tests
 * (#119, #121): real `oe.area`, `oe.occupation`, and `oe.datatype` rows from the
 * 2026-05-15 LABSTAT files, rendered as LABSTAT serves them (tab-delimited,
 * CRLF), plus the three files keyed by file name for a fetch mock.
 * @module tests/services/bls-catalog/oews-fixtures
 */

import type { MirrorStore } from '@cyanheads/mcp-ts-core/mirror';

/** Render rows as a LABSTAT flat file: tab-delimited, CRLF line endings. */
export function tsv(...rows: string[][]): string {
  return `${rows.map((r) => r.join('\t')).join('\r\n')}\r\n`;
}

export const OE_AREA = tsv(
  ['state_code', 'area_code', 'areatype_code', 'area_name'],
  ['00', '0000000', 'N', 'National'],
  ['11', '0047900', 'M', 'Washington-Arlington-Alexandria, DC-VA-MD-WV'],
  ['11', '1100000', 'S', 'District of Columbia'],
  ['23', '0038860', 'M', 'Portland-South Portland, ME'],
  ['23', '2300000', 'S', 'Maine'],
  ['36', '0035620', 'M', 'New York-Newark-Jersey City, NY-NJ'],
  ['36', '3600000', 'S', 'New York'],
  ['41', '0038900', 'M', 'Portland-Vancouver-Hillsboro, OR-WA'],
  ['41', '4100000', 'S', 'Oregon'],
  ['42', '0049620', 'M', 'York-Hanover, PA'],
  ['48', '4800000', 'S', 'Texas'],
  ['53', '0042660', 'M', 'Seattle-Tacoma-Bellevue, WA'],
  ['53', '0047460', 'M', 'Walla Walla, WA'],
  ['53', '5300000', 'S', 'Washington'],
  ['53', '5300006', 'M', 'Western Washington nonmetropolitan area'],
);

export const OE_OCCUPATION = tsv(
  [
    'occupation_code',
    'occupation_name',
    'occupation_description',
    'display_level',
    'selectable',
    'sort_sequence',
  ],
  ['000000', 'All Occupations', '', '0', 'T', '0'],
  ['111011', 'Chief Executives', 'Determine and formulate policies.', '3', 'T', '3'],
  ['131020', 'Buyers and Purchasing Agents', 'Buy product for resale.', '3', 'T', '52'],
  ['172161', 'Nuclear Engineers', 'Conduct research on nuclear projects.', '3', 'T', '144'],
  [
    '252021',
    'Elementary School Teachers, Except Special Education',
    'Teach academic and social skills.',
    '3',
    'T',
    '321',
  ],
  ['290000', 'Healthcare Practitioners and Technical Occupations', '', '0', 'T', '410'],
  ['291000', 'Healthcare Diagnosing or Treating Practitioners', '', '1', 'T', '411'],
  ['291120', 'Therapists', '', '2', 'T', '424'],
  ['291141', 'Registered Nurses', 'Assess patient health problems and needs.', '3', 'T', '434'],
  ['291151', 'Nurse Anesthetists', 'Administer anesthesia.', '3', 'T', '435'],
  ['291161', 'Nurse Midwives', 'Diagnose and coordinate the birthing process.', '3', 'T', '436'],
  [
    '291171',
    'Nurse Practitioners',
    'Diagnose and treat acute or chronic illness.',
    '3',
    'T',
    '437',
  ],
  [
    '292061',
    'Licensed Practical and Licensed Vocational Nurses',
    'Care for ill, injured, or convalescing patients.',
    '3',
    'T',
    '481',
  ],
);

export const OE_DATATYPE = tsv(
  ['datatype_code', 'datatype_name'],
  ['01', 'Employment'],
  ['02', 'Employment percent relative standard error'],
  ['03', 'Hourly mean wage'],
  ['04', 'Annual mean wage'],
  ['05', 'Wage percent relative standard error'],
  ['06', 'Hourly 10th percentile wage'],
  ['07', 'Hourly 25th percentile wage'],
  ['08', 'Hourly median wage'],
  ['09', 'Hourly 75th percentile wage'],
  ['10', 'Hourly 90th percentile wage'],
  ['11', 'Annual 10th percentile wage'],
  ['12', 'Annual 25th percentile wage'],
  ['13', 'Annual median wage'],
  ['14', 'Annual 75th percentile wage'],
  ['15', 'Annual 90th percentile wage'],
  ['16', 'Employment per 1,000 jobs'],
  ['17', 'Location Quotient'],
);

/** The three OE code tables, keyed by LABSTAT file name. */
export const OE_TABLE_FILES: Readonly<Record<string, string>> = {
  'oe.area': OE_AREA,
  'oe.occupation': OE_OCCUPATION,
  'oe.datatype': OE_DATATYPE,
};

/**
 * Store the three tables in a catalog index, as a harvest that fetched them
 * leaves it: a seeded `complete` state then vouches for them on restart too.
 */
export async function storeOewsTables(store: MirrorStore): Promise<void> {
  const insert = (await store.raw()).prepare(
    'INSERT INTO bls_oews_tables (name, body) VALUES (?, ?)',
  );
  for (const [file, body] of Object.entries(OE_TABLE_FILES)) {
    insert.run(file.slice('oe.'.length), body);
  }
}
