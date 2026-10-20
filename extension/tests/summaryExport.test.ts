import { describe, expect, it, vi } from 'vitest';
import { buildRewriteMessages, buildSummaryMessages } from '../src/core/context';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { parseSummaryResponse, type DocSummary } from '../src/core/summary';
import { applyPatch } from '../src/core/patch';
import { latexToHtml } from '../src/core/latexText';
import { emptyOrganizedDoc, type Insight, type OrganizedDoc } from '../src/core/types';
import { makeRawBlock } from '../src/core/docParser';
import { DRIVE_FILE_SCOPE, DOCS_READONLY_SCOPE, type AuthProvider } from '../src/google/auth';
import { ExportError, saveAsGoogleDoc } from '../src/google/driveExport';
import { buildExportHtml, exportDocName } from '../src/sidepanel/exportHtml';
import { createPipelines } from '../src/ai/pipelines';
import { UsageTracker } from '../src/ai/usage';

const O = '\u27E6';
const C = '\u27E7';

function sampleDoc(): OrganizedDoc {
  return applyPatch(
    emptyOrganizedDoc('SRC_DOC'),
    [
      { op: 'create_section', ref: 'new:root', title: 'Chemical Bonds', parent: null },
      { op: 'create_section', ref: 'new:types', title: 'Bond Types', parent: 'new:root' },
      { op: 'create_unit', ref: 'new:t', section: 'new:types', type: 'table', origin: 'user', sources: ['b1'], content: '| Bond | Electrons |\n|---|---|\n| Ionic | transferred |\n| Covalent | shared |' },
      { op: 'create_unit', ref: 'new:c', section: 'new:types', type: 'paragraph', origin: 'clarification', sources: ['b2'], content: `Covalent bonds form between ${O}two nonmetals${C}.` },
      { op: 'create_unit', ref: 'new:e', section: 'new:types', type: 'equation', origin: 'expansion', sources: ['b2'], content: '$$\\mathrm{H_2} + \\tfrac{1}{2}\\mathrm{O_2} \\rightarrow \\mathrm{H_2O}$$' },
    ] as never,
    { validSourceIds: new Set(['b1', 'b2']), requiredSourceIds: ['b1', 'b2'], now: 1, sourceVersion: 1, allowExpansion: true },
    'Chemical Bonds',
  ).doc;
}

const insight = (over: Partial<Insight> = {}): Insight => ({
  id: 'ins_1', category: 'gap', title: 'Why do metals conduct?', body: 'Metallic bonding is not in the notes.', sectionIds: [], unitIds: [],
  confidence: 'medium', needsVerification: true, createdAt: 1, updatedAt: 1, orgVersion: 1, ...over,
});

describe('organization rules', () => {
  it('push the rewrite toward tables, numbered steps, nested lists and generous sections', () => {
    const b = { id: 'b1', ...makeRawBlock('paragraph', 'ionic vs covalent') };
    const sys = buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: [b], batch: { added: [b], modified: [], removed: [] }, settings: DEFAULT_SETTINGS }).messages[0].content;
    expect(sys).toContain('STRUCTURE: SHOW HOW THE INFORMATION IS ORGANIZED');
    expect(sys).toMatch(/"table".*two or more items are described by two or more of the same attributes/);
    expect(sys).toMatch(/numbered items \(1\. 2\. 3\.\): processes/);
    expect(sys).toMatch(/nested bullets/);
    expect(sys).toMatch(/Cut the notes into sections and subsections generously/);
    expect(sys).toMatch(/Split a long note that covers several ideas into separate units/);
  });
});

