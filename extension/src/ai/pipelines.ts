import type { ChatMessage } from '../core/context';
import type { Settings } from '../core/settings';
import {
  extractJson,
  parseInsightsResponse,
  parseRewriteResponse,
  REWRITE_JSON_SCHEMA,
  stripNullOpFields,
  type InsightItem,
  type RewriteResponse,
} from '../core/schema';
import type { SimpleRewrite } from '../core/simpleRewrite';
import { hash53 } from '../core/text';
import { parseSummaryResponse, type DocSummary } from '../core/summary';
import { parseReview, REVIEW_SCHEMA, type QuestionKind, type ReviewQuiz } from '../core/review';
import type { OrganizedDoc } from '../core/types';
import { AIError, chatCompletion, type AIResult } from './client';
import type { UsageTracker } from './usage';

/**
 * The two AI pipelines:
 *  - rewrite  (fast model, high priority): produces validated patch ops for the organized notes.
 *  - insights (deeper model, low priority): produces validated insight updates.
 *
 * Both validate the model output against a schema and retry once with the validation error
 * when the output is malformed. Identical requests are served from a local cache.
 */

export interface ResponseCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface AIPipelines {
  /** `simple`: the on-device task (see simpleRewrite.ts), whose reply NotePilot turns into the patch. */
  rewrite(messages: ChatMessage[], signal: AbortSignal, simple?: SimpleRewrite): Promise<RewriteResponse & { latencyMs: number; cached: boolean }>;
  insights(messages: ChatMessage[], signal: AbortSignal): Promise<{ upsert: InsightItem[]; remove: string[]; latencyMs: number; cached: boolean }>;
  /** On-demand summary (deeper model). Validated against the doc it summarizes. */
  summary(messages: ChatMessage[], doc: OrganizedDoc, signal: AbortSignal, opts?: { fresh?: boolean }): Promise<{ summary: DocSummary; latencyMs: number; cached: boolean }>;
  /** A quiz on the notes (deeper model), always freshly written so each quiz is new. */
  review(messages: ChatMessage[], doc: OrganizedDoc, kinds: QuestionKind[], signal: AbortSignal): Promise<{ quiz: ReviewQuiz; latencyMs: number; cached: boolean }>;
}

export type ChatFn = typeof chatCompletion;

const strings = { type: 'array', items: { type: 'string' } };
/** Reply shapes for the on-device model's insights and summary (see the prompts for the fields' meaning). */
const DEVICE_SCHEMAS: Record<'insights' | 'summary' | 'review', { name: string; schema: object }> = {
  review: REVIEW_SCHEMA,
  insights: {
    name: 'insights',
    schema: {
      type: 'object',
      properties: {
        upsert: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              category: { type: 'string', enum: ['connection', 'deeper', 'error', 'gap', 'practice'] },
              title: { type: 'string' },
              body: { type: 'string' },
              sectionIds: strings,
              unitIds: strings,
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
              needsVerification: { type: 'boolean' },
              question: { type: 'object', properties: { prompt: { type: 'string' }, answer: { type: 'string' } }, required: ['prompt'] },
            },
            required: ['category', 'title', 'body', 'sectionIds'],
          },
        },
        remove: strings,
      },
      required: ['upsert', 'remove'],
    },
  },
  summary: {
    name: 'summary',
    schema: {
      type: 'object',
      properties: {
        overview: { type: 'string' },
        sections: { type: 'array', items: { type: 'object', properties: { section: { type: 'string' }, content: { type: 'string' } }, required: ['section', 'content'] } },
        key_terms: { type: 'array', items: { type: 'object', properties: { term: { type: 'string' }, definition: { type: 'string' }, sections: strings }, required: ['term', 'definition'] } },
        review: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, sections: strings }, required: ['text'] } },
      },
      required: ['overview', 'sections'],
    },
  },
};

export function createPipelines(
  getSettings: () => Settings,
  usage: UsageTracker,
  cache?: ResponseCache,
  chat: ChatFn = chatCompletion,
): AIPipelines {
  async function call<T>(
    kind: 'rewrite' | 'insights' | 'summary' | 'review',
    messages: ChatMessage[],
    signal: AbortSignal,
    parse: (json: unknown) => T,
    opts: { fresh?: boolean; schema?: { name: string; schema: object } } = {},
  ): Promise<T & { latencyMs: number; cached: boolean }> {
    const s = getSettings();
    const model = kind === 'rewrite' ? s.ai.fastModel : s.ai.deepModel || s.ai.fastModel;
    const key = `${kind}:${hash53(`${s.ai.mode}|${s.ai.baseUrl}|${model}|${JSON.stringify(messages)}`)}`;
    const cachedText = opts.fresh ? undefined : await cache?.get(key).catch(() => undefined);
    if (cachedText) {
      try {
        usage.recordCacheHit();
        return { ...parse(extractJson(cachedText)), latencyMs: 0, cached: true };
      } catch {
        /* stale/invalid cache entry: fall through to a live call */
      }
    }

    let convo = messages;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: AIResult;
      result = await chat(s.ai, {
        model,
        messages: convo,
        temperature: kind === 'insights' || kind === 'review' ? 0.4 : 0.2,
        maxTokens: kind === 'summary' ? 4000 : kind === 'review' ? 6000 : 8000,
        jsonMode: s.ai.jsonMode,
        // The on-device model is held to an exact reply shape for every call: "any JSON object" lets it answer {}.
        jsonSchema: opts.schema ?? (kind === 'rewrite' ? REWRITE_JSON_SCHEMA : s.ai.mode === 'device' ? DEVICE_SCHEMAS[kind] : undefined),
        signal,
      });
      usage.record(s.ai, result.promptTokens, result.completionTokens, kind === 'rewrite' ? 'fast' : 'deep');
      try {
        const parsed = parse(extractJson(result.text));
        void cache?.set(key, result.text).catch(() => undefined);
        return { ...parsed, latencyMs: result.latencyMs, cached: false };
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        convo = [
          ...messages,
          { role: 'assistant', content: result.text.slice(0, 4000) },
          { role: 'user', content: `Your reply could not be used: ${msg.slice(0, 600)}. Reply again with ONLY the JSON object in the required format.` },
        ];
      }
    }
    throw new AIError('invalid_output', `Model output failed validation: ${lastError instanceof Error ? lastError.message.slice(0, 200) : ''}`);
  }

  return {
    rewrite: (messages, signal, simple) => {
      if (simple?.empty) return Promise.resolve({ title: null, ops: [], invalidOps: [], latencyMs: 0, cached: true });
      if (simple) return call('rewrite', messages, signal, (json) => ({ ...simple.toPatch(json), invalidOps: [] }), { schema: simple.schema });
      return call('rewrite', messages, signal, (json) => {
        const r = parseRewriteResponse(stripNullOpFields(json));
        // A patch where every op is malformed is treated as invalid output (retry with feedback).
        if (r.ops.length === 0 && r.invalidOps.length > 0) throw new Error(`all ops invalid, e.g. ${r.invalidOps[0].error}`);
        return r;
      });
    },
    insights: (messages, signal) => call('insights', messages, signal, (json) => parseInsightsResponse(json)),
    summary: (messages, doc, signal, opts) => call('summary', messages, signal, (json) => ({ summary: parseSummaryResponse(json, doc) }), opts),
    review: (messages, doc, kinds, signal) => call('review', messages, signal, (json) => ({ quiz: parseReview(json, doc, { kinds }) }), { fresh: true }),
  };
}
