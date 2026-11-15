/**
 * @fileoverview SeriesIDs inside Markdown text. Finds the BLS SeriesIDs a
 * string quotes and renders the string with each one as a code span, so a
 * reader copying an ID out of `content[]` gets it exactly as BLS writes it
 * (`IPUAN311___W200000000`, never `IPUAN311\_\_\_W200000000`) while the prose
 * around it stays escaped. Notices need this because they ride
 * `structuredContent` too and stay raw there; the code spans are added only
 * when the notice renders into `content[]`.
 * @module services/bls-api/series-id-markdown
 */

import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * A run of the characters a SeriesID holds or that would touch one: letters,
 * digits, `_`, and `-` (PPI IDs such as `PCU1133--1133--` carry hyphens). A
 * SeriesID is always a whole run, so `XCES0000000001` and
 * `CES0000000001_draft` hold none.
 */
const RUN = /[\p{L}\p{N}_-]+/gu;

/**
 * A SeriesID's shape: a two-letter survey code, the seasonal code `S` or `U`,
 * then uppercase letters, digits, `_`, or `-`, ending on anything but `_`.
 * Every form in the catalog index fits — `CES0000000001`, `LNS14000000`,
 * `CUURS49DSA0`, `IPUAN311___W200000000`, `BDS0000000000000000110001LQ5`,
 * `PCU1133--1133--` — and so do composed OEWS IDs (`OEUN000000000000029114101`).
 * A run must also hold a digit ({@link isSeriesId}), which keeps the uppercase
 * words notices carry (`BLS`, `JOLTS`, `OEWS`, `BLS_API_KEY`, `M13`, a year)
 * out. The few index IDs with no digit (`EIUCDCANMANU`, `PCUATRADEATRADE`)
 * therefore render as prose, which escaping leaves unchanged.
 */
const SERIES_ID_SHAPE = /^[A-Z]{2}[SU][A-Z0-9_-]*[A-Z0-9-]$/;

/**
 * Stands in for each SeriesID while the text around it is escaped. Its edges
 * are ASCII punctuation the escaper leaves as is, so every character beside it
 * is escaped as it must be beside a code span's backtick: a `\` before it, an
 * `_` after it, a `<` that would open an email autolink across it. The
 * private-use character in the middle makes it unique, so the escaped text
 * splits back apart on it.
 */
const STAND_IN = '%%';

function isSeriesId(run: string): boolean {
  return SERIES_ID_SHAPE.test(run) && /[0-9]/.test(run);
}

/** The SeriesIDs `text` quotes, in order of appearance. */
export function seriesIdsIn(text: string): string[] {
  return [...text.matchAll(RUN)].map(([run]) => run).filter(isSeriesId);
}

/**
 * `escapeMarkdownInline(text)` with every SeriesID in it rendered as a code
 * span. A CommonMark parse reads the result back as `text`, and the IDs read
 * as themselves in the raw Markdown too. Linear in the length of `text`. Text
 * that already holds the stand-in's private-use character (U+E000) renders as
 * escaped prose throughout.
 */
export function escapeWithSeriesIds(text: string): string {
  const ids: string[] = [];
  const masked = text.replace(RUN, (run) => {
    if (!isSeriesId(run)) return run;
    ids.push(run);
    return STAND_IN;
  });
  if (ids.length === 0 || text.includes('')) return escapeMarkdownInline(text);
  // One escaped prose segment before each stand-in, and one after the last.
  const prose = escapeMarkdownInline(masked).split(STAND_IN);
  let out = '';
  for (const [i, id] of ids.entries()) out += `${prose[i]}${markdown().inlineCode(id).build()}`;
  return `${out}${prose[ids.length]}`;
}

/**
 * Renders a notice into `content[]` as a block quote, every line quoted as the
 * framework quotes a notice it renders itself, with its SeriesIDs as code
 * spans. The notice's `structuredContent` value stays raw.
 */
export function renderSeriesIdNotice(notice: string): string {
  return escapeWithSeriesIds(notice)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}