describe('summary', () => {
  const doc = sampleDoc();
  const sec = Object.values(doc.sections).find((s) => s.title === 'Bond Types')!.id;

  it('validates output, drops unknown section ids, and enforces limits', () => {
    const s = parseSummaryResponse(
      {
        overview: 'Bonds hold atoms together; ionic and covalent bonds differ in how electrons are handled.',
        key_points: Array.from({ length: 12 }, (_, i) => ({ text: `Point ${i}`, sections: [sec, 'sec_missing'] })),
        key_terms: [{ term: 'Covalent bond', definition: 'Electrons are shared.', sections: [sec] }],
      },
      doc,
      42,
    );
    expect(s.keyPoints).toHaveLength(7);
    expect(s.keyPoints[0].sectionIds).toEqual([sec]);
    expect(s.review).toEqual([]);
    expect(s.orgVersion).toBe(doc.version);
    expect(s.createdAt).toBe(42);
    expect(() => parseSummaryResponse({ key_points: [] }, doc)).toThrow();
  });

  it('sends the organized notes and insights as data, with an injection-safe prompt', () => {
    const msgs = buildSummaryMessages({ organized: doc, insights: [insight()], settings: DEFAULT_SETTINGS }).messages;
    expect(msgs[0].content).toMatch(/untrusted data/);
    expect(msgs[0].content).toMatch(/Summarize only what the notes say/);
    const payload = JSON.parse(msgs[1].content.slice(msgs[1].content.indexOf('{')));
    expect(payload.organized.sections.map((s: { title: string }) => s.title)).toEqual(['Chemical Bonds', 'Bond Types']);
    expect(payload.insights[0].title).toBe('Why do metals conduct?');
  });

  it('runs through the AI pipeline with the deeper model', async () => {
    const chat = vi.fn(async () => ({ text: JSON.stringify({ overview: 'An overview.', key_points: [{ text: 'P', sections: [sec] }], key_terms: [] }), promptTokens: 10, completionTokens: 10, latencyMs: 5 }));
    const settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, apiKey: 'k', fastModel: 'fast', deepModel: 'deep' } };
    const p = createPipelines(() => settings, new UsageTracker(), undefined, chat as never);
    const res = await p.summary(buildSummaryMessages({ organized: doc, insights: [], settings }).messages, doc, new AbortController().signal);
    expect(res.summary.keyPoints[0].sectionIds).toEqual([sec]);
    expect((chat.mock.calls[0] as unknown[])[1]).toMatchObject({ model: 'deep' });
  });
});

describe('Google Doc content', () => {
  const doc = sampleDoc();
  const sec = Object.values(doc.sections).find((s) => s.title === 'Bond Types')!.id;
  const summary: DocSummary = {
    overview: 'Two main bond types.',
    keyPoints: [{ text: 'Ionic bonds **transfer** electrons.', sectionIds: [sec] }],
    keyTerms: [{ term: 'Covalent bond', definition: 'Shared electrons.', sectionIds: [sec] }],
    review: [{ text: 'Metallic bonds are missing.', sectionIds: [] }],
    orgVersion: doc.version,
    createdAt: 1,
  };
  const html = buildExportHtml({ organized: doc, insights: [insight({ sectionIds: [sec] })], summary, sourceTitle: 'Chem notes', sourceDocId: 'SRC_DOC', includeExpansions: true, now: Date.UTC(2026, 9, 20) });

  it('is organized as Summary → Organized notes → Insights, with headings for the Docs outline', () => {
    const order = ['<h1>Summary</h1>', '<h2>Key points</h2>', '<h2>Key terms</h2>', '<h2>Review next</h2>', '<h1>Organized notes</h1>', '<h2>Chemical Bonds</h2>', '<h3>Bond Types</h3>', '<h1>Insights</h1>', '<h2>Knowledge gaps</h2>'];
    let at = 0;
    for (const h of order) {
      const i = html.indexOf(h, at);
      expect(i, h).toBeGreaterThan(-1);
      at = i;
    }
    expect(html).toContain('(see Bond Types)');
    expect(html).toContain('https://docs.google.com/document/d/SRC_DOC/edit');
  });

  it('keeps tables, highlights AI-completed words, labels AI content, and converts math to text', () => {
    expect(html).toMatch(/<table[^>]*><thead><tr><th[^>]*>Bond<\/th>/);
    expect(html).toContain('<span style="background-color:#dbeafe">two nonmetals</span>');
    expect(html).not.toMatch(/[\u27E6\u27E7]/);
    expect(html).toContain('AI CLARIFICATION');
    expect(html).toContain('AI EXPANSION · UNVERIFIED');
    expect(html).toContain('H<sub>2</sub> + 1/2O<sub>2</sub> → H<sub>2</sub>O');
    expect(html).not.toContain('katex');
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('(unverified)');
  });

  it('respects "Show AI expansions" and names the doc after the notes', () => {
    const noExp = buildExportHtml({ organized: doc, insights: [], summary: null, sourceTitle: 'Chem notes', sourceDocId: 'SRC_DOC', includeExpansions: false });
    expect(noExp).not.toContain('AI EXPANSION');
    expect(noExp).not.toContain('<h1>Summary</h1>');
    expect(exportDocName(doc, 'Chem notes')).toBe('Chemical Bonds — NotePilot notes');
  });

  it('converts common LaTeX to readable text', () => {
    expect(latexToHtml('\\tfrac{1}{2}\\,\\mathrm{O_2} + 2\\,e^- + 2\\,\\mathrm{H^+} \\rightarrow \\mathrm{H_2O}')).toBe('1/2 O<sub>2</sub> + 2 e<sup>-</sup> + 2 H<sup>+</sup> → H<sub>2</sub>O');
    expect(latexToHtml('E = mc^2')).toBe('E = mc<sup>2</sup>');
    expect(latexToHtml('\\Delta G = \\Delta H - T\\Delta S')).toBe('ΔG = ΔH - TΔS');
    expect(latexToHtml('\\frac{a+b}{2} \\geq \\sqrt{ab}')).toBe('(a+b)/2 ≥ √(ab)');
    expect(latexToHtml('x_{i+1} < 5 & <b>')).toBe('x<sub>i+1</sub> &lt; 5 &amp; &lt;b&gt;');
    expect(latexToHtml('25^\\circ C')).toBe('25° C');
  });
});

