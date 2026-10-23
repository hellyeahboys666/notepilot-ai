import { useCallback, useEffect, useRef, useState } from 'react';
import { chatCompletion } from '../../ai/client';
import { availability, download, type Availability } from '../../ai/onDevice';
import { ON_DEVICE, PROVIDER_PRESETS, applyPreset, endpointOrigin, isAIConfigured, keyForAddress, pacedFrequency, presetFor, presetInUse, type AISettings, type Settings } from '../../core/settings';
import { sameTranscriptionDefaults } from '../../core/transcriptionPresets';
import { requestEndpointPermission } from '../runtime';
import { FreeTierNote } from './FreeTierNote';
import { Button, Segmented, cx } from './ui';

export const inputCls =
  'np-focus h-8 w-full rounded-md border border-ink-200 bg-white px-2.5 text-[12.5px] text-ink-900 placeholder:text-ink-300 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100 dark:placeholder:text-ink-600';

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-[11.5px] font-medium text-ink-600 dark:text-ink-300">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-ink-400">{hint}</p>}
    </div>
  );
}

/**
 * What a successful Connect & test saves: the connection; for a rate-limited free tier, its slower pacing (never a
 * faster one); and recording "same as the AI connection" moved to the new service's own transcription model and price.
 */
export function connectedSettings(s: Settings, ai: AISettings): Settings {
  return {
    ...s,
    ai,
    frequency: ai.mode === 'direct' ? pacedFrequency(s.frequency, presetInUse(ai)) : s.frequency,
    recording: s.recording.endpoint === 'same' && endpointOrigin(s.ai) !== endpointOrigin(ai) ? { ...s.recording, ...sameTranscriptionDefaults(ai) } : s.recording,
  };
}

