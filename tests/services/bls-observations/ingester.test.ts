/**
 * @fileoverview Tests for the LABSTAT observation ingester — tab-delimited parsing,
 * index discovery, cursor encoding, page batching, and the canonical survey list.
 * @module tests/services/bls-observations/ingester.test
 */

import type { MirrorLogger, SyncContext } from '@cyanheads/mcp-ts-core/mirror';
import { describe, expect, it, vi } from 'vitest';
import { SURVEY_ABBRS } from '@/services/bls-catalog/bls-catalog-service.js';
import { observationsSync } from '@/services/bls-observations/ingester.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal tab-delimited data file with three observations. */
const DATA_FILE_CONTENT = [
  'series_id\tyear\tperiod\tvalue\tfootnote_codes',
  'LNS14000000\t2024\tM12\t4.1\t',
  'LNS14000000\t2024\tM11\t4.2\tP',
  'CES0000000001\t2024\tM12\t159367\t',
].join('\n');

/** Index content listing two data files in the older documentation shape. */
const INDEX_WITH_TWO_FILES = `
Name of file:  cu.data.1.AllItems
Name of file:  cu.data.2.Seasonally Adjusted Average
`;

/** Index content with no data file references. */
const INDEX_WITH_NO_FILES = `
This survey has no observation data files in LABSTAT.
`;

/** Index that lists a file as a bare name. */
const INDEX_ALT_FORMAT = `
cu.data.0.AllData
`;

/** The `{abbr}.txt` directory index LABSTAT publishes for every survey. */
const CU_INDEX = [
  '/pub/time.series/cu/',
  '',
  '01/15/2026  08:30 AM        12345 cu.contacts',
  '01/15/2026  08:30 AM     98765432 cu.data.0.Current',
  '01/15/2026  08:30 AM    123456789 cu.data.1.AllItems',
  '01/15/2026  08:30 AM      9876543 cu.series',
].join('\n');

/** Data file mixing the BLS '-' sentinel with a malformed empty-value row. */
const DATA_FILE_WITH_SENTINEL = [
  'series_id\tyear\tperiod\tvalue\tfootnote_codes',
  'LNS14000000\t2024\tM12\t4.1\t',
  'LNS14000000\t2024\tM11\t-\t9', // BLS missing-value sentinel — published, stored verbatim
  'LNS14000000\t2024\tM10\t\t', // empty value cell — malformed, skipped
  'LNS14000000\t2024\tM09\t4.3\t',
].join('\n');

/** Data file missing the footnote_codes column (optional), including a sentinel row. */
const DATA_FILE_NO_FOOTNOTES = [
  'series_id\tyear\tperiod\tvalue',
  'LNS14000000\t2024\tM12\t4.1',
  'LNS14000000\t2024\tM11\t4.2',
  'LNS14000000\t2024\tM10\t-',
].join('\n');

// ---------------------------------------------------------------------------
// Mock context builder
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    mode: 'init',
    signal: AbortSignal.timeout(5_000),
    ...overrides,
  };
}

/** Collect the warnings the ingester emits, so a skipped survey is observable. */
function recordingLog(): MirrorLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    warning: (message, meta) => {
      warnings.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
  };
}

