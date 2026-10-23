import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIRequest, AIResult } from '../src/ai/client';
import { createPipelines } from '../src/ai/pipelines';
import { UsageTracker } from '../src/ai/usage';
import { buildRewriteMessages, type ChatMessage } from '../src/core/context';
import { checkInvariants, coverageOf } from '../src/core/patch';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import { toPatch } from '../src/core/simpleRewrite';
import { UNSORTED_SECTION_ID, emptyOrganizedDoc, type OrganizedDoc, type SourceBlock } from '../src/core/types';
import { SyncEngine } from '../src/engine/syncEngine';
import { memoryStore } from '../src/storage/db';
import { FakeDocs, outline, unitsOf } from './harness';

afterEach(() => vi.useRealTimers());

const device: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, mode: 'device' } };
const block = (id: string, text: string, kind: SourceBlock['kind'] = 'paragraph'): SourceBlock => ({ id, kind, text, hash: id });
const none = { added: [], modified: [], removed: [] };
const inputOf = (messages: ChatMessage[]) => {
  const user = messages.find((m) => m.role === 'user')!.content;
  return JSON.parse(user.slice(user.indexOf('{'))) as { sections: string[]; headings: string[]; notes: { id: string; text: string }[] };
};

/** An organized doc with one section ("Light reactions") holding one unit for b1, and a placeholder for b2. */
function organizedWith(): OrganizedDoc {
  const doc = emptyOrganizedDoc('d');
  const t = 1;
  doc.sections = {
    sec_1: { id: 'sec_1', title: 'Light reactions', parentId: null, children: [], units: ['u_1'], createdAt: t, updatedAt: t },
    [UNSORTED_SECTION_ID]: { id: UNSORTED_SECTION_ID, title: 'Not Yet Organized', parentId: null, children: [], units: ['u_2', 'u_3'], createdAt: t, updatedAt: t },
  };
  doc.rootSections = ['sec_1', UNSORTED_SECTION_ID];
  const unit = (id: string, sectionId: string, sources: string[], needsReview?: boolean) => ({ id, sectionId, type: 'paragraph' as const, content: `old ${id}`, origin: 'user' as const, sources, concepts: [], needsReview, createdAt: t, updatedAt: t, sourceVersion: 1 });
  doc.units = { u_1: unit('u_1', 'sec_1', ['b1']), u_2: unit('u_2', UNSORTED_SECTION_ID, ['b2'], true), u_3: unit('u_3', UNSORTED_SECTION_ID, ['b5', 'b6']) };
  doc.nextId = 4;
  return doc;
}

