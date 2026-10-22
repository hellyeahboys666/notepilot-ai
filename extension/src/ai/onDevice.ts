import { AIError, type AIRequest, type AIResult } from './client';

export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

// Only the text API used here. Chrome exposes this in extension pages, not service workers.
interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
type PromptInput = string | LanguageModelMessage[];
interface PromptOptions {
  responseConstraint?: object;
  signal?: AbortSignal;
}
interface ModelOptions {
  expectedInputs: { type: 'text'; languages: string[] }[];
  expectedOutputs: { type: 'text'; languages: string[] }[];
}
interface CreateOptions extends ModelOptions {
  initialPrompts?: LanguageModelMessage[];
  monitor?: (monitor: EventTarget) => void;
  signal?: AbortSignal;
}
interface LanguageModelSession extends EventTarget {
  readonly contextUsage: number;
  readonly contextWindow: number;
  measureContextUsage(input: PromptInput, options?: PromptOptions): Promise<number>;
  prompt(input: PromptInput, options?: PromptOptions): Promise<string>;
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}
interface LanguageModelAPI {
  availability(options: ModelOptions): Promise<Availability>;
  create(options: CreateOptions): Promise<LanguageModelSession>;
}

// The instructions and JSON field names are English. Use the same options for readiness and creation.
const modelOptions: ModelOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const modelAPI = () => (globalThis as typeof globalThis & { LanguageModel?: LanguageModelAPI }).LanguageModel;
const cancelled = () => new AIError('aborted', 'Request cancelled');
const tooLong = () => new AIError('bad_request', 'These notes are too long for the on-device model. Try shorter notes or a cloud provider.');
const unavailable = () => new AIError('bad_request', 'Chrome’s built-in AI is unavailable in this browser or on this computer. Check Settings → AI model for requirements or choose a free provider preset.');

function destroy(session: LanguageModelSession): void {
  try {
    session.destroy();
  } catch {
    // A cancelled or expired session may already be gone.
  }
}

function mapError(error: unknown, signal?: AbortSignal): AIError {
  if (signal?.aborted) return cancelled();
  if (error instanceof AIError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return cancelled();
  if (name === 'QuotaExceededError') return tooLong();
  const message = error instanceof Error ? error.message : String(error);
  if (['NotSupportedError', 'NotAllowedError', 'InvalidStateError'].includes(name)) {
    return new AIError('bad_request', `The on-device model could not start: ${message}. Check readiness in Settings → AI model; you may need to update Chrome or download the model from a click.`);
  }
  return new AIError('server', `The on-device model failed: ${message}`);
}

// Cancellation must settle even while Chrome is still creating a session. Clean up late arrivals too.
function waitFor<T>(pending: Promise<T>, signal?: AbortSignal, discard?: (value: T) => void): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let aborted = signal.aborted;
    const abort = () => {
      aborted = true;
      reject(cancelled());
    };
    if (aborted) reject(cancelled());
    else signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => {
      signal.removeEventListener('abort', abort);
      if (aborted) discard?.(value);
      else resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export async function availability(): Promise<Availability> {
  const api = modelAPI();
  if (!api) return 'unavailable';
  const status = await api.availability(modelOptions);
  return ['unavailable', 'downloadable', 'downloading', 'available'].includes(status) ? status : 'unavailable';
}

/** Call directly from the download button, before any await, to keep Chrome's user activation. */
export async function download(onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  let session: LanguageModelSession | undefined;
  try {
    if (signal?.aborted) throw cancelled();
    const api = modelAPI();
    if (!api) throw unavailable();
    const pending = api.create({
      ...modelOptions,
      signal,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          // Chrome reports a fraction, not downloaded bytes (total is always 1).
          const { loaded } = event as ProgressEvent;
          if (!signal?.aborted && Number.isFinite(loaded)) onProgress?.(Math.max(0, Math.min(1, loaded)));
        });
      },
    });
    session = await waitFor(pending, signal, destroy);
    if (signal?.aborted) throw cancelled();
    // A progress event at 100% may precede extraction/loading. create() means it is ready.
    onProgress?.(1);
  } catch (error) {
    throw mapError(error, signal);
  } finally {
    if (session) destroy(session);
  }
}

interface BaseSession {
  controller: AbortController;
  ready: Promise<LanguageModelSession>;
  session?: LanguageModelSession;
  users: number;
}
const bases = new Map<string, BaseSession>();
let cachedAPI: LanguageModelAPI | undefined;

function removeBase(key: string, entry: BaseSession): void {
  if (bases.get(key) !== entry) return;
  bases.delete(key);
  entry.controller.abort();
  if (entry.session) destroy(entry.session);
}

function pruneBases(): void {
  // Keep only a few instruction-only sessions; never cache a note or a generated reply.
  for (const [key, entry] of bases) {
    if (bases.size <= 3) break;
    if (entry.users === 0) removeBase(key, entry);
  }
}

