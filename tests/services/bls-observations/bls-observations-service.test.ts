/**
 * @fileoverview Tests for BlsObservationsService query semantics — the
 * annual-average filter on queryBySeries (#53) and "latest" ordering on
 * queryLatest (#55). `defineMirror` is stubbed so the real service logic runs
 * against fixture rows without opening SQLite.
 * @module tests/services/bls-observations/bls-observations-service.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservationRow } from '@/services/bls-observations/types.js';

const queryMock = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/mirror', () => ({
  defineMirror: () => ({
    query: queryMock,
    ready: vi.fn(),
    runSync: vi.fn(),
    status: vi.fn(),
  }),
  sqliteMirrorStore: () => ({}),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({ observationsMirrorEnabled: true })),
}));

import { BlsObservationsService } from '@/services/bls-observations/bls-observations-service.js';

function row(series_id: string, year: string, period: string, value: string): ObservationRow {
  return {
    row_key: `${series_id}|${year}|${period}`,
    series_id,
    year,
    period,
    value,
    footnote_codes: '',
  };
}

/** Rows arrive year-DESC from the store; period order within a year is arbitrary. */
function stub(rows: ObservationRow[]): void {
  queryMock.mockResolvedValue({ rows, total: rows.length });
}

function newService(): BlsObservationsService {
  return new BlsObservationsService(':memory:', 'https://example.invalid', 'test-agent/1.0');
}

describe('BlsObservationsService.queryLatest — annual-average rows (#55)', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns December, not the M13 annual average, as the latest monthly observation', async () => {
    // "M13" > "M12" lexically, so a naive (year, period) comparison served the
    // year's mean as the current reading.
    stub([
      row('CUUR0000SA0', '2024', 'M11', '315.4'),
      row('CUUR0000SA0', '2024', 'M13', '313.689'),
      row('CUUR0000SA0', '2024', 'M12', '315.6'),
    ]);

    const { observations } = await newService().queryLatest(['CUUR0000SA0']);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.period).toBe('M12');
    expect(observations[0]!.value).toBe('315.6');
  });

  it('returns Q04, not the Q05 annual average, for a quarterly series', async () => {
    stub([row('PRS30006011', '2024', 'Q05', '-1.0'), row('PRS30006011', '2024', 'Q04', '1.4')]);

    const { observations } = await newService().queryLatest(['PRS30006011']);

    expect(observations[0]!.period).toBe('Q04');
  });

  it('returns S02, not the S03 annual average, for a semiannual series', async () => {
    stub([
      row('CUUS0000SA0', '2024', 'S03', '313.689'),
      row('CUUS0000SA0', '2024', 'S02', '315.0'),
    ]);

    const { observations } = await newService().queryLatest(['CUUS0000SA0']);

    expect(observations[0]!.period).toBe('S02');
  });

  it('prefers a newer year over an older year regardless of period', async () => {
    // Year is compared before period, so January 2025 beats December 2024.
    stub([row('LNS14000000', '2025', 'M01', '4.0'), row('LNS14000000', '2024', 'M12', '4.1')]);

    const { observations } = await newService().queryLatest(['LNS14000000']);

    expect(observations[0]!.year).toBe('2025');
    expect(observations[0]!.period).toBe('M01');
  });

  it("prefers a newer year's real period over an older year's annual average", async () => {
    stub([
      row('CUUR0000SA0', '2025', 'M01', '317.0'),
      row('CUUR0000SA0', '2024', 'M13', '313.689'),
    ]);

    const { observations } = await newService().queryLatest(['CUUR0000SA0']);

    expect(observations[0]!.year).toBe('2025');
    expect(observations[0]!.period).toBe('M01');
  });

  it("prefers an older year's real period over a newer year's annual average", async () => {
    // An average is never the latest reading while any real observation exists —
    // BLS can publish a year's mean before the next year's months land.
    stub([row('CUUR0000SA0', '2025', 'M13', '318.0'), row('CUUR0000SA0', '2024', 'M12', '315.6')]);

    const { observations } = await newService().queryLatest(['CUUR0000SA0']);

    expect(observations[0]!.year).toBe('2024');
    expect(observations[0]!.period).toBe('M12');
  });

  it('falls back to the annual average when a series holds nothing else', async () => {
    // Then it is the series' only observation, not a duplicate of a real one.
    stub([row('ONLYAVG001', '2023', 'M13', '100.0'), row('ONLYAVG001', '2024', 'M13', '110.0')]);

    const { observations, missedIds } = await newService().queryLatest(['ONLYAVG001']);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.year).toBe('2024');
    expect(observations[0]!.period).toBe('M13');
    expect(missedIds).toEqual([]);
  });

  it('resolves latest independently per series', async () => {
    stub([
      row('CUUR0000SA0', '2024', 'M13', '313.689'),
      row('CUUR0000SA0', '2024', 'M12', '315.6'),
      row('LNS14000000', '2024', 'M12', '4.1'),
    ]);

    const { observations } = await newService().queryLatest(['CUUR0000SA0', 'LNS14000000']);

    const byId = new Map(observations.map((o) => [o.series_id, o]));
    expect(byId.get('CUUR0000SA0')!.period).toBe('M12');
    expect(byId.get('LNS14000000')!.period).toBe('M12');
  });

  it('reports series with no mirror rows as missed', async () => {
    stub([]);

    const { observations, complete, missedIds } = await newService().queryLatest(['ABSENT001']);

    expect(observations).toEqual([]);
    expect(complete).toBe(false);
    expect(missedIds).toEqual(['ABSENT001']);
  });
});

