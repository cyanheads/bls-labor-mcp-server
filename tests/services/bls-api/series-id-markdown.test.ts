/**
 * @fileoverview Tests for the SeriesID Markdown renderer (#133): which strings
 * it finds as SeriesIDs, that a rendered notice reads back under CommonMark as
 * the raw text with each ID in a code span wherever it sits, and that it stays
 * linear in caller-sized text.
 * @module tests/services/bls-api/series-id-markdown.test
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import {
  escapeWithSeriesIds,
  renderSeriesIdNotice,
  seriesIdsIn,
} from '@/services/bls-api/series-id-markdown.js';
import {
  expectLinearCpuTime,
  LINE_BREAK_SHAPES,
  type TextShape,
} from '../../fixtures/linear-time.js';
import { quotedText, readBack } from '../../fixtures/markdown-read-back.js';

const IP = 'IPUAN311___W200000000';

describe('seriesIdsIn', () => {
  it.each([
    'CES0000000001',
    'LNS14000000',
    'CUURS49DSA0',
    'CUUR0000SA0',
    'IPUAN1111__L010000000',
    IP,
    'IPUZN______W201984000',
    'BDS0000000000000000110001LQ5',
    'PCU1133--1133--',
    'PCU211---211---',
    'OEUN000000000000029114101',
    'OEUM004766000000029114103',
    'JTS000000060000000JOR',
    'SMU78000009092000001',
    'APU0000701111',
    'ECS10001I',
    'EIUIQ0',
    'WPS01',
  ])('finds the catalog form %s', (id) => {
    expect(seriesIdsIn(`BLS reports ${id} is invalid.`)).toEqual([id]);
  });

  it.each([
    'BLS',
    'API',
    'JOLTS',
    'OEWS',
    'CPI',
    'CPI-U',
    'CBSA',
    'UTC',
    '2024',
    'M13',
    'M13/Q05/S03',
    'BLS_API_KEY',
    'REQUEST_FAILED',
    'quota_exceeded',
    'df_ABCDE_FGHIJ',
    // No digit: left as prose, which escaping already leaves unchanged.
    'EIUCDCANMANU',
    // Touched by a letter, digit, or `_`, or not uppercase.
    'XCES0000000001',
    'CES0000000001x',
    'CES0000000001_',
    '_CES0000000001',
    'éCES0000000001',
    'ces0000000001',
  ])('leaves %s alone', (word) => {
    expect(seriesIdsIn(`Notice ${word} text.`)).toEqual([]);
  });

  it('returns every ID in order of appearance', () => {
    expect(
      seriesIdsIn(
        `BLS reports ${IP} is invalid; request OEUN000000000000029114101 (M13, 2024) instead, or set BLS_API_KEY. ${IP}`,
      ),
    ).toEqual([IP, 'OEUN000000000000029114101', IP]);
  });
});

describe('renderSeriesIdNotice', () => {
  /** The notice as the trailer places it: after the content block, before another field. */
  function trailer(notice: string): string {
    return `Lead paragraph.\n\n${renderSeriesIdNotice(notice)}\n\n**after:** 1`;
  }

  it.each([
    { notice: IP, codeSpans: [IP] },
    { notice: `Series *${IP}* failed.`, codeSpans: [IP] },
    { notice: `Series \`${IP}\` failed.`, codeSpans: [IP] },
    { notice: `Series **${IP}** failed.`, codeSpans: [IP] },
    // An `_` touching the ID makes it part of a longer word: prose, read back exactly.
    { notice: `Series _${IP}_ failed.`, codeSpans: [] },
    { notice: `${IP} opens a line\nand ${IP}\nends one: ${IP}`, codeSpans: [IP, IP, IP] },
    { notice: `final line break ${IP}\n`, codeSpans: [IP] },
    { notice: `first\n\nthird ${IP}`, codeSpans: [IP] },
    { notice: `- ${IP} reads as a list marker`, codeSpans: [IP] },
    { notice: `# ${IP} #`, codeSpans: [IP] },
    { notice: `> ${IP}`, codeSpans: [IP] },
    { notice: `\\${IP}\\`, codeSpans: [IP] },
    { notice: `<${IP}@example.com>`, codeSpans: [IP] },
    { notice: `&${IP};`, codeSpans: [IP] },
    { notice: `  ${IP}  `, codeSpans: [IP] },
    { notice: `crlf\r\n${IP}`, codeSpans: [IP] },
    {
      notice: `Request the remaining SeriesIDs separately: ${IP}, PCU1133--1133--, CES0000000001.`,
      codeSpans: [IP, 'PCU1133--1133--', 'CES0000000001'],
    },
    // Text already holding the stand-in's private-use character renders as prose.
    { notice: `held  ${IP}`, codeSpans: [] },
  ])('reads $notice back exactly, quoted, with its IDs as code spans', ({ notice, codeSpans }) => {
    const markdown = trailer(notice);
    expect(quotedText(markdown)).toBe(notice.replace(/\r\n?/g, '\n'));
    expect(
      readBack(markdown)
        .filter((block) => block.quoted)
        .flatMap((block) => block.codeSpans),
    ).toEqual(codeSpans);
    // The field after the notice stays out of the quote.
    expect(readBack(markdown).at(-1)).toMatchObject({ quoted: false, text: 'after: 1' });
    // Each ID reads raw in the Markdown too, with no escape to copy.
    for (const id of codeSpans) expect(markdown).toContain(`\`${id}\``);
  });

  it('quotes every line, as the framework quotes a notice it renders itself', () => {
    expect(renderSeriesIdNotice(`one ${IP}\ntwo`)).toBe(`> one \`${IP}\`\\\n> two`);
  });
});

describe('escapeWithSeriesIds', () => {
  it('matches escapeMarkdownInline byte for byte when the text holds no SeriesID', () => {
    const text = 'Use *bls_search_series* with BLS_API_KEY set; see [docs](x) <b>M13</b> 2024.';
    expect(escapeWithSeriesIds(text)).toBe(escapeMarkdownInline(text));
  });

  it('reads back as the raw text in a list item', () => {
    const error = `Series not found: ${IP}`;
    const [item] = readBack(`- \`${IP}\`: ${escapeWithSeriesIds(error)}`);
    expect(item).toMatchObject({ tag: 'p', text: `${IP}: ${error}`, codeSpans: [IP, IP] });
  });
});

describe('linear time over caller-sized text', () => {
  const render = (text: string) => {
    renderSeriesIdNotice(text);
    seriesIdsIn(text);
  };

  it.each<TextShape>([
    ...LINE_BREAK_SHAPES,
    // Survey-code starts after hyphens with no place an ID may end: a scanner
    // that backtracks from each start to find an ID's end goes quadratic here.
    ['hyphen-separated starts', (n) => `${'CES_-'.repeat(n / 5)}_`],
    // One digit run that stops being an ID at its last character.
    ['long digit run', (n) => `CES${'0'.repeat(n)}_`],
    ['every run an ID', (n) => `${IP} `.repeat(n / 22)],
    ['autolink openers', (n) => `${'<CES0000000001'.repeat(n / 14)}@x>`],
    ['backtick run', (n) => '`'.repeat(n)],
  ])('stays linear on %s', (label, text) => expectLinearCpuTime(render, text, label, 250), 0);
});
