/**
 * Lecture recording: the transcript section NotePilot keeps in the user's Google Doc.
 *
 * While recording, each transcribed stretch of speech is appended as one line ("[10:42] …") to a section at the end of
 * the document, under the heading below. The section is a Docs named range, so NotePilot finds it again after the
 * user edits above it, and every later line goes inside it. This is the only place NotePilot writes to a document:
 * it inserts text, styles the paragraphs it inserted, and names the range it created. It never edits, moves or deletes
 * the user's own text (enforced by tests/writes.test.ts).
 */

export const TRANSCRIPT_RANGE = 'notepilot-transcript';
export const TRANSCRIPT_HEADING = 'Lecture transcript (NotePilot)';

/** "10:42" in the user's own time format (24-hour clock if that is the locale's way). */
export function lineTime(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** One transcript line: a time, then the words, on a single line (Docs paragraphs end at a newline). */
export function transcriptLine(text: string, at: number, locale?: string): string {
  const words = text.replace(/\s+/g, ' ').trim();
  return words ? `[${lineTime(at, locale)}] ${words}` : '';
}

/**
 * A paragraph NotePilot wrote: "[10:42] …" (the time as the user's locale writes it). Only these, and NotePilot's
 * heading, count as transcript. Anything else the student types inside or after the section stays their own note.
 */
export function isTranscriptLine(text: string): boolean {
  return /^\[\d{1,2}[:.]\d{2}(?:[\s ]?[^\]\n]{1,8})?\] \S/.test(text);
}

/** What the writer needs to know about the document's first tab before an append. */
export interface WriteSnapshot {
  revisionId: string | null;
  /** endIndex of the body's last structural element (the body always ends with a newline at endIndex - 1). */
  bodyEnd: number;
  /** The transcript section, when the document already has one. */
  range: { startIndex: number; endIndex: number } | null;
  /** endIndex of the section's last transcript line (or its heading): the next line goes right after it. */
  anchor: number | null;
  /** Text of the section's last transcript line, if any. */
  lastLine: string | null;
  /** Text of the paragraph right after the section, if any. */
  after: string | null;
}

interface DocsRange {
  startIndex?: number;
  endIndex?: number;
  segmentId?: string;
}
export interface DocsNamedRanges {
  [name: string]: { namedRanges?: { name?: string; ranges?: DocsRange[] }[] } | undefined;
}

/** The transcript section's extent in the body: the last range named TRANSCRIPT_RANGE (header/footer ranges ignored). */
export function transcriptRange(named: DocsNamedRanges | undefined): { startIndex: number; endIndex: number } | null {
  let best: { startIndex: number; endIndex: number } | null = null;
  for (const group of named?.[TRANSCRIPT_RANGE]?.namedRanges ?? []) {
    for (const r of group.ranges ?? []) {
      if (r.segmentId || !Number.isInteger(r.startIndex) || !Number.isInteger(r.endIndex) || r.endIndex! <= r.startIndex!) continue;
      if (!best || r.endIndex! > best.endIndex) best = { startIndex: r.startIndex!, endIndex: r.endIndex! };
    }
  }
  return best;
}

/** The parts of documents.get the writer asks for (fields=revisionId,namedRanges,body(content(…))). */
export interface EndShape {
  revisionId?: string;
  namedRanges?: DocsNamedRanges;
  body?: { content?: { startIndex?: number; endIndex?: number; paragraph?: { elements?: { textRun?: { content?: string } }[] } }[] };
}

export function snapshotOf(doc: EndShape): WriteSnapshot {
  const content = doc.body?.content ?? [];
  const range = transcriptRange(doc.namedRanges);
  const paragraphs = content
    .filter((el) => el.paragraph && Number.isInteger(el.startIndex) && Number.isInteger(el.endIndex))
    .map((el) => ({ start: el.startIndex!, end: el.endIndex!, text: (el.paragraph!.elements ?? []).map((e) => e.textRun?.content ?? '').join('').replace(/\n$/, '') }));
  let anchor: number | null = null;
  let lastLine: string | null = null;
  if (range) {
    for (const p of paragraphs) {
      if (p.start < range.startIndex || p.start >= range.endIndex) continue;
      if (isTranscriptLine(p.text)) (anchor = p.end), (lastLine = p.text);
      else if (p.text === TRANSCRIPT_HEADING && anchor === null) anchor = p.end;
    }
  }
  return {
    revisionId: doc.revisionId ?? null,
    bodyEnd: content[content.length - 1]?.endIndex ?? 1,
    range,
    anchor,
    lastLine,
    after: range ? paragraphs.find((p) => p.start === range.endIndex)?.text ?? null : null,
  };
}

