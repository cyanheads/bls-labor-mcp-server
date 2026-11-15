/**
 * @fileoverview Reads `content[]` Markdown back the way a client's CommonMark
 * parser does, so a test can assert a value renders as itself rather than
 * comparing spellings. Raw HTML parsing is on, so markup that escaped the
 * encoder shows up as a marker in the text instead of passing as plain text.
 * @module tests/fixtures/markdown-read-back
 */

import MarkdownIt, { type Token } from 'markdown-it';

const parser = new MarkdownIt('default', { html: true });

/** One block of inline text: a paragraph, heading, list item, or table cell. */
export interface TextBlock {
  /** The code spans the block holds, in order. */
  codeSpans: string[];
  /** True inside a block quote, where the trailer renders a notice. */
  quoted: boolean;
  /** The HTML tag of the enclosing block (`p`, `h3`, `td`, …). */
  tag: string;
  /**
   * The text a reader sees: text and code-span content, a line break for each
   * soft or hard break, and `⟦type⟧` for any other inline token (a link,
   * raw HTML) — emphasis delimiters are dropped, so a stray `*` or `_` that
   * became emphasis is missing from it.
   */
  text: string;
}

/** The text and code spans a reader gets from one inline token. */
function readInline(token: Token): Pick<TextBlock, 'codeSpans' | 'text'> {
  let text = '';
  const codeSpans: string[] = [];
  for (const child of token.children ?? []) {
    switch (child.type) {
      case 'text':
        text += child.content;
        break;
      case 'code_inline':
        text += child.content;
        codeSpans.push(child.content);
        break;
      case 'softbreak':
      case 'hardbreak':
        text += '\n';
        break;
      case 'strong_open':
      case 'strong_close':
      case 'em_open':
      case 'em_close':
        break;
      default:
        text += `⟦${child.type}⟧`;
    }
  }
  return { codeSpans, text };
}

/** Every inline block of `markdown`, in document order. */
export function readBack(markdown: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let quoteDepth = 0;
  let tag = '';
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'blockquote_open') quoteDepth++;
    else if (token.type === 'blockquote_close') quoteDepth--;
    else if (token.type.endsWith('_open')) tag = token.tag;
    if (token.type === 'html_block') {
      blocks.push({ codeSpans: [], quoted: quoteDepth > 0, tag: 'html', text: '⟦html_block⟧' });
    }
    if (token.type !== 'inline') continue;
    blocks.push({ ...readInline(token), quoted: quoteDepth > 0, tag });
  }
  return blocks;
}

/** The cells of each GFM table row of `markdown`, as {@link readBack} reads them; the header row first. */
export function tableRows(markdown: string): string[][] {
  const rows: string[][] = [];
  let row: string[] | undefined;
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'tr_open') row = [];
    else if (token.type === 'tr_close' && row) {
      rows.push(row);
      row = undefined;
    } else if (token.type === 'inline' && row) row.push(readInline(token).text);
  }
  return rows;
}

/** The text of the block-quoted blocks of `markdown` — a rendered notice — joined by blank lines. */
export function quotedText(markdown: string): string {
  return readBack(markdown)
    .filter((block) => block.quoted)
    .map((block) => block.text)
    .join('\n\n');
}
