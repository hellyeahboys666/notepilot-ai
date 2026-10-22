import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIError, chatCompletion, type AIRequest } from '../src/ai/client';
import { availability, chat, download, type Availability } from '../src/ai/onDevice';
import { createPipelines } from '../src/ai/pipelines';
import { UsageTracker } from '../src/ai/usage';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { emptyOrganizedDoc } from '../src/core/types';
import type { ChatMessage } from '../src/core/context';

type Input = string | ChatMessage[];
type Options = { signal?: AbortSignal; responseConstraint?: object };
type CreateOptions = {
  initialPrompts?: ChatMessage[];
  expectedInputs?: { type: string; languages: string[] }[];
  expectedOutputs?: { type: string; languages: string[] }[];
  signal?: AbortSignal;
  monitor?: (monitor: EventTarget) => void;
};

class FakeSession extends EventTarget {
  contextUsage = 20;
  contextWindow = 4096;
  measureContextUsage = vi.fn(async (_input: Input, _options?: Options) => 10);
  prompt = vi.fn(async (_input: Input, _options?: Options) => '{"ok":true}');
  clone = vi.fn(async (_options?: { signal?: AbortSignal }): Promise<FakeSession> => new FakeSession());
  destroy = vi.fn(() => {});
}

function fakeModel() {
  const sessions: FakeSession[] = [];
  let setup: (s: FakeSession) => void = () => {};
  const session = () => {
    const s = new FakeSession();
    sessions.push(s);
    s.clone.mockImplementation(async () => session());
    setup(s);
    return s;
  };
  const api = {
    availability: vi.fn(async (_options?: unknown): Promise<Availability> => 'available'),
    create: vi.fn(async (_options: CreateOptions) => session()),
  };
  vi.stubGlobal('LanguageModel', api);
  return { api, sessions, session, setup: (fn: typeof setup) => { setup = fn; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const request = (overrides: Partial<AIRequest> = {}): AIRequest => ({
  model: 'a-remote-model-is-ignored',
  messages: [{ role: 'system', content: 'Organize the notes. Return JSON.' }, { role: 'user', content: 'My notes' }],
  maxTokens: 100,
  jsonMode: 'json_object',
  ...overrides,
});
const device = { ...DEFAULT_SETTINGS.ai, mode: 'device' as const };

let fake: ReturnType<typeof fakeModel>;
beforeEach(() => { fake = fakeModel(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('on-device readiness', () => {
  it.each(['unavailable', 'downloadable', 'downloading', 'available'] as const)('maps %s without starting a download', async (status) => {
    fake.api.availability.mockResolvedValue(status);
    expect(await availability()).toBe(status);
    expect(fake.api.availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it('reports unavailable when Chrome has no LanguageModel global', async () => {
    vi.stubGlobal('LanguageModel', undefined);
    expect(await availability()).toBe('unavailable');
    const error = await chat(request()).catch((e) => e as AIError);
    expect(error).toBeInstanceOf(AIError);
    expect(error).toMatchObject({ kind: 'bad_request', message: expect.stringMatching(/unavailable.*Settings/) });
  });

  it('does not turn an unknown readiness value into available', async () => {
    fake.api.availability.mockResolvedValue('future-value' as Availability);
    expect(await availability()).toBe('unavailable');
  });

  it.each([
    ['unavailable', /unavailable/],
    ['downloadable', /Download the model in Settings/],
    ['downloading', /still downloading/],
  ] as const)('refuses background creation when %s', async (status, message) => {
    fake.api.availability.mockResolvedValue(status);
    await expect(chat(request())).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringMatching(message) });
    expect(fake.api.create).not.toHaveBeenCalled();
  });
});

describe('model download', () => {
  it('creates immediately from the click and reports normalized progress, then frees the probe', async () => {
    const ready = deferred<FakeSession>();
    const progress = vi.fn();
    const monitor = new EventTarget();
    fake.api.create.mockImplementation((options) => {
      options.monitor?.(monitor);
      return ready.promise;
    });
    const controller = new AbortController();
    const result = download(progress, controller.signal);
    // No awaited availability() is allowed before create(), or user activation may be lost.
    expect(fake.api.create).toHaveBeenCalledTimes(1);
    expect(fake.api.availability).not.toHaveBeenCalled();
    expect(fake.api.create.mock.calls[0][0]).toMatchObject({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      signal: controller.signal,
    });
    monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.4, total: 1 }));
    expect(progress).toHaveBeenLastCalledWith(0.4);
    const session = fake.session();
    ready.resolve(session);
    await result;
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it('cancels pending download, ignores late progress, and destroys a late session', async () => {
    const ready = deferred<FakeSession>();
    const monitor = new EventTarget();
    fake.api.create.mockImplementation((options) => { options.monitor?.(monitor); return ready.promise; });
    const progress = vi.fn();
    const controller = new AbortController();
    const failed = download(progress, controller.signal).catch((e) => e as AIError);
    controller.abort();
    expect(await failed).toMatchObject({ kind: 'aborted' });
    monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.8, total: 1 }));
    expect(progress).not.toHaveBeenCalled();
    const late = fake.session();
    ready.resolve(late);
    await ready.promise;
    expect(late.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a pre-aborted download without creating a model', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(download(undefined, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it('maps unsupported-device download failures', async () => {
    fake.api.create.mockRejectedValue(new DOMException('No compatible model', 'NotSupportedError'));
    await expect(download()).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringContaining('No compatible model') });
  });
});

describe('on-device requests', () => {
  it('seeds the system prompt, sends only the user prompt and passes the raw schema as the constraint', async () => {
    const controller = new AbortController();
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const req = request({ jsonMode: 'prompt_only', jsonSchema: { name: 'reply', schema }, signal: controller.signal });
    const result = await chat(req);
    expect(fake.api.create).toHaveBeenCalledOnce();
    const creation = fake.api.create.mock.calls[0][0];
    expect(creation.initialPrompts).toEqual([req.messages[0]]);
    expect(creation.signal).not.toBe(controller.signal);
    const [base, clone] = fake.sessions;
    expect(base.clone).toHaveBeenCalledWith({ signal: controller.signal });
    expect(base.prompt).not.toHaveBeenCalled();
    expect(clone.measureContextUsage).toHaveBeenCalledWith('My notes', { responseConstraint: schema, signal: controller.signal });
    expect(clone.prompt).toHaveBeenCalledWith('My notes', { responseConstraint: schema, signal: controller.signal });
    expect(clone.prompt.mock.calls[0][1]).not.toHaveProperty('maxTokens');
    expect(result).toMatchObject({
      text: '{"ok":true}',
      model: 'chrome-built-in',
      promptTokens: Math.ceil(JSON.stringify(req.messages).length / 4),
      completionTokens: Math.ceil('{"ok":true}'.length / 4),
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(clone.destroy).toHaveBeenCalledOnce();
    expect(base.destroy).not.toHaveBeenCalled();
  });

  it.each(['json_object', 'json_schema'] as const)('constrains %s to an object when no schema is supplied', async (jsonMode) => {
    await chat(request({ jsonMode }));
    expect(fake.sessions[1].prompt.mock.calls[0][1]?.responseConstraint).toEqual({ type: 'object' });
  });

  it('falls back to any JSON object when Chrome cannot compile the schema', async () => {
    const schema = { type: 'object', properties: { ops: { anyOf: [{ type: 'array' }, { type: 'null' }] } } };
    fake.setup((s) => s.prompt.mockImplementation(async (_input, options) => {
      if (options?.responseConstraint === schema) throw Object.assign(new Error('Unsupported schema'), { name: 'NotSupportedError' });
      return '{"ops":[]}';
    }));
    const result = await chat(request({ jsonSchema: { name: 'patch', schema } }));
    expect(result.text).toBe('{"ops":[]}');
    expect(fake.sessions[1].prompt.mock.calls.map((c) => c[1]?.responseConstraint)).toEqual([schema, { type: 'object' }]);
    // Without a schema there is nothing to relax: the error stands.
    fake.setup((s) => s.prompt.mockRejectedValue(Object.assign(new Error('No'), { name: 'NotSupportedError' })));
    await expect(chat(request({ messages: [{ role: 'system', content: 'Other' }, { role: 'user', content: 'x' }] }))).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('leaves prompt-only output unconstrained without a schema', async () => {
    await chat(request({ jsonMode: 'prompt_only' }));
    expect(fake.sessions[1].prompt.mock.calls[0][1]).not.toHaveProperty('responseConstraint');
  });

  it('preserves repair conversation roles instead of losing the feedback', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Instructions' },
      { role: 'user', content: 'Notes' },
      { role: 'assistant', content: 'Bad output' },
      { role: 'user', content: 'Please fix the JSON' },
    ];
    await chat(request({ messages }));
    expect(fake.sessions[1].prompt.mock.calls[0][0]).toEqual(messages.slice(1));
  });

  it('handles the connection probe without a system prompt', async () => {
    await chat(request({ messages: [{ role: 'user', content: 'Reply with JSON' }] }));
    expect(fake.api.create.mock.calls[0][0].initialPrompts).toEqual([]);
    expect(fake.sessions[1].prompt.mock.calls[0][0]).toBe('Reply with JSON');
  });

  it('reuses the instruction-only base but never shares notes between clones', async () => {
    await chat(request());
    await chat(request({ messages: [request().messages[0], { role: 'user', content: 'Different notes' }] }));
    expect(fake.api.create).toHaveBeenCalledOnce();
    const [base, first, second] = fake.sessions;
    expect(base.clone).toHaveBeenCalledTimes(2);
    expect(first.prompt).toHaveBeenCalledWith('My notes', expect.any(Object));
    expect(second.prompt).toHaveBeenCalledWith('Different notes', expect.any(Object));
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).toHaveBeenCalledOnce();
    await chat(request({ messages: [{ role: 'system', content: 'Different instructions' }, { role: 'user', content: 'Notes' }] }));
    expect(fake.api.create).toHaveBeenCalledTimes(2);
  });

  it('bounds the instruction-session cache and destroys evicted bases', async () => {
    for (let i = 0; i < 5; i++) {
      await chat(request({ messages: [{ role: 'system', content: `Instructions ${i}` }, { role: 'user', content: 'Notes' }] }));
    }
    expect(fake.api.create).toHaveBeenCalledTimes(5);
    expect(fake.sessions[0].destroy).toHaveBeenCalledOnce();
    expect(fake.sessions[2].destroy).toHaveBeenCalledOnce();
    expect(fake.sessions.filter((s) => !s.destroy.mock.calls.length)).toHaveLength(3);
  });

  it('rejects empty replies and still destroys the clone', async () => {
    fake.setup((s) => s.prompt.mockResolvedValue(''));
    await expect(chat(request())).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
  });
});

describe('context limits', () => {
  it('works on Chrome builds without the newer context measurement helper', async () => {
    fake.setup((s) => Object.defineProperty(s, 'measureContextUsage', { value: undefined }));
    await expect(chat(request())).resolves.toHaveProperty('text', '{"ok":true}');
    expect(fake.sessions[1].prompt).toHaveBeenCalledOnce();
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
  });

  it('checks both existing context and the measured constraint input before prompting', async () => {
    fake.setup((s) => { s.contextUsage = 95; s.contextWindow = 100; });
    await expect(chat(request())).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringMatching(/notes are too long/) });
    expect(fake.sessions[1].prompt).not.toHaveBeenCalled();
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
  });

  it('maps prompt overflow to a typed too-long error', async () => {
    fake.setup((s) => s.prompt.mockRejectedValue(new DOMException('Input too large', 'QuotaExceededError')));
    const error = await chat(request()).catch((e) => e as AIError);
    expect(error).toBeInstanceOf(AIError);
    expect(error).toMatchObject({ kind: 'bad_request', message: expect.stringMatching(/notes are too long.*on-device/) });
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
  });

  it('maps initial-prompt overflow and removes the rejected cached session', async () => {
    fake.api.create.mockRejectedValueOnce(new DOMException('Initial prompts too large', 'QuotaExceededError'));
    await expect(chat(request())).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringMatching(/notes are too long/) });
    await expect(chat(request())).resolves.toHaveProperty('model', 'chrome-built-in');
    expect(fake.api.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a reply even if Chrome resolves after reporting context eviction', async () => {
    fake.setup((s) => s.prompt.mockImplementation(async () => {
      s.dispatchEvent(new Event('contextoverflow'));
      return '{"ok":true}';
    }));
    await expect(chat(request())).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringMatching(/notes are too long/) });
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
  });

  it('rejects context eviction rather than accepting a reply made without all notes', async () => {
    fake.setup((s) => s.prompt.mockImplementation(async () => {
      s.dispatchEvent(new Event('contextoverflow'));
      throw new DOMException('Session destroyed', 'InvalidStateError');
    }));
    await expect(chat(request())).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringMatching(/notes are too long/) });
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
  });
});

