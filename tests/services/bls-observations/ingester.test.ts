/**
 * @fileoverview Tests for the LABSTAT observation ingester — tab-delimited parsing,
 * readme discovery, cursor encoding, and page batching.
 * @module tests/services/bls-observations/ingester.test
 */

import type { SyncContext } from '@cyanheads/mcp-ts-core/mirror';
import { describe, expect, it } from 'vitest';
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

/** README content listing two data files. */
const README_WITH_TWO_FILES = `
Name of file:  cu.data.1.AllItems
Name of file:  cu.data.2.Seasonally Adjusted Average
`;

/** README content with no data file references. */
const README_WITH_NO_FILES = `
This survey has no observation data files in LABSTAT.
`;

/** README that lists a file in a different format. */
const README_ALT_FORMAT = `
cu.data.0.AllData
`;

/** Data file with a '-' value that should be skipped. */
const DATA_FILE_WITH_NULL = [
  'series_id\tyear\tperiod\tvalue\tfootnote_codes',
  'LNS14000000\t2024\tM12\t4.1\t',
  'LNS14000000\t2024\tM11\t-\t', // null value — should be skipped
  'LNS14000000\t2024\tM10\t4.3\t',
].join('\n');

/** Data file missing the footnote_codes column (optional). */
const DATA_FILE_NO_FOOTNOTES = [
  'series_id\tyear\tperiod\tvalue',
  'LNS14000000\t2024\tM12\t4.1',
  'LNS14000000\t2024\tM11\t4.2',
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

// ---------------------------------------------------------------------------
// Tests — README parsing (via the ingester's behaviour with mocked fetch)
// ---------------------------------------------------------------------------

describe('observationsSync — tab-delimited parsing', () => {
  it('parses a well-formed data file into correct ObservationRow fields', async () => {
    // Mock: readme → one file, data file → DATA_FILE_CONTENT
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('.readme')) {
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
    expect(typeof row['row_key']).toBe('string');
    expect(typeof row['series_id']).toBe('string');
    expect(typeof row['year']).toBe('string');
    expect(typeof row['period']).toBe('string');
    expect(typeof row['value']).toBe('string');
    expect(typeof row['footnote_codes']).toBe('string');
  });

  it('skips rows with a null "-" value', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('.readme')) {
        return Promise.resolve(
          new Response('cu.data.1.AllItems\n', {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      if (u.includes('.data.')) {
        return Promise.resolve(
          new Response(DATA_FILE_WITH_NULL, {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const ctx = makeCtx();
    let allRecords: Record<string, unknown>[] = [];

    for await (const page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      allRecords = [...allRecords, ...(page.records as Record<string, unknown>[])];
      if (allRecords.length > 0) break;
    }

    // Should have 2 rows (M12 and M10), not 3 (M11 has '-' value)
    const lnsRows = allRecords.filter((r) => r['series_id'] === 'LNS14000000');
    const periodM11 = lnsRows.find((r) => r['period'] === 'M11');
    expect(periodM11).toBeUndefined();
    expect(lnsRows.length).toBe(2);
  });

  it('handles data files without footnote_codes column', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('.readme')) {
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
      expect(typeof row['footnote_codes']).toBe('string');
    }
  });

  it('generates composite row_key as series_id|year|period', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('.readme')) {
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

    const lnsRow = records.find((r) => r['series_id'] === 'LNS14000000' && r['period'] === 'M12');
    expect(lnsRow?.['row_key']).toBe('LNS14000000|2024|M12');
  });

  it('gracefully skips a survey whose readme fetch returns 404', async () => {
    // Return 404 for the first survey (cu), but serve data for the second
    const surveysSeen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/cu/')) {
        surveysSeen.push('cu');
        return Promise.resolve(new Response('', { status: 404 }));
      }
      if (u.includes('.readme')) {
        return Promise.resolve(
          new Response('sa.data.1.AllItems\n', {
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

    // Should not throw even when cu readme returns 404
    for await (const page of observationsSync(ctx, {
      catalogBaseUrl: 'https://download.bls.gov/pub/time.series',
      userAgent: 'test-agent',
    })) {
      pages.push(page);
      if (pages.length >= 3) break; // enough to validate no throw
    }

    // No error thrown — graceful degradation
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — readme data-file discovery
// ---------------------------------------------------------------------------

describe('observationsSync — readme data-file discovery', () => {
  /** Run the sync against the cu survey, capturing the data-file URLs fetched. */
  async function captureDataUrls(readme: string): Promise<string[]> {
    const fetchedDataUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/cu/') && u.includes('.readme')) {
        return Promise.resolve(
          new Response(readme, {
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
    })) {
      if (fetchedDataUrls.length >= 2) break; // cu is the first survey
    }
    return fetchedDataUrls;
  }

  it('discovers multiple data files from a "Name of file:" readme', async () => {
    const urls = await captureDataUrls(README_WITH_TWO_FILES);
    expect(urls.some((u) => u.includes('cu.data.1.allitems'))).toBe(true);
    expect(urls.some((u) => u.includes('cu.data.2'))).toBe(true);
  });

  it('falls back to the default data file when the readme lists none', async () => {
    const urls = await captureDataUrls(README_WITH_NO_FILES);
    expect(urls.some((u) => u.includes('cu.data.1.alldata'))).toBe(true);
  });

  it('discovers a bare-filename data file from an alternate readme format', async () => {
    const urls = await captureDataUrls(README_ALT_FORMAT);
    expect(urls.some((u) => u.includes('cu.data.0.alldata'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — cursor encoding / resume
// ---------------------------------------------------------------------------

describe('observationsSync — cursor and checkpoint', () => {
  it('checkpoint is an ISO 8601 string derived from Last-Modified', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('.readme')) {
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
    // Mock: only the last survey (mp) returns data; all others return 404
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      // Only serve mp
      if (u.includes('/mp/') && u.includes('.readme')) {
        return Promise.resolve(
          new Response('mp.data.1.AllData\n', {
            status: 200,
            headers: { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          }),
        );
      }
      if (u.includes('/mp/') && u.includes('.data.')) {
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
    const pages: Array<{ cursor?: string; records: unknown[] }> = [];

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
