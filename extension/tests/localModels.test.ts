import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatCompletion, type AIRequest, type AIResult } from '../src/ai/client';
import { createPipelines } from '../src/ai/pipelines';
import { UsageTracker } from '../src/ai/usage';
import { coverageOf, checkInvariants, sectionOrder } from '../src/core/patch';
import { DEFAULT_SETTINGS, type AISettings, type Settings } from '../src/core/settings';
import { UNSORTED_SECTION_ID } from '../src/core/types';
import { SyncEngine } from '../src/engine/syncEngine';
import { memoryStore } from '../src/storage/db';
import { FakeDocs } from './harness';

/**
 * Opt-in check of a local model on NotePilot's real engine, prompts and client (not part of `npm test`):
 *   OLLAMA_MODEL=gemma3:4b TASK=simple|full [THINK=off] [REPORT=out.json] npx vitest run tests/localModels.test.ts
 * Made-up class notes only. Needs Ollama running at localhost:11434 with the model pulled.
 */
const MODEL = process.env.OLLAMA_MODEL;
const TASK = process.env.TASK === 'simple' ? 'simple' : 'full';

const NOTES = [
  { text: 'Cellular respiration', style: 'HEADING_1' },
  'glycolysis happens in cytoplasm, glucose -> 2 pyruvate, net 2 ATP + 2 NADH',
  'krebs cycle in mito matrix; each pyruvate -> acetyl CoA first (makes CO2 + NADH)',
  'ETC on inner membrane, NADH/FADH2 give electrons, O2 final acceptor -> water',
  'chemiosmosis: H+ gradient drives ATP synthase, ~26-28 ATP',
  'no O2 -> fermentation. lactic acid in muscles, ethanol + CO2 in yeast',
  'total ATP ~30-32 per glucose (textbook used to say 36-38)',
  'photosynthesis basically reverse?? ask',
];
const MORE = ['ATP synthase spins like a turbine as H+ flows thru', 'cyanide blocks complex IV of ETC -> no ATP'];

describe.skipIf(!MODEL)(`local model ${MODEL} (${TASK} task)`, () => {
  it('organizes made-up notes', { timeout: 30 * 60_000 }, async () => {
    const ollama: AISettings = { ...DEFAULT_SETTINGS.ai, mode: 'direct', baseUrl: 'http://localhost:11434/v1', apiKey: '', fastModel: MODEL!, deepModel: MODEL!, jsonMode: 'json_object', inputPricePerM: 0, outputPricePerM: 0 };
    // The simple task is chosen by the on-device mode; its calls are sent to Ollama instead, with the reply shape enforced.
    const settings: Settings = { ...DEFAULT_SETTINGS, frequency: 'realtime', ai: TASK === 'simple' ? { ...ollama, mode: 'device' } : ollama };
    const calls: { kind: string; ms: number; ok: boolean; error?: string; reply: string }[] = [];
    const fetchImpl: typeof fetch = (url, init) => {
      if (process.env.THINK === 'off' && init?.body) init = { ...init, body: JSON.stringify({ ...JSON.parse(String(init.body)), think: false, reasoning_effort: 'none' }) };
      return fetch(url, init);
    };
    const chat = async (_: AISettings, req: AIRequest): Promise<AIResult> => {
      const kind = req.jsonSchema?.name ?? (req.messages[0].content.includes('tutor') ? 'insights' : 'rewrite');
      const t0 = Date.now();
      try {
        const r = await chatCompletion(ollama, TASK === 'simple' ? { ...req, jsonMode: 'json_schema' } : req, fetchImpl);
        calls.push({ kind, ms: Date.now() - t0, ok: true, reply: r.text.slice(0, 1500) });
        return r;
      } catch (e) {
        calls.push({ kind, ms: Date.now() - t0, ok: false, error: String(e), reply: '' });
        throw e;
      }
    };
    const docs = new FakeDocs();
    const engine = new SyncEngine('DOC_local_model_check_00000', {
      docs,
      ai: createPipelines(() => settings, new UsageTracker(), undefined, chat),
      store: memoryStore(),
      getSettings: () => settings,
      gate: () => ({ ok: true }),
    });
    const settle = async (maxMs: number) => {
      const t0 = Date.now();
      let quiet = 0;
      while (Date.now() - t0 < maxMs) {
        const v = engine.view();
        if (v.pendingChanges === 0 && v.status === 'live' && !v.insightsBusy) {
          quiet ||= Date.now();
          if (Date.now() - quiet > 25_000) return Date.now() - t0 - 25_000;
        } else quiet = 0;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return -1;
    };
    const snapshot = () => {
      const doc = engine.state.organized;
      return {
        sections: sectionOrder(doc).map(({ id, depth }) => ({
          title: `${'  '.repeat(depth - 1)}${doc.sections[id].title}`,
          units: doc.sections[id].units.map((u) => `${doc.units[u].needsReview ? '[as written] ' : ''}${doc.units[u].content}`),
        })),
        unorganized: doc.sections[UNSORTED_SECTION_ID]?.units.length ?? 0,
        covered: coverageOf(doc).size,
        invariants: checkInvariants(doc),
        insights: engine.state.insights.map((i) => `${i.category}: ${i.title} — ${i.body.slice(0, 160)}`),
        metrics: { repairs: engine.state.metrics.repairs, fallbacks: engine.state.metrics.fallbacks },
        status: engine.view().statusDetail,
      };
    };

    docs.set(NOTES);
    await engine.start();
    const firstMs = await settle(15 * 60_000);
    const first = snapshot();
    docs.edit((p) => [...p.map((x) => (typeof x === 'string' && x.startsWith('total ATP') ? 'total ATP ~30-32 per glucose, not 38 (old estimate ignored proton leak)' : x)), ...MORE]);
    const secondMs = await settle(10 * 60_000);
    const second = snapshot();
    engine.stop();

    const report = { model: MODEL, task: TASK, think: process.env.THINK ?? 'default', firstMs, secondMs, first, second, calls };
    if (process.env.REPORT) writeFileSync(process.env.REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ model: MODEL, task: TASK, firstMs, secondMs, unorganized: [first.unorganized, second.unorganized], covered: [first.covered, second.covered], calls: calls.map((c) => `${c.kind}:${c.ok ? 'ok' : 'ERR'}:${Math.round(c.ms / 1000)}s`) }));
    expect(firstMs).toBeGreaterThanOrEqual(0);
  });
});