describe('cancellation and session lifetimes', () => {
  it('does no work for an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort('cancel');
    await expect(chat(request({ signal: controller.signal }))).rejects.toMatchObject({ kind: 'aborted' });
    expect(fake.api.availability).not.toHaveBeenCalled();
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it('cancels a pending readiness check without starting a session', async () => {
    const pending = deferred<Availability>();
    fake.api.availability.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const failed = chat(request({ signal: controller.signal })).catch((e) => e as AIError);
    controller.abort();
    expect(await failed).toMatchObject({ kind: 'aborted' });
    pending.resolve('available');
    await pending.promise;
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it('destroys a clone while a context measurement is pending', async () => {
    const pending = deferred<number>();
    fake.setup((s) => s.measureContextUsage.mockReturnValue(pending.promise));
    const controller = new AbortController();
    const failed = chat(request({ signal: controller.signal })).catch((e) => e as AIError);
    await vi.waitFor(() => expect(fake.sessions[1]?.measureContextUsage).toHaveBeenCalled());
    controller.abort();
    expect(await failed).toMatchObject({ kind: 'aborted' });
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
    expect(fake.sessions[1].prompt).not.toHaveBeenCalled();
    pending.resolve(10);
  });

  it('destroys an active clone immediately even if prompt ignores cancellation', async () => {
    const pending = deferred<string>();
    fake.setup((s) => s.prompt.mockReturnValue(pending.promise));
    const controller = new AbortController();
    const failed = chat(request({ signal: controller.signal })).catch((e) => e as AIError);
    await vi.waitFor(() => expect(fake.sessions[1]?.prompt).toHaveBeenCalled());
    controller.abort(new Error('Custom cancellation reason'));
    expect(await failed).toMatchObject({ kind: 'aborted' });
    expect(fake.sessions[1].destroy).toHaveBeenCalledOnce();
    expect(fake.sessions[0].destroy).not.toHaveBeenCalled();
    pending.resolve('late reply');
  });

  it('cancels a pending base creation when its last waiter aborts and disposes the late result', async () => {
    const pending = deferred<FakeSession>();
    fake.api.create.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const failed = chat(request({ signal: controller.signal })).catch((e) => e as AIError);
    await vi.waitFor(() => expect(fake.api.create).toHaveBeenCalled());
    controller.abort();
    expect(await failed).toMatchObject({ kind: 'aborted' });
    expect(fake.api.create.mock.calls[0][0].signal?.aborted).toBe(true);
    const late = fake.session();
    pending.resolve(late);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledOnce());
    await expect(chat(request())).resolves.toHaveProperty('model', 'chrome-built-in');
    expect(fake.api.create).toHaveBeenCalledTimes(2);
  });

  it('does not cancel a shared pending base when another request still needs it', async () => {
    const pending = deferred<FakeSession>();
    fake.api.create.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const first = chat(request({ signal: controller.signal })).catch((e) => e as AIError);
    const second = chat(request());
    await vi.waitFor(() => expect(fake.api.availability).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await first).toMatchObject({ kind: 'aborted' });
    expect(fake.api.create.mock.calls[0][0].signal?.aborted).toBe(false);
    pending.resolve(fake.session());
    expect(await second).toHaveProperty('model', 'chrome-built-in');
    expect(fake.api.create).toHaveBeenCalledOnce();
  });

  it('destroys a clone that arrives after cancellation without destroying the shared base', async () => {
    const pending = deferred<FakeSession>();
    fake.setup((s) => s.clone.mockReturnValue(pending.promise));
    const controller = new AbortController();
    const failed = chat(request({ signal: controller.signal })).catch((e) => e as AIError);
    await vi.waitFor(() => expect(fake.sessions[0]?.clone).toHaveBeenCalled());
    controller.abort();
    expect(await failed).toMatchObject({ kind: 'aborted' });
    const late = fake.session();
    pending.resolve(late);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledOnce());
    expect(fake.sessions[0].destroy).not.toHaveBeenCalled();
  });

  it('maps native AbortError without requiring an external signal', async () => {
    fake.setup((s) => s.prompt.mockRejectedValue(new DOMException('Cancelled', 'AbortError')));
    await expect(chat(request())).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('evicts an expired base so the next request can recover', async () => {
    await chat(request());
    fake.sessions[0].clone.mockRejectedValueOnce(new DOMException('Session expired', 'InvalidStateError'));
    await expect(chat(request())).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(chat(request())).resolves.toHaveProperty('model', 'chrome-built-in');
    expect(fake.api.create).toHaveBeenCalledTimes(2);
  });
});

describe('device dispatch and usage', () => {
  it('bypasses endpoint parsing and fetch even with unusable remote settings', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await chatCompletion({ ...device, baseUrl: '', proxyUrl: '' }, request(), fetchImpl);
    expect(result.model).toBe('chrome-built-in');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('counts fast/deep tokens and requests at zero cost even with remote prices left over', () => {
    const tracker = new UsageTracker();
    const save = vi.fn(async (_usage: unknown) => {});
    const persisted = new UsageTracker({ load: async () => null, save });
    const ai = { ...device, inputPricePerM: 2, outputPricePerM: 10, deepInputPricePerM: 5, deepOutputPricePerM: 30 };
    for (const usage of [tracker, persisted]) {
      usage.record(ai, 1_000_000, 100_000, 'fast');
      usage.record(ai, 2_000_000, 200_000, 'deep');
      expect(usage.get()).toMatchObject({ requests: 2, promptTokens: 3_000_000, completionTokens: 300_000, costUSD: 0 });
    }
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ costUSD: 0 });
    // Local requests must not reset costs already accrued with a paid provider.
    tracker.record({ ...ai, mode: 'direct' }, 1_000_000, 0);
    tracker.record(ai, 1_000_000, 0);
    expect(tracker.get().costUSD).toBe(2);
  });

  it('routes rewrites, insights and summaries through the device adapter without network requests', async () => {
    const replies = ['{"title":null,"ops":[]}', '{"upsert":[],"remove":[]}', '{"overview":"Short notes.","sections":[{"section":"sec_1","content":"- A point."}]}'];
    fake.setup((s) => s.prompt.mockImplementation(async () => replies.shift()!));
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchImpl);
    const tracker = new UsageTracker();
    const settings = { ...DEFAULT_SETTINGS, ai: device };
    const pipelines = createPipelines(() => settings, tracker);
    const signal = new AbortController().signal;
    const messages = request().messages;
    const doc = emptyOrganizedDoc('doc');
    doc.rootSections = ['sec_1'];
    doc.sections.sec_1 = { id: 'sec_1', title: 'Notes', parentId: null, children: [], units: [], createdAt: 1, updatedAt: 1 };
    await expect(pipelines.rewrite(messages, signal)).resolves.toMatchObject({ ops: [] });
    await expect(pipelines.insights(messages, signal)).resolves.toMatchObject({ upsert: [], remove: [] });
    await expect(pipelines.summary(messages, doc, signal)).resolves.toHaveProperty('summary.overview', 'Short notes.');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.sessions[0].clone).toHaveBeenCalledTimes(3);
    expect(tracker.get()).toMatchObject({ requests: 3, costUSD: 0 });
    expect(tracker.get().promptTokens).toBeGreaterThan(0);
  });
});
