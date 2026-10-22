import type { BlockKind, RawBlock } from './types';
import { hash53, normalizeText } from './text';
import { isTranscriptLine, TRANSCRIPT_HEADING, transcriptRange, type DocsNamedRanges } from './transcript';

/**
 * Converts a Google Docs API `documents.get` response into paragraph-level blocks.
 * Only the documented REST structure is used (no scraping of the rendered editor).
 *
 * Reference: https://developers.google.com/docs/api/reference/rest/v1/documents
 */

/* Minimal typings for the parts of the Docs API response we read. */
export interface DocsParagraphElement {
  textRun?: { content?: string };
  autoText?: unknown;
  person?: { personProperties?: { name?: string; email?: string } };
  richLink?: { richLinkProperties?: { title?: string; uri?: string } };
  dateElement?: { dateElementProperties?: { displayText?: string } };
  equation?: unknown;
  inlineObjectElement?: unknown;
  footnoteReference?: { footnoteNumber?: string };
  horizontalRule?: unknown;
  pageBreak?: unknown;
}
export interface DocsStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    elements?: DocsParagraphElement[];
    paragraphStyle?: { namedStyleType?: string };
    bullet?: { listId?: string; nestingLevel?: number };
  };
  table?: { tableRows?: { tableCells?: { content?: DocsStructuralElement[] }[] }[] };
  tableOfContents?: unknown;
  sectionBreak?: unknown;
}
export interface DocsTab {
  tabProperties?: { tabId?: string; title?: string; nestingLevel?: number };
  documentTab?: { body?: { content?: DocsStructuralElement[] }; namedRanges?: DocsNamedRanges };
  childTabs?: DocsTab[];
}
export interface DocsDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: DocsStructuralElement[] };
  namedRanges?: DocsNamedRanges;
  tabs?: DocsTab[];
}

export interface ParsedDocument {
  documentId: string;
  title: string;
  revisionId: string | null;
  blocks: RawBlock[];
}

function cleanText(s: string): string {
  return (
    s
      // Docs uses \u000b for soft line breaks inside a paragraph.
      .replace(/\u000b/g, '\n')
      // Private-use / object replacement characters carry no text.
      .replace(/[-￼]/g, '')
      .replace(/ /g, ' ')
      .replace(/\n+$/g, '')
      .trim()
  );
}

function paragraphText(elements: DocsParagraphElement[] = []): string {
  let out = '';
  for (const el of elements) {
    if (el.textRun?.content) out += el.textRun.content;
    else if (el.person?.personProperties) out += el.person.personProperties.name ?? el.person.personProperties.email ?? '';
    else if (el.richLink?.richLinkProperties) {
      const { title, uri } = el.richLink.richLinkProperties;
      out += title ? `${title}${uri ? ` (${uri})` : ''}` : uri ?? '';
    } else if (el.dateElement?.dateElementProperties?.displayText) out += el.dateElement.dateElementProperties.displayText;
    else if (el.equation) out += '[equation]';
    else if (el.inlineObjectElement) out += '[image]';
    else if (el.footnoteReference) out += `[^${el.footnoteReference.footnoteNumber ?? ''}]`;
  }
  return cleanText(out);
}

function headingLevel(style?: string): number | undefined {
  if (!style) return undefined;
  if (style === 'TITLE') return 1;
  if (style === 'SUBTITLE') return 2;
  const m = /^HEADING_(\d)$/.exec(style);
  return m ? Number(m[1]) : undefined;
}

export function makeRawBlock(kind: BlockKind, text: string, level?: number): RawBlock {
  return { kind, text, level, hash: hash53(`${kind}|${normalizeText(text)}`) };
}

type Span = { startIndex: number; endIndex: number } | null;
const within = (span: Span, el: DocsStructuralElement) => !!span && Number.isInteger(el.startIndex) && el.startIndex! >= span.startIndex && el.startIndex! < span.endIndex;

function walk(content: DocsStructuralElement[] = [], out: RawBlock[], transcript: Span = null): void {
  for (const el of content) {
    if (el.paragraph) {
      const text = paragraphText(el.paragraph.elements);
      if (!normalizeText(text)) continue; // empty paragraphs are layout, not content
      const level = headingLevel(el.paragraph.paragraphStyle?.namedStyleType);
      // In NotePilot's transcript section, its own lines are marked and its heading is not note content. Anything else
      // there (the student typing after the last line) stays an ordinary note.
      if (within(transcript, el)) {
        if (level !== undefined && text === TRANSCRIPT_HEADING) continue;
        if (level === undefined && isTranscriptLine(text)) {
          out.push({ ...makeRawBlock(el.paragraph.bullet ? 'list_item' : 'paragraph', text, el.paragraph.bullet?.nestingLevel), transcript: true });
          continue;
        }
      }
      if (level !== undefined) out.push(makeRawBlock('heading', text, level));
      else if (el.paragraph.bullet) out.push(makeRawBlock('list_item', text, el.paragraph.bullet.nestingLevel ?? 0));
      else out.push(makeRawBlock('paragraph', text));
    } else if (el.table) {
      const rows: string[] = [];
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((cell) => {
          const inner: RawBlock[] = [];
          walk(cell.content, inner);
          return inner.map((b) => b.text).join(' / ').replace(/\|/g, '\\|');
        });
        if (cells.some((c) => c.trim())) rows.push(`| ${cells.join(' | ')} |`);
      }
      if (rows.length) out.push(makeRawBlock('table', rows.join('\n')));
    }
    // tableOfContents is generated from headings, sectionBreak is layout: both skipped.
  }
}

function flattenTabs(tabs: DocsTab[], acc: DocsTab[] = []): DocsTab[] {
  for (const t of tabs) {
    acc.push(t);
    if (t.childTabs?.length) flattenTabs(t.childTabs, acc);
  }
  return acc;
}

export function parseDocument(doc: DocsDocument): ParsedDocument {
  const blocks: RawBlock[] = [];
  if (doc.tabs && doc.tabs.length) {
    const all = flattenTabs(doc.tabs);
    for (const tab of all) {
      // With several tabs, the tab title is a meaningful structural hint, so we keep it as a heading.
      if (all.length > 1 && tab.tabProperties?.title) {
        blocks.push(makeRawBlock('heading', tab.tabProperties.title, 1));
      }
      walk(tab.documentTab?.body?.content, blocks, transcriptRange(tab.documentTab?.namedRanges));
    }
  } else {
    walk(doc.body?.content, blocks, transcriptRange(doc.namedRanges));
  }
  return {
    documentId: doc.documentId ?? '',
    title: doc.title ?? 'Untitled document',
    revisionId: doc.revisionId ?? null,
    blocks,
  };
}

export function contentHashOf(blocks: { hash: string }[]): string {
  return hash53(blocks.map((b) => b.hash).join(','));
}

/** Extracts the document id from a Google Docs URL, or null if the URL is not a Google Doc. */
export function docIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/.exec(url);
  return m ? m[1] : null;
}