describe('the on-device rewrite task', () => {
  it('sends only the new and changed notes, with a short instruction and ids limited to theirs', () => {
    const blocks = [block('h1', 'Photosynthesis', 'heading'), block('b1', 'light rxns make ATP'), block('b2', 'calvin cycle fixes CO2')];
    const built = buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: blocks, batch: { added: blocks, modified: [], removed: [] }, settings: device });
    expect(built.simple?.empty).toBe(false);
    expect(built.messages[0].content.length).toBeLessThan(1500); // the cloud instructions are ~14,000 characters
    const input = inputOf(built.messages);
    expect(input.notes.map((n) => n.id)).toEqual(['b1', 'b2']); // headings are section hints, not notes
    expect(input.headings).toEqual(['Photosynthesis']);
    const schema = built.simple!.schema.schema as { properties: { notes: { items: { properties: { id: { enum: string[] } } } } } };
    expect(schema.properties.notes.items.properties.id.enum).toEqual(['b1', 'b2']);
    // Cloud providers keep the full patch task.
    expect(buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: blocks, batch: { added: blocks, modified: [], removed: [] }, settings: DEFAULT_SETTINGS }).simple).toBeUndefined();
  });

  it('needs no model call when only headings changed or notes were removed', () => {
    const built = buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: [], batch: { added: [block('h1', 'Title', 'heading')], modified: [], removed: [block('b9', 'gone')] }, settings: device });
    expect(built.simple?.empty).toBe(true);
  });

  it('a reorganize pass sends the notes still shown as written', () => {
    const blocks = [block('b1', 'one'), block('b2', 'two'), block('b5', 'five'), block('b6', 'six')];
    const built = buildRewriteMessages({ organized: organizedWith(), currentBlocks: blocks, batch: none, settings: device, reorganizeOnly: true });
    expect(inputOf(built.messages).notes.map((n) => n.id)).toEqual(['b2']);
    expect(inputOf(built.messages).sections).toEqual(['Light reactions']); // never "Not Yet Organized"
  });

  it('turns the reply into the patch: new units cite their note, sections are reused or made once, placeholders move out', () => {
    const doc = organizedWith();
    const notes = [block('b1', 'x'), block('b2', 'y'), block('b3', 'z'), block('b4', 'w'), block('b5', 'v')];
    const { ops } = toPatch(doc, notes, {
      notes: [
        { id: 'b1', section: 'Somewhere else', text: 'Light reactions make ATP.' }, // already placed: updated in place
        { id: 'b2', section: 'calvin  cycle', text: 'The Calvin cycle fixes CO2.' }, // placeholder: updated and moved
        { id: 'b3', section: 'Calvin Cycle', text: 'Rubisco is slow.' }, // same new section (case and spaces ignored)
        { id: 'b4', section: 'light reactions', text: '- ATP\n- NADPH' }, // existing section
        { id: 'b3', section: 'Other', text: 'duplicate' }, // second answer for b3: ignored
        { id: 'b9', section: 'Other', text: 'not sent' }, // unknown id: ignored
        { id: 'b5', section: 'Other', text: 'part of a merged unit' }, // left as it is
      ],
    });
    expect(ops).toEqual([
      { op: 'update_unit', id: 'u_1', content: 'Light reactions make ATP.' },
      { op: 'update_unit', id: 'u_2', content: 'The Calvin cycle fixes CO2.' },
      { op: 'create_section', ref: 's_new_1', title: 'calvin cycle', parent: null },
      { op: 'move_unit', id: 'u_2', section: 's_new_1' },
      { op: 'create_unit', ref: 'u_new_2', section: 's_new_1', type: 'paragraph', content: 'Rubisco is slow.', origin: 'user', sources: ['b3'], concepts: [] },
      { op: 'create_unit', ref: 'u_new_3', section: 'sec_1', type: 'list', content: '- ATP\n- NADPH', origin: 'user', sources: ['b4'], concepts: [] },
    ]);
    expect(() => toPatch(doc, notes, {})).toThrow(); // another shape is retried with the error
  });

  it('holds every on-device call to an exact reply shape, and skips the call when there is nothing to rewrite', async () => {
    const seen: AIRequest[] = [];
    const chat = async (_: unknown, req: AIRequest): Promise<AIResult> => {
      seen.push(req);
      return { text: req.jsonSchema?.name === 'notes' ? '{"notes":[]}' : '{"upsert":[],"remove":[]}', promptTokens: 1, completionTokens: 1, latencyMs: 1, model: 'chrome-built-in' };
    };
    const p = createPipelines(() => device, new UsageTracker(), undefined, chat);
    const built = buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: [block('b1', 'a')], batch: { added: [block('b1', 'a')], modified: [], removed: [] }, settings: device });
    await p.rewrite(built.messages, new AbortController().signal, built.simple);
    expect(seen[0].jsonSchema).toBe(built.simple!.schema);
    await p.insights([{ role: 'user', content: '{}' }], new AbortController().signal);
    expect(seen[1].jsonSchema?.name).toBe('insights');
    const empty = buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: [], batch: { added: [block('h', 'T', 'heading')], modified: [], removed: [] }, settings: device });
    expect(await p.rewrite(empty.messages, new AbortController().signal, empty.simple)).toMatchObject({ ops: [] });
    expect(seen).toHaveLength(2);
    // Cloud insights stay as they were.
    const cloud = createPipelines(() => DEFAULT_SETTINGS, new UsageTracker(), undefined, chat);
    await cloud.insights([{ role: 'user', content: '{}' }], new AbortController().signal);
    expect(seen[2].jsonSchema).toBeUndefined();
  });
});

