import { TRANSCRIPT_RANGE } from '../src/core/transcript';
import type { DocsDocument } from '../src/core/docParser';

/** Builds a Docs API `documents.get` response from simple paragraph specs. */
/** `transcript`: the paragraph is in NotePilot's lecture transcript section (a named range in the doc). */
export type ParaSpec = string | { text: string; style?: string; bullet?: number; transcript?: boolean } | { table: string[][] };

export function docsResponse(paras: ParaSpec[], opts: { title?: string; revisionId?: string; id?: string } = {}): DocsDocument {
  // Character positions as Docs counts them: the section break is index 0, each paragraph is its text plus "\n".
  let at = 1;
  const span = (length: number) => ({ startIndex: at, endIndex: (at += length) });
  const transcript: { startIndex: number; endIndex: number }[] = [];
  const elements = paras.map((p) => {
    if (typeof p === 'string') return { ...span(p.length + 1), paragraph: { elements: [{ textRun: { content: p + '\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } };
    if ('table' in p)
      return {
        ...span(p.table.flat().join('').length + p.table.flat().length + 2),
        table: {
          tableRows: p.table.map((row) => ({
            tableCells: row.map((cell) => ({ content: [{ paragraph: { elements: [{ textRun: { content: cell + '\n' } }] } }] })),
          })),
        },
      };
    const where = span(p.text.length + 1);
    if (p.transcript) transcript.push(where);
    return {
      ...where,
      paragraph: {
        elements: [{ textRun: { content: p.text + '\n' } }],
        paragraphStyle: { namedStyleType: p.style ?? 'NORMAL_TEXT' },
        ...(p.bullet !== undefined ? { bullet: { listId: 'l1', nestingLevel: p.bullet } } : {}),
      },
    };
  });
  const content = elements;
  const namedRanges = transcript.length
    ? { [TRANSCRIPT_RANGE]: { name: TRANSCRIPT_RANGE, namedRanges: [{ namedRangeId: 'kix.np', name: TRANSCRIPT_RANGE, ranges: [{ startIndex: transcript[0].startIndex, endIndex: transcript[transcript.length - 1].endIndex }] }] } }
    : undefined;
  return {
    documentId: opts.id ?? 'DOC_1234567890abcdefghij',
    title: opts.title ?? 'Bio notes',
    revisionId: opts.revisionId ?? 'rev-1',
    tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, ...content] }, ...(namedRanges ? { namedRanges } : {}) } }],
  };
}