describe('BlsObservationsService.queryBySeries — annual-average filter (#53)', () => {
  beforeEach(() => queryMock.mockReset());

  const MIXED = [
    row('CUUR0000SA0', '2024', 'M12', '315.6'),
    row('CUUR0000SA0', '2024', 'M13', '313.689'),
    row('CUUR0000SA0', '2023', 'M13', '304.702'),
    row('CUUR0000SA0', '2023', 'M12', '306.7'),
  ];

  it('drops annual-average rows by default — LABSTAT bakes them in with no flag', async () => {
    stub(MIXED);

    const { observations } = await newService().queryBySeries({ seriesIds: ['CUUR0000SA0'] });

    expect(observations).toHaveLength(2);
    expect(observations.map((o) => o.period)).toEqual(['M12', 'M12']);
  });

  it('keeps annual-average rows when annualAverage is true', async () => {
    stub(MIXED);

    const { observations } = await newService().queryBySeries({
      seriesIds: ['CUUR0000SA0'],
      annualAverage: true,
    });

    expect(observations).toHaveLength(4);
    expect(observations.filter((o) => o.period === 'M13')).toHaveLength(2);
  });

  it('counts a series the filter empties as covered, not missed', async () => {
    // The mirror holds the series; the caller declined its only rows for this
    // range. Re-fetching live would spend quota to get the same nothing.
    stub([row('ONLYAVG001', '2024', 'M13', '110.0')]);

    const { observations, complete, missedIds } = await newService().queryBySeries({
      seriesIds: ['ONLYAVG001'],
    });

    expect(observations).toEqual([]);
    expect(complete).toBe(true);
    expect(missedIds).toEqual([]);
  });

  it('reports a series absent from the mirror as missed', async () => {
    stub([row('CUUR0000SA0', '2024', 'M12', '315.6')]);

    const { complete, missedIds } = await newService().queryBySeries({
      seriesIds: ['CUUR0000SA0', 'ABSENT001'],
    });

    expect(complete).toBe(false);
    expect(missedIds).toEqual(['ABSENT001']);
  });

  it('passes the year range to the store as filters', async () => {
    stub(MIXED);

    await newService().queryBySeries({
      seriesIds: ['CUUR0000SA0'],
      startYear: 2023,
      endYear: 2024,
    });

    const filters = queryMock.mock.calls[0]![0].filters as Array<Record<string, unknown>>;
    expect(filters).toContainEqual({ column: 'year', op: 'gte', value: '2023' });
    expect(filters).toContainEqual({ column: 'year', op: 'lte', value: '2024' });
  });
});