function baseFor(api: LanguageModelAPI, system: string): BaseSession {
  if (cachedAPI !== api) {
    for (const [key, entry] of bases) removeBase(key, entry);
    cachedAPI = api;
  }
  const cached = bases.get(system);
  if (cached) {
    bases.delete(system);
    bases.set(system, cached);
    return cached;
  }
  const controller = new AbortController();
  const entry: BaseSession = {
    controller,
    users: 0,
    ready: api.create({
      ...modelOptions,
      initialPrompts: system ? [{ role: 'system', content: system }] : [],
      // A request must not own the lifetime of a shared base session.
      signal: controller.signal,
    }).then((session) => {
      if (controller.signal.aborted) {
        destroy(session);
        throw cancelled();
      }
      entry.session = session;
      return session;
    }).catch((error: unknown) => {
      removeBase(system, entry);
      throw error;
    }),
  };
  bases.set(system, entry);
  return entry;
}

/** A fresh clone gets the notes; the shared base only contains the system instructions. */
export async function chat(req: AIRequest): Promise<AIResult> {
  const t0 = performance.now();
  let session: LanguageModelSession | undefined;
  let disposed = false;
  let overflow = false;
  const dispose = () => {
    if (session && !disposed) {
      disposed = true;
      destroy(session);
    }
  };
  const onOverflow = () => {
    overflow = true;
    dispose();
  };
  try {
    if (req.signal?.aborted) throw cancelled();
    const api = modelAPI();
    if (!api) throw unavailable();
    const status = await waitFor(api.availability(modelOptions), req.signal);
    if (status === 'downloadable') throw new AIError('bad_request', 'Download the model in Settings → AI model → On this computer (free) before using on-device AI.');
    if (status === 'downloading') throw new AIError('bad_request', 'The on-device model is still downloading. Wait for it to finish in Settings → AI model.');
    if (status !== 'available') throw unavailable();

    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = req.messages.filter((m) => m.role !== 'system');
    // Preserve assistant/user turns when the validation pipeline retries with feedback.
    const input: PromptInput = messages.length === 1 && messages[0].role === 'user' ? messages[0].content : messages;
    const entry = baseFor(api, system);
    entry.users++;
    try {
      const base = await waitFor(entry.ready, req.signal);
      session = await waitFor(base.clone({ signal: req.signal }), req.signal, destroy);
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidStateError') removeBase(system, entry);
      throw error;
    } finally {
      entry.users--;
      if (!entry.session && entry.users === 0) removeBase(system, entry);
      pruneBases();
    }
    if (req.signal?.aborted) throw cancelled();
    req.signal?.addEventListener('abort', dispose, { once: true });
    session.addEventListener('contextoverflow', onOverflow);
    const options: PromptOptions = { signal: req.signal };
    if (req.jsonSchema) options.responseConstraint = req.jsonSchema.schema;
    else if (req.jsonMode !== 'prompt_only') options.responseConstraint = { type: 'object' };
    // Chrome controls the model and output ceiling; there is no maxTokens option.
    // Older extension builds lack these newer context helpers, but still report QuotaExceededError.
    // Measurement is advisory; runtime quota errors and overflow events still guard the limit.
    const run = async (s: LanguageModelSession, opts: PromptOptions) => {
      if (typeof s.measureContextUsage === 'function') {
        const needed = await waitFor(s.measureContextUsage(input, opts), req.signal);
        if (s.contextUsage + needed > s.contextWindow) throw tooLong();
      }
      return waitFor(s.prompt(input, opts), req.signal);
    };
    let text: string;
    try {
      text = await run(session, options);
    } catch (error) {
      // A schema Chrome can't compile: ask for any JSON object instead; the patch is validated either way.
      if (!req.jsonSchema || !(error instanceof Error) || error.name !== 'NotSupportedError' || req.signal?.aborted || overflow) throw error;
      text = await run(session, { ...options, responseConstraint: { type: 'object' } });
    }
    if (req.signal?.aborted) throw cancelled();
    if (overflow) throw tooLong();
    if (!text) throw new AIError('invalid_output', 'Empty on-device model response');
    return {
      text,
      // The Prompt API has no per-response billing counts. Keep the same estimate as remote fallbacks.
      promptTokens: Math.ceil(JSON.stringify(req.messages).length / 4),
      completionTokens: Math.ceil(text.length / 4),
      latencyMs: Math.round(performance.now() - t0),
      model: 'chrome-built-in',
    };
  } catch (error) {
    if (req.signal?.aborted) throw cancelled();
    if (overflow) throw tooLong();
    throw mapError(error, req.signal);
  } finally {
    req.signal?.removeEventListener('abort', dispose);
    session?.removeEventListener('contextoverflow', onOverflow);
    dispose();
  }
}