describe('the engine with the on-device task', () => {
  function setup(reply: (notes: { id: string; text: string }[]) => string) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-23T14:00:00Z'));
    const docs = new FakeDocs();
    const chat = vi.fn(async (_: unknown, req: AIRequest): Promise<AIResult> => {
      const text = req.jsonSchema?.name === 'notes' ? reply(inputOf(req.messages).notes) : '{"upsert":[],"remove":[]}';
      return { text, promptTokens: 1, completionTokens: 1, latencyMs: 1, model: 'chrome-built-in' };
    });
    const ai = createPipelines(() => device, new UsageTracker(), undefined, chat);
    const engine = new SyncEngine('DOC_1234567890abcdefghij', { docs, ai, store: memoryStore(), getSettings: () => device, gate: () => ({ ok: true }) });
    return { docs, engine, chat, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
  }
  const model = (notes: { id: string; text: string }[]) =>
    JSON.stringify({ notes: notes.map((n) => ({ id: n.id, section: /alpha|beta/.test(n.text) ? 'Greek letters' : 'Numbers', text: `Rewritten: ${n.text}` })) });

  it('organizes, updates and removes notes with nothing left "not yet organized"', async () => {
    const h = setup(model);
    h.docs.set(['alpha note one', 'beta note two', 'seven is a number']);
    await h.engine.start();
    await h.advance(15_000);
    let doc = h.engine.state.organized;
    expect(outline(doc)).toEqual(['Greek letters', 'Numbers']);
    expect(unitsOf(doc, 'Greek letters').map((u) => u.content)).toEqual(['Rewritten: alpha note one', 'Rewritten: beta note two']);
    expect(doc.sections[UNSORTED_SECTION_ID]).toBeUndefined();
    expect(coverageOf(doc).size).toBe(3);
    const betaUnit = unitsOf(doc, 'Greek letters')[1].id;

    h.docs.edit((p) => p.map((x) => (x === 'beta note two' ? 'beta note 2, corrected' : x)));
    await h.advance(20_000);
    doc = h.engine.state.organized;
    expect(doc.units[betaUnit].content).toBe('Rewritten: beta note 2, corrected'); // same unit, same place
    h.docs.edit((p) => p.filter((x) => x !== 'alpha note one'));
    await h.advance(20_000);
    doc = h.engine.state.organized;
    expect(unitsOf(doc, 'Greek letters').map((u) => u.content)).toEqual(['Rewritten: beta note 2, corrected']);
    expect(checkInvariants(doc)).toEqual([]);
    h.engine.stop();
  });

  it('sends long notes to the slower on-device model in small batches', async () => {
    const h = setup(model);
    h.docs.set([`alpha ${'a'.repeat(1200)}`, `beta ${'b'.repeat(1200)}`, `seven ${'7'.repeat(1200)}`]);
    await h.engine.start();
    await h.advance(60_000);
    const sizes = h.chat.mock.calls.filter(([, r]) => r.jsonSchema?.name === 'notes').map(([, r]) => inputOf(r.messages).notes.length);
    expect(sizes).toEqual([1, 1, 1]); // a cloud model gets all three at once
    expect(coverageOf(h.engine.state.organized).size).toBe(3);
    h.engine.stop();
  });

  it('notes shown as written after unusable replies are organized by the next pass', async () => {
    let bad = 4; // two engine attempts, each retried once by the pipeline
    const h = setup((notes) => (bad-- > 0 ? 'Sorry, I cannot help with that.' : model(notes)));
    h.docs.set(['alpha note one', 'seven is a number']);
    await h.engine.start();
    await h.advance(20_000);
    expect(Object.values(h.engine.state.organized.units).every((u) => u.needsReview)).toBe(true);
    await h.advance(120_000); // the reorganize pass
    const doc = h.engine.state.organized;
    expect(doc.sections[UNSORTED_SECTION_ID]).toBeUndefined();
    expect(outline(doc)).toEqual(['Greek letters', 'Numbers']);
    expect(Object.values(doc.units).every((u) => u.content.startsWith('Rewritten:') && !u.needsReview)).toBe(true);
    expect(checkInvariants(doc)).toEqual([]);
    h.engine.stop();
  });
});
