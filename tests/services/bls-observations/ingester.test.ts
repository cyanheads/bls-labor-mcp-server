/**
 * @fileoverview Tests for the LABSTAT observation ingester — tab-delimited parsing,
 * index discovery, cursor encoding, page batching, and the canonical survey list.
 * @module tests/services/bls-observations/ingester.test
 */

import { readFileSync } from 'node:fs';
import type { MirrorLogger, SyncContext, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import { describe, expect, it, vi } from 'vitest';
import { SURVEY_ABBRS } from '@/services/bls-catalog/bls-catalog-service.js';
import { observationsSync, syncFootnoteTables } from '@/services/bls-observations/ingester.js';
import type { SyncGaps } from '@/services/bls-observations/types.js';
import { type FakeLabstat, fakeLabstat } from './labstat-fake.js';

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

/** Serve the first survey one data file; everything else 404s. */
function stubDataFile(content: string): void {
  stubLabstat({ cu: { 'cu.data.1.AllItems': { body: content } } });
}

const DEFAULT_LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';

/**
 * Stub LABSTAT for the given surveys: each survey's directory listing names its
 * files, and each file answers as described (`Last-Modified` defaults to
 * {@link DEFAULT_LAST_MODIFIED}). Every other URL 404s. Returns the fake, whose
 * `requested` lists the URLs asked for, in order.
 */
function stubLabstatFake(surveys: FakeLabstat): ReturnType<typeof fakeLabstat> {
  for (const files of Object.values(surveys)) {
    for (const [name, file] of Object.entries(files)) {
      if (name !== '') file.lastModified ??= DEFAULT_LAST_MODIFIED;
    }
  }
  const fake = fakeLabstat(surveys);
  vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch);
  return fake;
}