/** Configures local AI or an OpenAI-compatible endpoint. Testing uses a tiny probe — never note content. */
export function AIConnectionForm({ settings, update, compact }: { settings: Settings; update: (fn: (s: Settings) => Settings) => void; compact?: boolean }) {
  const [draft, setDraft] = useState<AISettings>(settings.ai);
  const [state, setState] = useState<{ kind: 'idle' | 'testing' | 'ok' | 'error'; msg?: string }>({ kind: 'idle' });
  const [model, setModel] = useState<{ availability: Availability | 'checking'; reason?: string }>({ availability: 'checking' });
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [readinessCheck, setReadinessCheck] = useState(0);
  const [stalled, setStalled] = useState(false);
  const connectionController = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const availabilityVersion = useRef(0);
  const draftRef = useRef(draft);
  const savedAI = useRef(settings.ai);
  const onDevice = draft.mode === 'device';

  const replaceDraft = useCallback((next: AISettings) => {
    const current = draftRef.current;
    const fields = Object.keys({ ...current, ...next }) as (keyof AISettings)[];
    if (fields.every((key) => Object.is(current[key], next[key]))) return;
    connectionController.current?.abort();
    connectionController.current = null;
    if (next.mode !== current.mode) {
      availabilityVersion.current++;
      downloadController.current?.abort();
      downloadController.current = null;
      setDownloadProgress(null);
      setModel({ availability: 'checking' });
    }
    draftRef.current = next;
    setDraft(next);
    setState({ kind: 'idle' });
  }, []);

  useEffect(() => {
    // Other Settings controls (and storage events) also replace settings.ai. Merge
    // changed, unedited fields without discarding an unsaved connection draft.
    const previous = savedAI.current;
    savedAI.current = settings.ai;
    const fields = Object.keys({ ...previous, ...settings.ai }) as (keyof AISettings)[];
    // Prices are edited outside this form; an explicit edit there wins over a preset.
    const prices: (keyof AISettings)[] = ['inputPricePerM', 'outputPricePerM', 'deepInputPricePerM', 'deepOutputPricePerM'];
    const changed = fields.filter((key) => !Object.is(previous[key], settings.ai[key]) && (prices.includes(key) || Object.is(draftRef.current[key], previous[key])));
    if (changed.length) {
      replaceDraft({ ...draftRef.current, ...Object.fromEntries(changed.map((key) => [key, settings.ai[key]])) });
    }
  }, [settings.ai, replaceDraft]);

  useEffect(() => () => {
    availabilityVersion.current++;
    connectionController.current?.abort();
    connectionController.current = null;
    downloadController.current?.abort();
    downloadController.current = null;
  }, []);

  // Chrome downloads the model itself and can say "downloading" for good without starting (most often: too little
  // free disk). After a while at 0, say what to check instead of showing a bar that never moves.
  const noProgress = model.availability === 'downloading' && !downloadProgress;
  useEffect(() => {
    setStalled(false);
    if (!noProgress) return;
    const timer = setTimeout(() => setStalled(true), 15_000);
    return () => clearTimeout(timer);
  }, [noProgress]);

  useEffect(() => {
    if (draft.mode !== 'device') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!downloadController.current) setModel({ availability: 'checking' });
    const check = async () => {
      if (!active || draftRef.current.mode !== 'device') return;
      if (downloadController.current || connectionController.current) {
        timer = setTimeout(() => void check(), 3000);
        return;
      }
      const version = ++availabilityVersion.current;
      const current = () => active && draftRef.current.mode === 'device' && version === availabilityVersion.current && !downloadController.current;
      try {
        const status = await availability();
        if (current()) setModel({ availability: status });
      } catch (e) {
        if (current()) {
          setModel({ availability: 'unavailable', reason: `Could not check the local model: ${e instanceof Error ? e.message : String(e)}` });
        }
      } finally {
        if (active) timer = setTimeout(() => void check(), 3000);
      }
    };
    void check();
    return () => {
      active = false;
      availabilityVersion.current++;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [draft.mode, readinessCheck]);

  const set = (patch: Partial<AISettings>) => replaceDraft({ ...draftRef.current, ...patch });

  const downloadModel = async () => {
    if (draftRef.current.mode !== 'device' || downloadController.current) return;
    connectionController.current?.abort();
    connectionController.current = null;
    const controller = new AbortController();
    downloadController.current = controller;
    const current = () => downloadController.current === controller && !controller.signal.aborted && draftRef.current.mode === 'device';
    availabilityVersion.current++;
    setState({ kind: 'idle' });
    setModel({ availability: 'downloading' });
    setDownloadProgress(0);
    try {
      // Invoke the adapter in this click, before any awaited readiness check.
      // Its LanguageModel.create call needs the original user activation.
      await download((fraction) => {
        if (current() && Number.isFinite(fraction)) {
          setDownloadProgress((previous) => Math.max(previous ?? 0, Math.max(0, Math.min(1, fraction))));
        }
      }, controller.signal);
    } catch (e) {
      if (current()) setState({ kind: 'error', msg: `Model download failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (current()) {
        downloadController.current = null;
        setDownloadProgress(null);
        setReadinessCheck((n) => n + 1);
      }
    }
  };

  const cancelDownload = () => {
    downloadController.current?.abort();
    downloadController.current = null;
    availabilityVersion.current++;
    setDownloadProgress(null);
    setState({ kind: 'idle' });
    setReadinessCheck((n) => n + 1);
  };

  const connect = async () => {
    if (connectionController.current || downloadController.current) return;
    const connection = draftRef.current;
    if (!isAIConfigured(connection)) return;
    const local = connection.mode === 'device';
    const controller = new AbortController();
    connectionController.current = controller;
    const current = () => connectionController.current === controller && !controller.signal.aborted && draftRef.current === connection;
    setState({ kind: 'testing' });
    try {
      if (local) {
        const version = ++availabilityVersion.current;
        const status = await availability();
        if (!current()) return;
        if (version === availabilityVersion.current) setModel({ availability: status });
        if (status !== 'available') {
          setState({ kind: 'error', msg: 'The local model is not ready. Check readiness or download it first.' });
          return;
        }
      } else {
        // Request remote host permission from this click; never request it for local AI.
        const granted = await requestEndpointPermission({ ...settings, ai: connection });
        if (!current()) return;
        if (!granted) {
          setState({ kind: 'error', msg: `Chrome permission to contact ${endpointOrigin(connection)} was not granted.` });
          return;
        }
      }
      const r = await chatCompletion(connection, {
        model: local ? 'on-device' : connection.fastModel,
        messages: [{ role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok": true}' }],
        maxTokens: 20,
        jsonMode: 'prompt_only',
        signal: controller.signal,
      });
      if (!current()) return;
      setState({ kind: 'ok', msg: `Connected · ${r.model} · ${r.latencyMs} ms` });
      // Match the existing Settings flow: only a successful test saves the draft.
      // Keep remote endpoint/key/model fields so switching back does not erase them.
      update((s) => connectedSettings(s, connection));
    } catch (e) {
      if (current()) setState({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    } finally {
      if (connectionController.current === controller) connectionController.current = null;
    }
  };

  const configured = isAIConfigured(draft);
  const preset = draft.mode === 'direct' ? presetFor(draft) : undefined;
  const inUse = draft.mode === 'direct' ? presetInUse(draft) : undefined;
  const modelStatus = model.reason ?? {
    checking: 'Checking local model availability…',
    unavailable: 'Chrome’s built-in AI is not supported or enabled on this computer. Check the requirements above, or use a free provider preset below.',
    downloadable: 'The local model needs a one-time download.',
    downloading: 'Chrome is downloading the local model…',
    available: 'Local model ready on this computer.',
  }[model.availability];
  return (
    <div className="space-y-3">
      <Segmented
        label="Connection type"
        size={compact ? 'sm' : 'md'}
        value={draft.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { value: 'direct', label: 'My API key' },
          { value: 'proxy', label: 'NotePilot server' },
          { value: 'device', label: 'On this computer (free)' },
        ]}
      />
      {onDevice ? (
        <>
          <Field label="AI endpoint" htmlFor="np-device-endpoint">
            <input id="np-device-endpoint" className={cx(inputCls, 'opacity-60')} value="On this computer · no endpoint or API key" disabled />
          </Field>
          <FreeTierNote free={ON_DEVICE} />
          <div className="space-y-2 rounded-md bg-ink-50 px-3 py-2 text-[11.5px] leading-relaxed text-ink-600 dark:bg-ink-800/50 dark:text-ink-300">
            <p role="status" aria-live="polite" className={cx(model.availability === 'available' && 'text-emerald-600 dark:text-emerald-400')}>{modelStatus}</p>
            {model.availability === 'downloading' && downloadProgress !== null && (
              <div className="space-y-1">
                <progress aria-label="Local model download" max={1} value={downloadProgress ?? undefined} className="h-1.5 w-full accent-emerald-500" />
                {downloadProgress !== null && <p>{Math.round(downloadProgress * 100)}% downloaded</p>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {(model.availability === 'downloadable' || model.availability === 'downloading') && (
                <Button size="sm" onClick={() => void downloadModel()} disabled={downloadProgress !== null || state.kind === 'testing'}>
                  {model.availability === 'downloading' && downloadProgress === null ? 'Show progress' : 'Download the model'}
                </Button>
              )}
              {downloadProgress !== null && <Button size="sm" variant="ghost" onClick={cancelDownload}>Cancel</Button>}
              <Button size="sm" onClick={() => setReadinessCheck((n) => n + 1)} disabled={model.availability === 'checking' || downloadProgress !== null || state.kind === 'testing'}>Check readiness</Button>
            </div>
            {stalled && (
              <p role="alert" className="rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-900 ring-1 ring-amber-200/70 dark:bg-amber-400/10 dark:text-amber-100 dark:ring-amber-400/20">
                Chrome hasn’t started the download. It fetches the model itself (a few GB), and only when the drive that holds your Chrome profile has at least 22 GB free and the connection isn’t
                metered; it removes the model again if free space later drops below 10 GB. Free up space, restart Chrome, and see{' '}
                <code className="font-mono text-[11px]">chrome://on-device-internals</code> for Chrome’s reason.
              </p>
            )}
            <p>Other free options: choose My API key → Provider for Groq, Gemini, Mistral, OpenRouter (free models), or Ollama (local). Check each preset’s limits and data terms.</p>
            <Button size="sm" variant="ghost" onClick={() => set({ mode: 'direct' })}>See free provider presets</Button>
          </div>
        </>
      ) : draft.mode === 'direct' ? (
        <>
          <Field label="Provider" htmlFor="np-provider">
            <select
              id="np-provider"
              className={inputCls}
              value={preset?.label ?? 'custom'}
              onChange={(e) => {
                const p = PROVIDER_PRESETS.find((x) => x.label === e.target.value);
                if (p) set({ ...applyPreset(p), apiKey: keyForAddress(draftRef.current.apiKey, draftRef.current.baseUrl, p.baseUrl) });
              }}
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.label}>{p.label}</option>
              ))}
              <option value="custom">Custom (OpenAI-compatible)</option>
            </select>
          </Field>
          {inUse?.free && <FreeTierNote free={inUse.free} savesFrequency={pacedFrequency(settings.frequency, inUse) !== settings.frequency} />}
          <Field label="Base URL" htmlFor="np-base">
            <input id="np-base" className={inputCls} value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value.trim(), apiKey: keyForAddress(draftRef.current.apiKey, draftRef.current.baseUrl, e.target.value.trim()) })} spellCheck={false} />
          </Field>
          <Field label="API key" hint="Stored only in this browser profile (never synced). Only sent to the base URL above." htmlFor="np-key">
            <input id="np-key" type="password" autoComplete="off" className={inputCls} value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value.trim() })} placeholder="sk-…" />
          </Field>
        </>
      ) : (
        <>
          <Field label="Server URL" hint="Your deployment of the NotePilot server (see README). It holds the provider key." htmlFor="np-proxy">
            <input id="np-proxy" className={inputCls} value={draft.proxyUrl} onChange={(e) => set({ proxyUrl: e.target.value.trim() })} spellCheck={false} />
          </Field>
          <Field label="Access token" htmlFor="np-token">
            <input id="np-token" type="password" autoComplete="off" className={inputCls} value={draft.proxyToken} onChange={(e) => set({ proxyToken: e.target.value.trim() })} />
          </Field>
        </>
      )}
      <div className={cx('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-2')}>
        <Field label="Fast model (rewriting)" htmlFor="np-fast">
          <input id="np-fast" className={cx(inputCls, onDevice && 'opacity-60')} value={onDevice ? 'Chrome built-in model' : draft.fastModel} disabled={onDevice} onChange={(e) => set({ fastModel: e.target.value.trim() })} spellCheck={false} />
        </Field>
        <Field label="Deep model (insights)" htmlFor="np-deep">
          <input id="np-deep" className={cx(inputCls, onDevice && 'opacity-60')} value={onDevice ? 'Chrome built-in model' : draft.deepModel} disabled={onDevice} onChange={(e) => set({ deepModel: e.target.value.trim() })} spellCheck={false} />
        </Field>
      </div>
      {!compact && !onDevice && (
        <Field label="Structured output" hint="Use JSON schema if your provider supports strict structured outputs; plain prompting works everywhere.">
          <select className={inputCls} value={draft.jsonMode} onChange={(e) => set({ jsonMode: e.target.value as AISettings['jsonMode'] })}>
            <option value="json_object">JSON mode (response_format: json_object)</option>
            <option value="json_schema">Strict JSON schema</option>
            <option value="prompt_only">Prompt only</option>
          </select>
        </Field>
      )}
      <p className="text-[11px] leading-snug text-ink-400">Connect &amp; test saves this connection. The test uses a small sample, never your notes.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void connect()} disabled={!configured || state.kind === 'testing' || (onDevice && (model.availability !== 'available' || downloadProgress !== null))}>
          {state.kind === 'testing' ? 'Testing…' : 'Connect & test'}
        </Button>
        {state.kind === 'ok' && <span role="status" className="text-[11.5px] text-emerald-600 dark:text-emerald-400">{state.msg}</span>}
      </div>
      {state.kind === 'error' && <p role="alert" className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11.5px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{state.msg}</p>}
    </div>
  );
}