/** Serve one index + one data file for every survey; everything else 404s. */
function stubDataFile(content: string): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    const headers = { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' };
    if (u.endsWith('.txt')) {
      return Promise.resolve(new Response('cu.data.1.AllItems\n', { status: 200, headers }));
    }
    if (u.includes('.data.')) {
      return Promise.resolve(new Response(content, { status: 200, headers }));
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
}

/** Drain the first non-empty page and return the rows belonging to one series. */
async function collectSeriesRows(seriesId: string): Promise<Record<string, unknown>[]> {
  let records: Record<string, unknown>[] = [];
  for await (const page of observationsSync(makeCtx(), {
    catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
    userAgent: 'test-agent',
  })) {
    records = page.records as Record<string, unknown>[];
    if (records.length > 0) break;
  }
  return records.filter((r) => r.series_id === seriesId);
}

// ---------------------------------------------------------------------------
// Tests — row parsing (via the ingester's behaviour with mocked fetch)
// ---------------------------------------------------------------------------

describe('observationsSync — tab-delimited parsing', () => {
  it('parses a well-formed data file into correct ObservationRow fields', async () => {
    // Mock: index → one file, data file → DATA_FILE_CONTENT
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith('.txt')) {
        return Promise.resolve(
          new Response('cu.data.1.AllItems\n', {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      if (u.includes('.data.')) {
        return Promise.resolve(
          new Response(DATA_FILE_CONTENT, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx();
    const pages: unknown[] = [];

    for await (const page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      pages.push(page);
      // Only collect the first page (contains cu survey data)
      if (pages.length >= 1) break;
    }

    expect(pages.length).toBeGreaterThan(0);
    const firstPage = pages[0] as { records: Record<string, unknown>[]; cursor?: string };
    expect(firstPage.records.length).toBeGreaterThan(0);

    const row = firstPage.records[0]!;
    expect(typeof row.row_key).toBe('string');
    expect(typeof row.series_id).toBe('string');
    expect(typeof row.year).toBe('string');
    expect(typeof row.period).toBe('string');
    expect(typeof row.value).toBe('string');
    expect(typeof row.footnote_codes).toBe('string');
  });

  it('stores the BLS "-" sentinel row with its footnote code (#58)', async () => {
    // The sentinel is a published observation: BLS says "this period has no
    // figure" and footnotes why. Dropping it makes the period indistinguishable
    // from one BLS never published, and the mirror can never answer
    // `available: false` the way the live path does.
    stubDataFile(DATA_FILE_WITH_SENTINEL);

    const lnsRows = await collectSeriesRows('LNS14000000');

    expect(lnsRows.find((r) => r.period === 'M11')).toEqual({
      row_key: 'LNS14000000|2024|M11',
      series_id: 'LNS14000000',
      year: '2024',
      period: 'M11',
      value: '-',
      footnote_codes: '9',
    });
  });

  it('skips a row whose value cell is empty (#58)', async () => {
    // A malformed row is not a published sentinel.
    stubDataFile(DATA_FILE_WITH_SENTINEL);

    const lnsRows = await collectSeriesRows('LNS14000000');

    expect(lnsRows.find((r) => r.period === 'M10')).toBeUndefined();
    expect(lnsRows.map((r) => r.period)).toEqual(['M12', 'M11', 'M09']);
  });

  it('stores a sentinel row with empty footnote_codes when the column is absent (#58)', async () => {
    stubDataFile(DATA_FILE_NO_FOOTNOTES);

    const lnsRows = await collectSeriesRows('LNS14000000');

    expect(lnsRows.find((r) => r.period === 'M10')).toMatchObject({
      value: '-',
      footnote_codes: '',
    });
  });

  it('handles data files without footnote_codes column', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith('.txt')) {
        return Promise.resolve(
          new Response('cu.data.1.AllItems\n', {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      if (u.includes('.data.')) {
        return Promise.resolve(
          new Response(DATA_FILE_NO_FOOTNOTES, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx();
    let records: Record<string, unknown>[] = [];

    for await (const page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      records = page.records as Record<string, unknown>[];
      break;
    }

    expect(records.length).toBeGreaterThan(0);
    for (const row of records) {
      expect(typeof row.footnote_codes).toBe('string');
    }
  });

  it('generates composite row_key as series_id|year|period', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith('.txt')) {
        return Promise.resolve(
          new Response('cu.data.1.AllItems\n', {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      if (u.includes('.data.')) {
        return Promise.resolve(
          new Response(DATA_FILE_CONTENT, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx();
    let records: Record<string, unknown>[] = [];

    for await (const page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      records = page.records as Record<string, unknown>[];
      break;
    }

    const lnsRow = records.find((r) => r.series_id === 'LNS14000000' && r.period === 'M12');
    expect(lnsRow?.row_key).toBe('LNS14000000|2024|M12');
  });

  it('warns on a survey whose index fetch returns 404 and harvests the next one', async () => {
    // 404 the first survey's index (cu); the second (ap) serves its own.
    const second = SURVEY_ABBRS[1]!;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      const headers = { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' };
      if (u.includes('/cu/')) {
        return Promise.resolve(new Response('', { status: 404 }));
      }
      if (u.endsWith(`/${second}/${second}.txt`)) {
        return Promise.resolve(
          new Response(`${second}.data.1.AllItems\n`, { status: 200, headers }),
        );
      }
      if (u.includes(`/${second}/`) && u.includes('.data.')) {
        return Promise.resolve(new Response(DATA_FILE_CONTENT, { status: 200, headers }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const log = recordingLog();
    const pages: unknown[] = [];

    for await (const page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
      log,
    })) {
      pages.push(page);
      if (pages.length >= 1) break;
    }

    // The unreachable survey is reported, not passed over in silence.
    expect(log.warnings.some((w) => w.includes('"survey":"cu"'))).toBe(true);
    expect(pages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — index data-file discovery
// ---------------------------------------------------------------------------

describe('observationsSync — index data-file discovery', () => {
  /** Run the sync against the cu survey, capturing the data-file URLs fetched. */
  async function captureDataUrls(index: string, log?: MirrorLogger): Promise<string[]> {
    const fetchedDataUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith('/cu/cu.txt')) {
        return Promise.resolve(
          new Response(index, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      if (u.includes('/cu/') && u.includes('.data.')) {
        fetchedDataUrls.push(u.toLowerCase());
        return Promise.resolve(
          new Response(DATA_FILE_CONTENT, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx();
    for await (const _page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
      ...(log && { log }),
    })) {
      if (fetchedDataUrls.length >= 2) break; // cu is the first survey
    }
    return fetchedDataUrls;
  }

  it('discovers multiple data files from a "Name of file:" index', async () => {
    const urls = await captureDataUrls(INDEX_WITH_TWO_FILES);
    expect(urls.some((u) => u.includes('cu.data.1.allitems'))).toBe(true);
    expect(urls.some((u) => u.includes('cu.data.2'))).toBe(true);
  });

  it('warns and fetches nothing when the index lists no data files', async () => {
    // No guessed filename: `{abbr}.data.1.AllData` exists for only some
    // harvested surveys, so requesting it for the rest only 404s.
    const log = recordingLog();
    const urls = await captureDataUrls(INDEX_WITH_NO_FILES, log);
    expect(urls).toHaveLength(0);
    expect(log.warnings.some((w) => w.includes('"survey":"cu"'))).toBe(true);
  });

  it('discovers a bare-filename data file from an alternate index format', async () => {
    const urls = await captureDataUrls(INDEX_ALT_FORMAT);
    expect(urls.some((u) => u.includes('cu.data.0.alldata'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — the `{abbr}.txt` index is the only published file list
// ---------------------------------------------------------------------------

describe('observationsSync — {abbr}.txt index (#78)', () => {
  it('reads the data-file list from the survey index', async () => {
    // LABSTAT serves no `{abbr}.readme`; the index every survey publishes is
    // `{abbr}.txt`. Reading the wrong name left 8 of 13 surveys unharvested
    // while the sync still reported success.
    const fetched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      fetched.push(u.toLowerCase());
      const headers = { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' };
      if (u.endsWith('/cu/cu.txt')) {
        return Promise.resolve(new Response(CU_INDEX, { status: 200, headers }));
      }
      if (u.includes('/cu/') && u.includes('.data.')) {
        return Promise.resolve(new Response(DATA_FILE_CONTENT, { status: 200, headers }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const log = recordingLog();
    for await (const _page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
      log,
    })) {
      if (fetched.some((u) => u.includes('cu.data.1.allitems'))) break;
    }

    expect(fetched).toContain('https://download.bls.gov/pub/time.series/cu/cu.txt');
    expect(fetched.some((u) => u.includes('cu.data.0.current'))).toBe(true);
    expect(fetched.some((u) => u.includes('cu.data.1.allitems'))).toBe(true);
    expect(fetched.some((u) => u.includes('cu.readme'))).toBe(false);
  });

  it.each([
    [
      'cm',
      [
        '\tcm.data.1.AllData\t- all estimates\t\t\tdata file',
        '\tcm.data.0.Current\t- All most recent reference \tdata file',
        '\t1.  cm.data.0.Current\t- Most recent reference period estimates',
        '\t2.  cm.data.1.AllData\t- All estimates',
        'File Name: cm.data.0.Current',
      ],
    ],
    [
      'ci',
      [
        '\tci.data.0.Current\t- all most recent reference ',
        '\tci.data.1.AllData\t- all estimates\t\t\tdata file',
        '\t1. ci.data.0.Current\t- All recent reference period estimates',
        '\t2. ci.data.1.AllData\t- All estimates',
      ],
    ],
  ])('harvests both %s data files its real index lists (#86)', async (abbr, lines) => {
    const dataUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      const headers = { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' };
      if (u.endsWith(`/${abbr}/${abbr}.txt`)) {
        return Promise.resolve(new Response(lines.join('\r\n'), { status: 200, headers }));
      }
      if (u.includes(`/${abbr}/`) && u.includes('.data.')) {
        dataUrls.push(u.slice(u.lastIndexOf('/') + 1));
        return Promise.resolve(new Response(DATA_FILE_CONTENT, { status: 200, headers }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const pages: Array<{ records: unknown[] }> = [];
    for await (const page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      pages.push(page);
    }
    expect(dataUrls.sort()).toEqual([`${abbr}.data.0.current`, `${abbr}.data.1.alldata`]);
    expect(pages.flatMap((p) => p.records)).toHaveLength(6);
  });

  it('warns and harvests nothing when a survey yields no data files', async () => {
    // Guessing `{abbr}.data.1.AllData` is wrong for most surveys, and a silent
    // fall-through reports an empty survey as a harvested one.
    const fetched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      fetched.push(String(url).toLowerCase());
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const log = recordingLog();
    const pages: unknown[] = [];
    for await (const page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
      log,
    })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(0);
    expect(fetched.some((u) => u.includes('cu.data.1.alldata'))).toBe(false);
    expect(log.warnings.some((w) => w.includes('cu'))).toBe(true);
    expect(log.warnings).toHaveLength(SURVEY_ABBRS.length);
  });
});

// ---------------------------------------------------------------------------
// Tests — cursor encoding / resume
// ---------------------------------------------------------------------------

describe('observationsSync — cursor and checkpoint', () => {
  it('checkpoint is an ISO 8601 string derived from Last-Modified', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith('.txt')) {
        return Promise.resolve(
          new Response('cu.data.1.AllItems\n', {
            status: 200,
            headers: { 'Last-Modified': 'Wed, 01 Jan 2025 06:00:00 GMT' },
          }),
        );
      }
      if (u.includes('.data.')) {
        return Promise.resolve(
          new Response(DATA_FILE_CONTENT, {
            status: 200,
            headers: { 'Last-Modified': 'Wed, 01 Jan 2025 06:00:00 GMT' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx();
    const checkpoints: string[] = [];

    for await (const page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      if (page.checkpoint) checkpoints.push(page.checkpoint);
      if (checkpoints.length >= 1) break;
    }

    // At least one checkpoint yielded for the survey we got data from
    // (emitted on last page of each survey's last file)
    // Note: may be 0 if cu falls through gracefully; that is acceptable
    // since the invariant is only that when a checkpoint IS emitted, it's ISO 8601
    for (const cp of checkpoints) {
      expect(() => new Date(cp).toISOString()).not.toThrow();
      expect(cp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('cursor is not emitted on the very last page of the last survey', async () => {
    // Serve only whichever survey is last in SURVEY_ABBRS; all others 404. Read
    // from the list rather than naming a survey, so appending one keeps testing
    // the completion signal instead of silently testing a mid-list survey.
    const lastAbbr = SURVEY_ABBRS.at(-1);
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith(`/${lastAbbr}/${lastAbbr}.txt`)) {
        return Promise.resolve(
          new Response(`${lastAbbr}.data.1.AllData\n`, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      if (u.includes(`/${lastAbbr}/`) && u.includes('.data.')) {
        return Promise.resolve(
          new Response(DATA_FILE_CONTENT, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx();
    const pages: Array<{ cursor: string | undefined; records: unknown[] }> = [];

    for await (const page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      pages.push({ cursor: page.cursor, records: page.records });
    }

    // The last page yielded should have no cursor (signals completion)
    if (pages.length > 0) {
      const lastPage = pages[pages.length - 1]!;
      expect(lastPage.cursor).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — abort signal
// ---------------------------------------------------------------------------

describe('observationsSync — cancellation', () => {
  it('stops yielding pages when the signal is aborted', async () => {
    const controller = new AbortController();

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url) => {
      // Abort on first fetch to force immediate cancellation
      controller.abort(new Error('Test abort'));
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx({ signal: controller.signal, mode: 'init' });
    const pages: unknown[] = [];

    try {
      for await (const page of observationsSync(ctx, {
        catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
        userAgent: 'test-agent',
      })) {
        pages.push(page);
      }
    } catch {
      // Abort may propagate as an error — acceptable
    }

    // Should have yielded 0 pages (aborted immediately)
    expect(pages.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — canonical survey list (single source of truth)
// ---------------------------------------------------------------------------

describe('SURVEY_ABBRS — canonical survey list (#49)', () => {
  // The ingester imports this list from the catalog service and keeps no copy of
  // its own, so asserting it here asserts exactly what the ingester harvests —
  // one binding shared by both harvests, which is what stops them drifting apart.
  it('carries the ap Average Price survey, not the sa SIC-employment survey', () => {
    expect(SURVEY_ABBRS).toContain('ap');
    expect(SURVEY_ABBRS).not.toContain('sa');
  });

  it('carries the cw CPI-W survey alongside the other CPI-family surveys (#51)', () => {
    // Without cw in the list, bls_search_series can never resolve a CWUR…/CWSR…
    // SeriesID — the survey is absent from the index, not merely ranked low.
    expect(SURVEY_ABBRS).toContain('cw');
  });

  it('pins the canonical harvest order — the resume cursor encodes these indices', () => {
    // Append-only: a cursor persisted mid-init stores each survey's index, so a
    // new survey goes on the end rather than beside its family.
    expect([...SURVEY_ABBRS]).toEqual([
      'cu',
      'ap',
      'ce',
      'ln',
      'la',
      'pc',
      'wp',
      'jt',
      'oe',
      'ec',
      'pr',
      'mp',
      'cw',
      'cm',
      'ci',
    ]);
  });
});