describe('saving the Google Doc', () => {
  const auth = (): AuthProvider & { scopes: string[][] } => {
    const scopes: string[][] = [];
    return { scopes, getToken: async (_i: boolean, s?: string[]) => (scopes.push(s ?? []), 'tok'), invalidate: async () => undefined, signOut: async () => undefined };
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('creates a Google Doc from HTML with the drive.file scope', async () => {
    const a = auth();
    const fetchImpl = vi.fn(async () => json(200, { id: 'NEW1', webViewLink: 'https://docs.google.com/document/d/NEW1/edit' }));
    const r = await saveAsGoogleDoc({ html: '<h1>Hi</h1>', name: 'N', sourceDocId: 'SRC', auth: a, fetchImpl: fetchImpl as never });
    expect(r).toEqual({ fileId: 'NEW1', url: 'https://docs.google.com/document/d/NEW1/edit', created: true });
    expect(a.scopes[0]).toEqual([DOCS_READONLY_SCOPE, DRIVE_FILE_SCOPE]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(String(init.body)).toContain('<h1>Hi</h1>');
  });

  it('updates the same companion doc on later saves', async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: 'DOC2', webViewLink: 'u', trashed: false }));
    const r = await saveAsGoogleDoc({ html: 'x', name: 'N', sourceDocId: 'SRC', existingFileId: 'DOC2', auth: auth(), fetchImpl: fetchImpl as never });
    expect(r.created).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/DOC2\?uploadType=multipart/);
    expect(init.method).toBe('PATCH');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never targets the source notes, even if asked to', async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: 'NEW3' }));
    await saveAsGoogleDoc({ html: 'x', name: 'N', sourceDocId: 'SRC', existingFileId: 'SRC', auth: auth(), fetchImpl: fetchImpl as never });
    for (const [url, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain('SRC');
      expect(init.method).toBe('POST');
    }
  });

  it('creates a new doc when the old one was deleted or trashed', async () => {
    const deleted = vi.fn().mockResolvedValueOnce(json(404, { error: { message: 'File not found' } })).mockResolvedValueOnce(json(200, { id: 'NEW4' }));
    expect((await saveAsGoogleDoc({ html: 'x', name: 'N', sourceDocId: 'SRC', existingFileId: 'OLD', auth: auth(), fetchImpl: deleted as never })).fileId).toBe('NEW4');
    const trashed = vi.fn().mockResolvedValueOnce(json(200, { id: 'OLD', trashed: true })).mockResolvedValueOnce(json(200, { id: 'NEW5' }));
    expect((await saveAsGoogleDoc({ html: 'x', name: 'N', sourceDocId: 'SRC', existingFileId: 'OLD', auth: auth(), fetchImpl: trashed as never })).fileId).toBe('NEW5');
  });

  it('explains a disabled Drive API and a refused permission', async () => {
    const disabled = vi.fn(async () => json(403, { error: { message: 'Google Drive API has not been used in project 123', errors: [{ reason: 'accessNotConfigured' }] } }));
    await expect(saveAsGoogleDoc({ html: 'x', name: 'N', sourceDocId: 'SRC', auth: auth(), fetchImpl: disabled as never })).rejects.toMatchObject({ kind: 'api_disabled' });
    const noAuth: AuthProvider = { getToken: async () => Promise.reject(new Error('The user did not approve access.')), invalidate: async () => undefined, signOut: async () => undefined };
    const err = await saveAsGoogleDoc({ html: 'x', name: 'N', sourceDocId: 'SRC', auth: noAuth, fetchImpl: vi.fn() as never }).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.kind).toBe('auth');
  });

  it('retries once with a fresh token after a 401', async () => {
    const a = auth();
    const invalidate = vi.spyOn(a, 'invalidate');
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, { id: 'NEW6' }));
    expect((await saveAsGoogleDoc({ html: 'x', name: 'N', sourceDocId: 'SRC', auth: a, fetchImpl: fetchImpl as never })).fileId).toBe('NEW6');
    expect(invalidate).toHaveBeenCalledWith('tok');
  });
});
