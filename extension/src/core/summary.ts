import { z } from 'zod';
import type { OrganizedDoc } from './types';

/**
 * On-demand study summary of the organized notes ("Summary" button). It is generated only when
 * the user asks for it, shown at the top of the notes, and included in the companion Google Doc.
 */
export interface DocSummary {
  /** Two or three sentences: what the notes cover and how the parts fit together. */
  overview: string;
  /** The most important points, each linked to the organized section(s) it comes from. */
  keyPoints: { text: string; sectionIds: string[] }[];
  /** Key terms with a short meaning, linked to sections. */
  keyTerms: { term: string; definition: string; sectionIds: string[] }[];
  /** What to look at again: unclear spots, possible errors, gaps (drawn from the notes and insights). */
  review: { text: string; sectionIds: string[] }[];
  /** OrganizedDoc.version the summary describes (older ⇒ "notes changed since this summary"). */
  orgVersion: number;
  createdAt: number;
}

export const SUMMARY_LIMITS = { keyPoints: 7, keyTerms: 10, review: 4 } as const;

const str = (max: number) => z.string().trim().min(1).max(max * 3).transform((s) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s));
const ids = z.array(z.string()).max(6).optional().default([]);

const summaryResponse = z.object({
  overview: str(700),
  key_points: z.array(z.object({ text: str(300), sections: ids })).max(20).default([]),
  key_terms: z.array(z.object({ term: str(80), definition: str(240), sections: ids })).max(30).default([]),
  review: z.array(z.object({ text: str(240), sections: ids })).max(12).optional().default([]),
});

/** Validates model output, drops references to sections that don't exist, and enforces the limits. */
export function parseSummaryResponse(json: unknown, doc: OrganizedDoc, now = Date.now()): DocSummary {
  const r = summaryResponse.parse(json);
  const keep = (list: string[]) => [...new Set(list.filter((id) => doc.sections[id]))];
  return {
    overview: r.overview,
    keyPoints: r.key_points.slice(0, SUMMARY_LIMITS.keyPoints).map((p) => ({ text: p.text, sectionIds: keep(p.sections) })),
    keyTerms: r.key_terms.slice(0, SUMMARY_LIMITS.keyTerms).map((t) => ({ term: t.term, definition: t.definition, sectionIds: keep(t.sections) })),
    review: r.review.slice(0, SUMMARY_LIMITS.review).map((p) => ({ text: p.text, sectionIds: keep(p.sections) })),
    orgVersion: doc.version,
    createdAt: now,
  };
}