const TEXT_FIELDS = 'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link';
const PARAGRAPH_FIELDS = 'namedStyleType,alignment,indentStart,indentEnd,indentFirstLine,spaceAbove,spaceBelow,lineSpacing,direction';
type Span = { startIndex: number; endIndex: number };

export type DocsWriteRequest =
  | { insertText: { location: { index: number }; text: string } }
  | { updateTextStyle: { range: Span; textStyle: Record<string, never>; fields: string } }
  | { updateParagraphStyle: { range: Span; paragraphStyle: { namedStyleType: string }; fields: string } }
  | { deleteParagraphBullets: { range: Span } }
  | { createNamedRange: { name: string; range: Span } };

// Inserted text takes the style of the character before it, and a new paragraph the style of the one it splits off:
// both are reset, so the transcript is never bold, a link or a list item just because the student's last line was.
const plain = (range: Span): DocsWriteRequest => ({ updateTextStyle: { range, textStyle: {}, fields: TEXT_FIELDS } });
const style = (range: Span, namedStyleType: string): DocsWriteRequest => ({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType }, fields: PARAGRAPH_FIELDS } });

/**
 * The requests that add one line. With a section: the line becomes a new paragraph right after the section's last
 * transcript line, so it stays inside the named range (which grows with it) and never splits or follows text the
 * student typed there. Without one: the heading and the line go after the doc's last paragraph, and that new text is
 * named so the next line can find it. Either way only the inserted text is styled.
 */
export function planTranscriptAppend(s: WriteSnapshot, line: string): DocsWriteRequest[] {
  if (!line || /\n/.test(line)) throw new Error('a transcript line is one non-empty line');
  if (s.anchor !== null) {
    const start = s.anchor;
    const end = start + line.length + 1;
    return [{ insertText: { location: { index: s.anchor - 1 }, text: `\n${line}` } }, plain({ startIndex: start, endIndex: end - 1 }), style({ startIndex: start, endIndex: end }, 'NORMAL_TEXT')];
  }
  const at = Math.max(1, s.bodyEnd - 1);
  const text = `\n${TRANSCRIPT_HEADING}\n${line}`;
  const start = at + 1;
  const headingEnd = start + TRANSCRIPT_HEADING.length + 1;
  const end = at + text.length + 1; // the body's last newline, which now ends the line's paragraph
  return [
    { insertText: { location: { index: at }, text } },
    { deleteParagraphBullets: { range: { startIndex: start, endIndex: end } } },
    plain({ startIndex: start, endIndex: end - 1 }),
    style({ startIndex: start, endIndex: headingEnd }, 'HEADING_2'),
    style({ startIndex: headingEnd, endIndex: end }, 'NORMAL_TEXT'),
    { createNamedRange: { name: TRANSCRIPT_RANGE, range: { startIndex: start, endIndex: end } } },
  ];
}

/**
 * Checks a request list against what the transcript writer may do: one insertion, right after the section's last
 * transcript line (or at the end of the doc for a new section), and styling, un-bulleting or naming of nothing but the
 * text it inserts (the last two only for a new section). Anything else (deleting or replacing text, moving content,
 * touching other ranges) is refused before it is sent.
 */
export function assertTranscriptOnly(requests: DocsWriteRequest[], s: WriteSnapshot): void {
  const inserts = requests.flatMap((r) => ('insertText' in r ? [r.insertText] : []));
  if (inserts.length !== 1) throw new Error('exactly one insertion per append');
  const ins = inserts[0];
  const lo = ins.location.index;
  const hi = lo + ins.text.length + 1;
  const expected = s.anchor !== null ? s.anchor - 1 : Math.max(1, s.bodyEnd - 1);
  if (lo !== expected) throw new Error('insertions go only after the last transcript line or at the end of the document');
  const allowed = s.anchor !== null ? ['updateTextStyle', 'updateParagraphStyle'] : ['updateTextStyle', 'updateParagraphStyle', 'deleteParagraphBullets', 'createNamedRange'];
  for (const r of requests) {
    const key = Object.keys(r)[0];
    if (key === 'insertText') continue;
    if (!allowed.includes(key)) throw new Error(`request not allowed: ${key}`);
    const range = (r as Record<string, { range: Span }>)[key].range;
    if (range.startIndex <= lo || range.endIndex > hi) throw new Error('styles and names apply only to the inserted text');
  }
}