/** {@link stubLabstatFake}, returning only the requested URLs. */
function stubLabstat(surveys: FakeLabstat): string[] {
  return stubLabstatFake(surveys).requested;
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
    stubDataFile(DATA_FILE_CONTENT);

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
    stubDataFile(DATA_FILE_NO_FOOTNOTES);

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
    stubDataFile(DATA_FILE_CONTENT);

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

  it('warns on a survey whose listing fetch returns 404 and harvests the next one', async () => {
    // 404 the first survey's listing (cu); the second (ap) serves its own.
    const second = SURVEY_ABBRS[1]!;
    stubLabstat({ [second]: { [`${second}.data.1.AllItems`]: { body: DATA_FILE_CONTENT } } });

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
// Tests — listing data-file discovery
// ---------------------------------------------------------------------------

describe('observationsSync — listing data-file discovery', () => {
  /** Run the sync against the cu survey's listing, capturing the data-file URLs fetched. */
  async function captureDataUrls(files: string[], log?: MirrorLogger): Promise<string[]> {
    const requested = stubLabstat({
      cu: Object.fromEntries(files.map((name) => [name, { body: DATA_FILE_CONTENT }])),
    });

    const ctx = makeCtx();
    for await (const _page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
      ...(log && { log }),
    })) {
      // drain
    }
    return requested
      .filter((u) => u.includes('/cu/') && u.includes('.data.'))
      .map((u) => u.toLowerCase());
  }

  it('discovers multiple data files from the listing', async () => {
    const urls = await captureDataUrls(['cu.data.1.AllItems', 'cu.data.2.Summaries', 'cu.series']);
    expect(urls.some((u) => u.includes('cu.data.1.allitems'))).toBe(true);
    expect(urls.some((u) => u.includes('cu.data.2'))).toBe(true);
  });

  it('warns and fetches nothing when the listing names no data files', async () => {
    // No guessed filename: `{abbr}.data.1.AllData` exists for only some
    // harvested surveys, so requesting it for the rest only 404s.
    const log = recordingLog();
    const urls = await captureDataUrls(['cu.series', 'cu.footnote'], log);
    expect(urls).toHaveLength(0);
    expect(log.warnings.some((w) => w.includes('"survey":"cu"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — data files come from the survey's directory listing (#124)
// ---------------------------------------------------------------------------

/** A captured LABSTAT fixture under `tests/fixtures/labstat-listings/`. */
function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/labstat-listings/${name}`, import.meta.url), 'utf8');
}

/** Non-empty lines of a captured name list. */
function names(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

describe('observationsSync — directory-listing discovery (#124)', () => {
  /**
   * Serve one survey the way download.bls.gov did on 2026-11-01: its captured
   * directory listing, an `{abbr}.txt` naming the files its description
   * documents, and a data file for each name the listing serves. Everything
   * else — a documented name the listing lacks included — 404s.
   */
  function serveCapturedSurvey(abbr: string): string[] {
    const listed = new Set(names(fixture(`${abbr}.files`)));
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      const prefix = `https://download.bls.gov/pub/time.series/${abbr}/`;
      if (!u.startsWith(prefix)) return Promise.resolve(new Response('', { status: 404 }));
      const name = decodeURIComponent(u.slice(prefix.length));
      requested.push(name);
      const headers = { 'Last-Modified': 'Thu, 15 Oct 2026 07:30:00 GMT' };
      if (name === '') {
        return Promise.resolve(new Response(fixture(`${abbr}.listing`), { status: 200, headers }));
      }
      if (name === `${abbr}.txt`) {
        return Promise.resolve(new Response(fixture(`${abbr}.stale`), { status: 200, headers }));
      }
      return Promise.resolve(
        listed.has(name)
          ? new Response(DATA_FILE_CONTENT, { status: 200, headers })
          : new Response('', { status: 404 }),
      );
    });
    return requested;
  }

  it.each([
    ['pc', 'every one of 71 files, none of which its description names as served'],
    ['ce', 'the 10 files its description misnames'],
    ['wp', 'wp.data.80i.ConstructnInputs, which its description misnames'],
    ['jt', 'jt.data.8.UnemployedPerJobOpeningRatio, which its description omits'],
  ])('reads every data file the captured %s listing serves — %s', async (abbr) => {
    const requested = serveCapturedSurvey(abbr);

    for await (const _page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      // drain
    }

    const dataRequests = requested.filter((n) => n.toLowerCase().startsWith(`${abbr}.data.`));
    expect(dataRequests).toEqual(names(fixture(`${abbr}.files`)));
  });

  it('requests a listed name containing a space URL-encoded, never cut at the space', async () => {
    const requested = stubLabstat({
      cu: {
        'cu.data.1.All Items': { body: DATA_FILE_CONTENT },
        'cu.series': {},
        'cu.footnote': {},
        'cu.dataelement': {},
      },
    });

    for await (const _page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      // drain
    }

    const cuRequests = requested.filter((u) => u.includes('/cu/'));
    expect(cuRequests).toContain('https://download.bls.gov/pub/time.series/cu/');
    expect(cuRequests.filter((u) => u.includes('.data'))).toEqual([
      'https://download.bls.gov/pub/time.series/cu/cu.data.1.All%20Items',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests — the directory listing is the file list
// ---------------------------------------------------------------------------

describe('observationsSync — the directory listing is the file list (#78, #124)', () => {
  it('reads the data-file list from the survey listing, not its description files', async () => {
    // LABSTAT serves no `{abbr}.readme`, and the `{abbr}.txt` description names
    // files the directory does not hold. Reading either left surveys
    // unharvested while the sync still reported success.
    const requested = stubLabstat({
      cu: {
        'cu.contacts': {},
        'cu.data.0.Current': { body: DATA_FILE_CONTENT },
        'cu.data.1.AllItems': { body: DATA_FILE_CONTENT },
        'cu.series': {},
        'cu.txt': {},
      },
    });
    const lowered = (): string[] => requested.map((u) => u.toLowerCase());

    const log = recordingLog();
    for await (const _page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
      log,
    })) {
      if (lowered().some((u) => u.includes('cu.data.1.allitems'))) break;
    }
    const fetched = lowered();

    expect(fetched).toContain('https://download.bls.gov/pub/time.series/cu/');
    expect(fetched.some((u) => u.includes('cu.data.0.current'))).toBe(true);
    expect(fetched.some((u) => u.includes('cu.data.1.allitems'))).toBe(true);
    expect(fetched.some((u) => u.includes('cu.readme'))).toBe(false);
    expect(fetched.some((u) => u.endsWith('/cu.txt'))).toBe(false);
  });

  it.each([
    ['cm', ['cm.contacts', 'cm.data.0.Current', 'cm.data.1.AllData', 'cm.series']],
    ['ci', ['ci.contacts', 'ci.data.0.Current', 'ci.data.1.AllData', 'ci.series']],
  ])('harvests both %s data files its listing serves (#86)', async (abbr, listed) => {
    const requested = stubLabstat({
      [abbr]: Object.fromEntries(listed.map((name) => [name, { body: DATA_FILE_CONTENT }])),
    });
    const dataUrls = (): string[] =>
      requested
        .filter((u) => u.includes(`/${abbr}/`) && u.includes('.data.'))
        .map((u) => u.slice(u.lastIndexOf('/') + 1).toLowerCase());

    const pages: Array<{ records: unknown[] }> = [];
    for await (const page of observationsSync(makeCtx(), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      pages.push(page);
    }
    expect(dataUrls().sort()).toEqual([`${abbr}.data.0.current`, `${abbr}.data.1.alldata`]);
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
    stubLabstat({
      cu: {
        'cu.data.1.AllItems': {
          body: DATA_FILE_CONTENT,
          lastModified: 'Wed, 01 Jan 2025 06:00:00 GMT',
        },
      },
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

  it('resumes an interrupted init from its survey:file:row cursor', async () => {
    // `0:1:2` — the first survey, its second data file, past that file's first two rows.
    const requested = stubLabstat({
      cu: {
        'cu.data.0.Current': { body: DATA_FILE_CONTENT },
        'cu.data.1.AllItems': { body: DATA_FILE_WITH_SENTINEL },
      },
    });

    const pages: Array<{ records: Record<string, unknown>[] }> = [];
    for await (const page of observationsSync(makeCtx({ cursor: '0:1:2' }), {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      pages.push(page as { records: Record<string, unknown>[] });
    }

    expect(requested.some((u) => u.toLowerCase().endsWith('/cu.data.0.current'))).toBe(false);
    expect(pages.flatMap((p) => p.records).map((r) => r.row_key)).toEqual(['LNS14000000|2024|M09']);
  });

  it('cursor is not emitted on the very last page of the last survey', async () => {
    // Serve only whichever survey is last in SURVEY_ABBRS; all others 404. Read
    // from the list rather than naming a survey, so appending one keeps testing
    // the completion signal instead of silently testing a mid-list survey.
    const lastAbbr = SURVEY_ABBRS.at(-1)!;
    stubLabstat({ [lastAbbr]: { [`${lastAbbr}.data.1.AllData`]: { body: DATA_FILE_CONTENT } } });

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
// Tests — the checkpoint advances only after a run reads every listed file (#117)
// ---------------------------------------------------------------------------

/** Run a sync to completion, returning its pages and the gaps it reports. */
async function drain(
  ctx: SyncContext,
  log?: MirrorLogger,
): Promise<{ gaps: SyncGaps; pages: SyncPage[] }> {
  const run = observationsSync(ctx, {
    catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
    userAgent: 'test-agent',
    ...(log && { log }),
  });
  const pages: SyncPage[] = [];
  for (;;) {
    const step = await run.next();
    if (step.done) return { gaps: step.value, pages };
    pages.push(step.value);
  }
}

/** {@link drain} under fake timers, so retry backoff and stall timeouts elapse instantly. */
async function drainWithFakeTimers(
  ctx: SyncContext,
  log?: MirrorLogger,
): Promise<{ gaps: SyncGaps; pages: SyncPage[] }> {
  vi.useFakeTimers();
  try {
    const result = drain(ctx, log);
    await vi.runAllTimersAsync();
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

/** A data file holding `count` rows of one series, oldest first. */
function dataRows(count: number, seriesId = 'LNS14000000'): string {
  const lines = ['series_id\tyear\tperiod\tvalue\tfootnote_codes'];
  for (let i = 0; i < count; i++) {
    lines.push(
      `${seriesId}\t${1900 + Math.floor(i / 12)}\tM${String((i % 12) + 1).padStart(2, '0')}\t${i}\t`,
    );
  }
  return lines.join('\r\n');
}

const CU_URL = 'https://download.bls.gov/pub/time.series/cu/cu.data.1.AllItems';

/** Serve every survey a data file holding no rows, then apply `overrides` survey by survey. */
function allSurveys(overrides: FakeLabstat): FakeLabstat {
  const quiet = SURVEY_ABBRS.map((abbr) => [
    abbr,
    { [`${abbr}.data.1.AllItems`]: { body: 'series_id\tyear\tperiod\tvalue\tfootnote_codes' } },
  ]);
  return { ...Object.fromEntries(quiet), ...overrides };
}

describe('observationsSync — checkpoint and unread files (#117)', () => {
  it('emits the checkpoint once, on a final empty page after the last survey', async () => {
    stubLabstat(
      allSurveys({
        cu: {
          'cu.data.1.AllItems': {
            body: DATA_FILE_CONTENT,
            lastModified: 'Wed, 01 Jan 2025 06:00:00 GMT',
          },
        },
        ap: {
          'ap.data.1.AllItems': {
            body: DATA_FILE_CONTENT,
            lastModified: 'Sat, 01 Mar 2025 06:00:00 GMT',
          },
        },
      }),
    );

    const { pages, gaps } = await drain(makeCtx());

    expect(pages.filter((p) => p.checkpoint !== undefined)).toEqual([
      { records: [], checkpoint: '2025-03-01T06:00:00.000Z' },
    ]);
    expect(pages.at(-1)).toEqual({ records: [], checkpoint: '2025-03-01T06:00:00.000Z' });
    expect(gaps.unreadFiles).toEqual([]);
  });

  it('holds the checkpoint when a listed data file answers 404, naming it in a warning and in the gaps', async () => {
    stubLabstat(
      allSurveys({
        cu: { 'cu.data.1.AllItems': { status: 404 } },
        ap: {
          'ap.data.1.AllItems': {
            body: DATA_FILE_CONTENT,
            lastModified: 'Sat, 01 Mar 2025 06:00:00 GMT',
          },
        },
      }),
    );
    const log = recordingLog();

    const { pages, gaps } = await drain(makeCtx(), log);

    expect(pages.some((p) => p.checkpoint !== undefined)).toBe(false);
    expect(pages.flatMap((p) => p.records)).toHaveLength(3);
    expect(gaps.unreadFiles).toEqual([{ survey: 'cu', url: CU_URL, status: 404 }]);
    expect(
      log.warnings.filter((w) => w.includes('"survey":"cu"') && w.includes(`"url":"${CU_URL}"`)),
    ).toHaveLength(1);
  });

  it("holds the checkpoint when a survey's directory listing cannot be read", async () => {
    stubLabstat(
      allSurveys({
        cu: { '': { status: 404 } },
        ap: { 'ap.data.1.AllItems': { body: DATA_FILE_CONTENT } },
      }),
    );

    const { pages, gaps } = await drain(makeCtx());

    expect(pages.some((p) => p.checkpoint !== undefined)).toBe(false);
    expect(gaps.unreadFiles).toEqual([
      { survey: 'cu', url: 'https://download.bls.gov/pub/time.series/cu/', status: 404 },
    ]);
  });

  it('reports a listing with no data files without holding the checkpoint', async () => {
    // Nothing of that survey was skipped by the checkpoint compare.
    stubLabstat(
      allSurveys({
        cu: { 'cu.series': {} },
        ap: {
          'ap.data.1.AllItems': {
            body: DATA_FILE_CONTENT,
            lastModified: 'Sat, 01 Mar 2025 06:00:00 GMT',
          },
        },
      }),
    );

    const { pages, gaps } = await drain(makeCtx());

    expect(pages.at(-1)).toEqual({ records: [], checkpoint: '2025-03-01T06:00:00.000Z' });
    expect(gaps).toEqual({ surveysWithoutDataFiles: ['cu'], unreadFiles: [] });
  });

  it('retries a transient failure and reads the file on a later attempt', async () => {
    const surveys = allSurveys({
      cu: { 'cu.data.1.AllItems': { body: DATA_FILE_CONTENT, status: 503 } },
    });
    const fake = stubLabstatFake(surveys);
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const response = await fake.fetch(url as string, init);
      if (String(url) === CU_URL) delete surveys.cu!['cu.data.1.AllItems']!.status;
      return response;
    });

    const { pages, gaps } = await drainWithFakeTimers(makeCtx());

    expect(fake.requested.filter((u) => u === CU_URL)).toHaveLength(2);
    expect(pages.flatMap((p) => p.records)).toHaveLength(3);
    expect(gaps.unreadFiles).toEqual([]);
  });

  it('does not retry an answer that is not transient', async () => {
    const fake = stubLabstatFake(allSurveys({ cu: { 'cu.data.1.AllItems': { status: 403 } } }));

    const { gaps } = await drainWithFakeTimers(makeCtx());

    expect(fake.requested.filter((u) => u === CU_URL)).toHaveLength(1);
    expect(gaps.unreadFiles).toEqual([{ survey: 'cu', url: CU_URL, status: 403 }]);
  });

  it('gives up on a body that stops arriving, after every attempt stalls', async () => {
    // No whole-response deadline: a body is read for as long as it keeps arriving.
    const fake = stubLabstatFake(
      allSurveys({ cu: { 'cu.data.1.AllItems': { body: dataRows(50), stallAfterBytes: 300 } } }),
    );

    const { pages, gaps } = await drainWithFakeTimers(makeCtx());

    expect(fake.requested.filter((u) => u === CU_URL)).toHaveLength(3);
    expect(pages.flatMap((p) => p.records)).toHaveLength(0);
    expect(gaps.unreadFiles).toEqual([
      { survey: 'cu', url: CU_URL, error: expect.stringContaining('No data') },
    ]);
  });

  it('counts a data file without the observation header as unread', async () => {
    stubLabstat(allSurveys({ cu: { 'cu.data.1.AllItems': { body: '<html>moved</html>\r\n' } } }));

    const { gaps } = await drain(makeCtx());

    expect(gaps.unreadFiles).toEqual([
      { survey: 'cu', url: CU_URL, error: expect.stringContaining('header') },
    ]);
  });

  it('skips a file no newer than the checkpoint on refresh without reading its body', async () => {
    const fake = stubLabstatFake({
      cu: {
        'cu.data.1.AllItems': {
          body: dataRows(20_000),
          lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        },
      },
    });

    const { pages } = await drain(
      makeCtx({ mode: 'refresh', checkpoint: '2025-01-01T00:00:00.000Z' }),
    );

    expect(pages).toEqual([]);
    expect(fake.cancelled).toEqual([CU_URL]);
  });

  it('puts no resume cursor on refresh pages — only an init resumes', async () => {
    stubLabstat({ cu: { 'cu.data.1.AllItems': { body: dataRows(12_000) } } });

    const { pages } = await drain(makeCtx({ mode: 'refresh' }));

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.cursor === undefined)).toBe(true);
  });

  it('stores no checkpoint from a resumed init, which cannot vouch for files read before it', async () => {
    stubLabstat(
      allSurveys({
        cu: { 'cu.data.1.AllItems': { body: DATA_FILE_CONTENT } },
        ap: { 'ap.data.1.AllItems': { body: DATA_FILE_CONTENT } },
      }),
    );

    const { pages } = await drain(makeCtx({ cursor: '0:0:0' }));

    expect(pages.flatMap((p) => p.records)).toHaveLength(6);
    expect(pages.some((p) => p.checkpoint !== undefined)).toBe(false);
  });

  it("counts a resumed file's later cursors from the file's first row", async () => {
    stubLabstat({
      cu: { 'cu.data.1.AllItems': { body: dataRows(12_000) } },
      ap: { 'ap.data.1.AllItems': { body: DATA_FILE_CONTENT } },
    });

    const { pages } = await drain(makeCtx({ cursor: '0:0:5000' }));

    expect(pages.map((p) => [p.records.length, p.cursor])).toEqual([
      [5_000, '0:0:10000'],
      [2_000, '1:0:0'],
      [3, '2:0:0'],
    ]);
    expect(pages[0]!.records[0]).toMatchObject({ year: '2316', period: 'M09' });
  });

  it('ignores a Last-Modified header that is not a date', async () => {
    stubLabstat(
      allSurveys({
        cu: { 'cu.data.1.AllItems': { body: DATA_FILE_CONTENT, lastModified: 'yesterday' } },
        ap: {
          'ap.data.1.AllItems': {
            body: DATA_FILE_CONTENT,
            lastModified: 'Sat, 01 Mar 2025 06:00:00 GMT',
          },
        },
      }),
    );

    const { pages } = await drain(makeCtx());

    expect(pages.flatMap((p) => p.records)).toHaveLength(6);
    expect(pages.at(-1)?.checkpoint).toBe('2025-03-01T06:00:00.000Z');
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
// Tests — footnote code tables (#118)
// ---------------------------------------------------------------------------

describe('syncFootnoteTables (#118)', () => {
  const BASE = 'https://download.bls.gov/pub/time.series';
  const CU_FOOTNOTE_URL = `${BASE}/cu/cu.footnote`;
  const CI_T = 'No units were initiated this reference period.';
  const CI_U =
    'See Footnote U on <a href="/eci/overview/eci-labstat-footnotes.htm#U" target="new">www.bls.gov/eci/overview/eci-labstat-footnotes.htm</a>.';

  /** Run the footnote pass, returning each table it saved by survey, in save order. */
  async function syncTables(
    log?: MirrorLogger,
    signal = AbortSignal.timeout(5_000),
  ): Promise<Map<string, ReadonlyMap<string, string>>> {
    const saved = new Map<string, ReadonlyMap<string, string>>();
    await syncFootnoteTables(
      { catalogBaseUrl: BASE, userAgent: 'test-agent', ...(log && { log }) },
      (survey, footnotes) => {
        saved.set(survey, footnotes);
        return Promise.resolve();
      },
      signal,
    );
    return saved;
  }

  /** {@link syncTables} under fake timers, so retry backoff elapses instantly. */
  async function syncTablesWithFakeTimers(
    log?: MirrorLogger,
  ): Promise<Map<string, ReadonlyMap<string, string>>> {
    vi.useFakeTimers();
    try {
      const result = syncTables(log, new AbortController().signal);
      await vi.runAllTimersAsync();
      return await result;
    } finally {
      vi.useRealTimers();
    }
  }

  it('reads the table of every mirrored survey, naming none', async () => {
    const fake = stubLabstatFake(
      Object.fromEntries(
        SURVEY_ABBRS.map((abbr) => [
          abbr,
          {
            [`${abbr}.footnote`]: {
              body: `footnote_code\tfootnote_text\r\nP\t${abbr} preliminary\r\n`,
            },
          },
        ]),
      ),
    );

    const saved = await syncTables();

    expect([...saved.keys()]).toEqual([...SURVEY_ABBRS]);
    for (const abbr of SURVEY_ABBRS) {
      expect(saved.get(abbr)).toEqual(new Map([['P', `${abbr} preliminary`]]));
    }
    expect(fake.requested).toEqual(SURVEY_ABBRS.map((abbr) => `${BASE}/${abbr}/${abbr}.footnote`));
  });

  it('keeps each code’s text byte for byte, dropping CRLF line ends and blank lines', async () => {
    stubLabstat({
      cu: {
        'cu.footnote': {
          body: `footnote_code\tfootnote_text\r\nT\t${CI_T}\r\n\r\nU\t${CI_U}\r\n   \r\n`,
        },
      },
    });

    const saved = await syncTables();

    expect(saved.get('cu')).toEqual(
      new Map([
        ['T', CI_T],
        ['U', CI_U],
      ]),
    );
  });

  it('saves an empty table when the survey’s table lists no codes', async () => {
    stubLabstat({ cu: { 'cu.footnote': { body: 'footnote_code\tfootnote_text\r\n' } } });

    const saved = await syncTables();

    expect(saved.get('cu')).toEqual(new Map());
  });

  it('saves nothing and stays quiet for a survey that publishes no table', async () => {
    // EC serves no ec.footnote: a 404 is its normal answer, not a failure.
    stubLabstat({ ec: {} });
    const log = recordingLog();

    const saved = await syncTables(log);

    expect(saved.size).toBe(0);
    expect(log.warnings).toEqual([]);
  });

  it('retries a transient failure, then warns and saves nothing, keeping the stored copy', async () => {
    const fake = stubLabstatFake({ cu: { 'cu.footnote': { status: 503 } } });
    const log = recordingLog();

    const saved = await syncTablesWithFakeTimers(log);

    expect(fake.requested.filter((u) => u === CU_FOOTNOTE_URL)).toHaveLength(3);
    expect(saved.has('cu')).toBe(false);
    expect(log.warnings).toEqual([
      expect.stringContaining(`"survey":"cu","url":"${CU_FOOTNOTE_URL}","status":503`),
    ]);
  });

  it('warns and saves nothing for a body that is not a footnote table', async () => {
    stubLabstat({ cu: { 'cu.footnote': { body: '<html>moved</html>\r\n' } } });
    const log = recordingLog();

    const saved = await syncTables(log);

    expect(saved.has('cu')).toBe(false);
    expect(log.warnings).toEqual([
      expect.stringContaining('No footnote_code/footnote_text header line'),
    ]);
  });

  it('rethrows the caller’s cancellation rather than skipping the table', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      controller.abort(new Error('Aborted by SIGTERM'));
      return Promise.reject(controller.signal.reason);
    });

    await expect(syncTables(undefined, controller.signal)).rejects.toThrow('Aborted by SIGTERM');
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
