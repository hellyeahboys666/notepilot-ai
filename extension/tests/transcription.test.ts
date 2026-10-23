import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transcribe } from '../src/ai/transcribe';
import { openAudio, type RecorderOptions } from '../src/audio/recorder';
import { DEFAULT_SETTINGS, mergeSettings, transcriptionOrigin, type Settings } from '../src/core/settings';
import { TRANSCRIPTION_PRESETS, applyTranscriptionPreset, transcriptionPresetFor } from '../src/core/transcriptionPresets';
import { auth } from '../src/google/auth';
import { RecordButton, RecordStrip } from '../src/sidepanel/components/RecordControl';
import { SettingsView } from '../src/sidepanel/components/SettingsView';
import { needsRecordingConsent, useRecording, type RecordingView } from '../src/sidepanel/hooks/useRecording';
import { requestTranscriptionPermission, setRuntimeSettings, transcriptWriter, usage } from '../src/sidepanel/runtime';

// Exercise click callbacks in Node without a DOM dependency; static UI checks use the real React hooks.
const hooks = vi.hoisted(() => ({ active: false, states: [] as unknown[], index: 0, cleanups: [] as (() => void)[] }));
const recorders = vi.hoisted(() => [] as { options: RecorderOptions; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[]);
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const index = hooks.index++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next; }];
    },
    useRef: (current: unknown) => hooks.active ? { current } : react.useRef(current),
    useCallback: (fn: () => unknown, deps: unknown[]) => hooks.active ? fn : react.useCallback(fn, deps),
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
      if (!hooks.active) return react.useEffect(effect, deps);
      const cleanup = effect();
      if (cleanup) hooks.cleanups.push(cleanup);
    },
  };
});
vi.mock('../src/storage/settingsStore', async (original) => ({
  ...await original<typeof import('../src/storage/settingsStore')>(),
  usagePersistence: { load: async () => null, save: async () => undefined },
}));
vi.mock('../src/audio/recorder', async (original) => ({
  ...await original<typeof import('../src/audio/recorder')>(),
  openAudio: vi.fn(),
  SegmentRecorder: class {
    start = vi.fn();
    stop = vi.fn(async () => undefined);
    constructor(_stream: MediaStream, readonly options: RecorderOptions) {
      recorders.push(this);
    }
  },
}));

const preset = (name: string) => TRANSCRIPTION_PRESETS.find((p) => p.label.startsWith(name))!;
const service = (baseUrl = 'https://speech.example.com/v1'): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.ai.apiKey = 'note-key';
  s.ai.baseUrl = 'https://notes.example.com/v1';
  s.consent = { endpointOrigin: 'https://notes.example.com', at: 1 };
  s.recording = { ...s.recording, endpoint: 'custom', baseUrl, apiKey: 'speech-key', model: 'whisper-large-v3-turbo' };
  s.recordingConsent = { endpointOrigin: transcriptionOrigin(s), at: 2 };
  return s;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const stream = () => {
  const stop = vi.fn();
  return { media: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
};
function recording() {
  hooks.active = true;
  hooks.index = 0;
  const [, controls] = useRecording();
  hooks.active = false;
  return { controls, view: () => hooks.states[0] as RecordingView };
}
const segment = () => ({ blob: new Blob(['lecture']), seconds: 20, startedAt: Date.now(), heard: true });
const state = (): RecordingView => ({ state: null, starting: false, error: null, micBlocked: false });
let settings: Settings;
let permission: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hooks.active = false;
  hooks.states = [];
  hooks.index = 0;
  hooks.cleanups = [];
  recorders.length = 0;
  settings = service();
  setRuntimeSettings(settings);
  permission = vi.fn(async () => true);
  vi.stubGlobal('chrome', { permissions: { request: permission } });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('navigator', { language: 'en-GB' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: 'Lecture words' }))));
  vi.mocked(openAudio).mockReset().mockResolvedValue(stream().media);
  vi.spyOn(auth, 'getToken').mockResolvedValue('google-test-token');
  vi.spyOn(transcriptWriter, 'append').mockResolvedValue(undefined);
  vi.spyOn(usage, 'overBudget').mockReturnValue(false);
  vi.spyOn(usage, 'recordAudio').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const cleanup of hooks.cleanups) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('transcription presets', () => {
  it('sets independent addresses, models, keys and prices while preserving recording preferences', () => {
    for (const p of TRANSCRIPTION_PRESETS) {
      const before = { ...settings.recording, language: 'es', segmentSeconds: 30 };
      const recording = { ...before, ...applyTranscriptionPreset(p) };
      expect(recording).toMatchObject({ endpoint: 'custom', baseUrl: p.baseUrl, model: p.model, apiKey: '', pricePerMinute: p.pricePerMinute, language: 'es', segmentSeconds: 30 });
      expect(transcriptionPresetFor(recording)).toBe(p);
      expect(before.apiKey).toBe('speech-key');
    }
    expect(preset('OpenAI')).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', pricePerMinute: 0.003, needsKey: true });
    expect(preset('Groq')).toMatchObject({ baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', pricePerMinute: 0, needsKey: true, free: { adultsOnly: true } });
    expect(preset('Local')).toMatchObject({ baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-small', pricePerMinute: 0, needsKey: false, free: { adultsOnly: false } });
    expect(preset('Mistral')).toMatchObject({ model: 'voxtral-mini-latest', pricePerMinute: 0.003, needsKey: true });
  });

  it('keeps a custom model custom, recognizes trailing slashes, and never confuses same with a preset', () => {
    const groq = { ...settings.recording, ...applyTranscriptionPreset(preset('Groq')) };
    expect(transcriptionPresetFor({ ...groq, baseUrl: ` ${groq.baseUrl}/// ` })).toBe(preset('Groq'));
    expect(transcriptionPresetFor({ ...groq, model: 'my-model' })).toBeUndefined();
    expect(transcriptionPresetFor({ ...groq, endpoint: 'same' })).toBeUndefined();
  });

  it.each(['custom', 'same'] as const)('uses Mistral’s documented multipart fields with %s, omitting undocumented OpenAI fields', async (endpoint) => {
    const recording = { ...settings.recording, ...applyTranscriptionPreset(preset('Mistral')), endpoint, apiKey: 'mistral-key', language: 'fr' };
    settings.ai = { ...settings.ai, baseUrl: preset('Mistral').baseUrl, apiKey: 'mistral-key' };
    await transcribe(settings.ai, recording, new Blob(['audio']), { prompt: 'previous sentence' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/v1/audio/transcriptions');
    expect(init?.headers).toEqual({ Authorization: 'Bearer mistral-key' });
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(['file', 'model', 'language']);
    expect(form.get('model')).toBe('voxtral-mini-latest');
    expect(form.get('language')).toBe('fr');
  });

  it('migrates old recording preferences without losing their model or language', () => {
    const s = mergeSettings({ recording: { model: 'whisper-1', language: 'es' } } as never);
    expect(s.recording).toEqual({ ...DEFAULT_SETTINGS.recording, model: 'whisper-1', language: 'es' });
  });
});

describe('recording consent and host permission', () => {
  it.each(['direct', 'proxy', 'device'] as const)('custom transcription consent is independent of %s note AI', (mode) => {
    settings.ai.mode = mode;
    expect(needsRecordingConsent(settings)).toBe(false);
    settings.recordingConsent = { endpointOrigin: 'https://notes.example.com', at: 1 };
    expect(needsRecordingConsent(settings)).toBe(true);
    settings.recordingConsent = null;
    expect(needsRecordingConsent(settings)).toBe(true);
  });

  it.each(['direct', 'proxy'] as const)('same follows the %s note connection', (mode) => {
    settings.ai.mode = mode;
    settings.ai.proxyUrl = 'https://proxy.example.com/v1';
    settings.recording.endpoint = 'same';
    settings.recordingConsent = { endpointOrigin: transcriptionOrigin(settings), at: 1 };
    expect(needsRecordingConsent(settings)).toBe(false);
    settings.ai[mode === 'proxy' ? 'proxyUrl' : 'baseUrl'] = 'https://other.example.com/v1';
    expect(needsRecordingConsent(settings)).toBe(true);
  });

  it('no transcription address can never count as consent', () => {
    settings.ai.mode = 'device';
    settings.recording.endpoint = 'same';
    settings.recordingConsent = { endpointOrigin: '', at: 1 };
    expect(needsRecordingConsent(settings)).toBe(true);
    const { controls } = recording();
    controls.allow((fn) => { settings = fn(settings); });
    expect(settings.recordingConsent?.endpointOrigin).toBe(''); // no new consent is written
  });

  it('allows the transcription origin rather than the note origin', () => {
    const { controls } = recording();
    settings.recordingConsent = null;
    controls.allow((fn) => { settings = fn(settings); });
    expect(settings.recordingConsent).toEqual({ endpointOrigin: 'https://speech.example.com', at: expect.any(Number) });
  });

  it.each([
    ['https://speech.example.com:8443/v1', 'https://speech.example.com/*'],
    ['http://localhost:8000/v1', 'http://localhost/*'],
    ['http://127.0.0.1:8000/v1', 'http://127.0.0.1/*'],
  ])('requests the transcription host %s synchronously, dropping only the port in Chrome’s pattern', async (baseUrl, pattern) => {
    settings.recording.baseUrl = baseUrl;
    const result = requestTranscriptionPermission(settings);
    expect(permission).toHaveBeenCalledWith({ origins: [pattern] });
    await expect(result).resolves.toBe(true);
  });

  it.each(['direct', 'proxy'] as const)('same requests the %s AI host instead of any stale custom transcription host', async (mode) => {
    settings.ai.mode = mode;
    settings.ai.proxyUrl = 'https://proxy.example.com/v1';
    settings.recording.endpoint = 'same';
    await expect(requestTranscriptionPermission(settings)).resolves.toBe(true);
    expect(permission).toHaveBeenCalledWith({ origins: [`https://${mode === 'proxy' ? 'proxy' : 'notes'}.example.com/*`] });
  });

  it.each(['', 'not a URL', 'ftp://speech.example.com/v1', 'http://192.168.1.20:8000/v1', 'http://speech.example.com/v1'])('does not request invalid or undeclared transcription permissions for %j', async (url) => {
    settings.recording.baseUrl = url;
    await expect(requestTranscriptionPermission(settings)).resolves.toBe(false);
    expect(permission).not.toHaveBeenCalled();
  });

  it('returns false for unavailable services and rejected Chrome requests', async () => {
    settings.ai.mode = 'device';
    settings.recording.endpoint = 'same';
    await expect(requestTranscriptionPermission(settings)).resolves.toBe(false);
    expect(permission).not.toHaveBeenCalled();
    permission.mockRejectedValueOnce(new Error('denied'));
    await expect(requestTranscriptionPermission(service())).resolves.toBe(false);
  });
});

describe('recording startup', () => {
  it('rejects device+same before permission, media, auth, network or usage', () => {
    settings.ai.mode = 'device';
    settings.recording.endpoint = 'same';
    const t = recording();
    t.controls.start('mic', 'DOC');
    expect(t.view().error).toContain('Choose a transcription service in Settings → Recording');
    expect(t.view().starting).toBe(false);
    expect(permission).not.toHaveBeenCalled();
    expect(openAudio).not.toHaveBeenCalled();
    expect(auth.getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(usage.recordAudio).not.toHaveBeenCalled();
  });

  it('rejects missing consent and keys before media opens', () => {
    settings.recordingConsent = null;
    const t = recording();
    t.controls.start('tab', 'DOC');
    expect(t.view().error).toMatch(/Allow audio/);
    expect(openAudio).not.toHaveBeenCalled();
    settings.recording.apiKey = '';
    t.controls.start('mic', 'DOC');
    expect(t.view().error).toContain('Settings → Recording');
    expect(permission).not.toHaveBeenCalled();
  });

  it('requests host permission and opens tab audio from the click, then waits before recording', async () => {
    const grant = deferred<boolean>();
    permission.mockReturnValue(grant.promise);
    const t = recording();
    t.controls.start('tab', 'DOC');
    t.controls.start('mic', 'DOC'); // a second click cannot race startup
    expect(permission).toHaveBeenCalledOnce();
    expect(openAudio).toHaveBeenCalledOnce();
    expect(openAudio).toHaveBeenCalledWith('tab');
    expect(permission.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openAudio).mock.invocationCallOrder[0]);
    expect(auth.getToken).not.toHaveBeenCalled();
    expect(recorders).toHaveLength(0);
    grant.resolve(true);
    await vi.waitFor(() => expect(t.view().state?.phase).toBe('recording'));
    expect(recorders[0].start).toHaveBeenCalledOnce();
    recorders[0].options.onSegment(segment());
    await vi.waitFor(() => expect(transcriptWriter.append).toHaveBeenCalledOnce());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://speech.example.com/v1/audio/transcriptions');
    expect(usage.recordAudio).toHaveBeenCalledWith(20, settings.recording.pricePerMinute);
    expect(usage.recordAudio).toHaveBeenCalledOnce();
  });

  it.each(['early', 'late'] as const)('denied permission never records and stops an %s-resolving media stream', async (timing) => {
    const audio = deferred<MediaStream>();
    const media = stream();
    vi.mocked(openAudio).mockReturnValue(audio.promise);
    permission.mockResolvedValue(false);
    const t = recording();
    t.controls.start('mic', 'DOC');
    if (timing === 'early') audio.resolve(media.media);
    await vi.waitFor(() => expect(t.view().error).toMatch(/Chrome permission.*not granted/));
    if (timing === 'late') audio.resolve(media.media);
    await vi.waitFor(() => expect(media.stop).toHaveBeenCalled());
    expect(recorders).toHaveLength(0);
    expect(auth.getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(usage.recordAudio).not.toHaveBeenCalled();
  });

  it('supports device notes with keyless local transcription', async () => {
    settings.ai.mode = 'device';
    settings.consent = { endpointOrigin: 'on-device', at: 1 };
    settings.recording = { ...settings.recording, ...applyTranscriptionPreset(preset('Local')) };
    settings.recordingConsent = { endpointOrigin: transcriptionOrigin(settings), at: 1 };
    const t = recording();
    t.controls.start('mic', 'DOC');
    await vi.waitFor(() => expect(t.view().state?.phase).toBe('recording'));
    recorders[0].options.onSegment(segment());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(vi.mocked(fetch).mock.calls[0]).toMatchObject(['http://localhost:8000/v1/audio/transcriptions', { headers: {} }]);
    expect(permission).toHaveBeenCalledWith({ origins: ['http://localhost/*'] });
  });

  it.each(['permission', 'audio', 'auth'] as const)('rejects an origin change while waiting for %s and cleans up audio', async (stage) => {
    const grant = deferred<boolean>();
    const audio = deferred<MediaStream>();
    const google = deferred<string>();
    const media = stream();
    permission.mockReturnValue(grant.promise);
    vi.mocked(openAudio).mockReturnValue(audio.promise);
    vi.mocked(auth.getToken).mockReturnValue(google.promise);
    const t = recording();
    t.controls.start('mic', 'DOC');
    if (stage !== 'permission') {
      grant.resolve(true);
      if (stage === 'auth') {
        audio.resolve(media.media);
        await vi.waitFor(() => expect(auth.getToken).toHaveBeenCalled());
      } else await Promise.resolve();
    }
    settings = service('https://replacement.example.com/v1');
    setRuntimeSettings(settings); // even fresh consent for the replacement cannot redirect this attempt
    grant.resolve(true);
    audio.resolve(media.media);
    google.resolve('google-token');
    await vi.waitFor(() => expect(t.view().error).toMatch(/service or recording consent changed/));
    expect(media.stop).toHaveBeenCalled();
    expect(recorders).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['change host', 'withdraw consent'] as const)('stops queued segments after %s instead of sending to an unapproved host', async (change) => {
    const t = recording();
    t.controls.start('mic', 'DOC');
    await vi.waitFor(() => expect(t.view().state?.phase).toBe('recording'));
    if (change === 'change host') settings = service('https://replacement.example.com/v1');
    else settings = { ...settings, recordingConsent: null };
    setRuntimeSettings(settings);
    recorders[0].options.onSegment(segment());
    recorders[0].options.onSegment(segment());
    await vi.waitFor(() => expect(recorders[0].stop).toHaveBeenCalled());
    expect(fetch).not.toHaveBeenCalled();
    expect(transcriptWriter.append).not.toHaveBeenCalled();
    expect(usage.recordAudio).not.toHaveBeenCalled();
  });

  it.each(['permission', 'audio', 'auth'] as const)('stop cancels startup while waiting for %s and stops late audio', async (stage) => {
    const grant = deferred<boolean>();
    const audio = deferred<MediaStream>();
    const google = deferred<string>();
    const media = stream();
    permission.mockReturnValue(grant.promise);
    vi.mocked(openAudio).mockReturnValue(audio.promise);
    vi.mocked(auth.getToken).mockReturnValue(google.promise);
    const t = recording();
    t.controls.start('mic', 'DOC');
    if (stage !== 'permission') {
      grant.resolve(true);
      if (stage === 'auth') {
        audio.resolve(media.media);
        await vi.waitFor(() => expect(auth.getToken).toHaveBeenCalled());
      } else await Promise.resolve();
    }
    t.controls.stop();
    expect(t.view().starting).toBe(false);
    grant.resolve(true);
    audio.resolve(media.media);
    google.resolve('google-token');
    await vi.waitFor(() => expect(media.stop).toHaveBeenCalled());
    expect(recorders).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(usage.recordAudio).not.toHaveBeenCalled();
  });

  it('dismissing startup cancels it, and a late denial cannot replace a new recording', async () => {
    const grant = deferred<boolean>();
    permission.mockReturnValueOnce(grant.promise).mockResolvedValue(true);
    const t = recording();
    t.controls.start('mic', 'DOC');
    t.controls.dismiss();
    t.controls.start('tab', 'DOC');
    await vi.waitFor(() => expect(t.view().state?.phase).toBe('recording'));
    grant.resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(recorders).toHaveLength(1);
    expect(t.view()).toMatchObject({ starting: false, error: null, state: { source: 'tab', phase: 'recording' } });
  });

  it('stops a late media result when the panel closes during startup', async () => {
    const audio = deferred<MediaStream>();
    const media = stream();
    vi.mocked(openAudio).mockReturnValue(audio.promise);
    const t = recording();
    t.controls.start('mic', 'DOC');
    hooks.cleanups[0]();
    audio.resolve(media.media);
    await vi.waitFor(() => expect(media.stop).toHaveBeenCalled());
    expect(recorders).toHaveLength(0);
  });
});

describe('recording settings and consent text', () => {
  const controls = () => recording().controls;
  const strip = (s: Settings) => renderToStaticMarkup(createElement(RecordStrip, { settings: s, rec: state(), controls: controls(), asking: 'mic', onAllow: vi.fn(), onCancel: vi.fn() }));
  const panel = (s: Settings) => renderToStaticMarkup(createElement(SettingsView, { settings: s, update: vi.fn(), view: null, docId: null, onRebuild: vi.fn() }));
  const serviceSelect = () => {
    let select: ReactElement<{ onChange: (e: { target: { value: string } }) => void }> | undefined;
    const visit = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!isValidElement<{ children?: ReactNode; id?: string }>(node)) return;
      if (node.props.id === 'np-rec-service') select = node as typeof select;
      visit(node.props.children);
    };
    hooks.active = true;
    hooks.index = 0;
    const tree = SettingsView({ settings, update: (fn) => { settings = fn(settings); setRuntimeSettings(settings); }, view: null, docId: null, onRebuild: vi.fn() });
    hooks.active = false;
    visit(tree);
    expect(select).toBeDefined();
    return (value: string) => select!.props.onChange({ target: { value } });
  };

  it('restores same-connection model and price after choosing another provider', () => {
    settings.recording = { ...settings.recording, endpoint: 'same', model: 'whisper-1', pricePerMinute: 0.006, language: 'es', segmentSeconds: 30 };
    const select = serviceSelect();
    select(preset('Groq').label);
    expect(settings.recording).toMatchObject({ endpoint: 'custom', model: 'whisper-large-v3-turbo', pricePerMinute: 0 });
    select('same');
    expect(settings.recording).toMatchObject({ endpoint: 'same', model: 'whisper-1', pricePerMinute: 0.006, language: 'es', segmentSeconds: 30 });
  });

  it.each(['OpenAI', 'Groq', 'Local'])('initializes same-connection transcription for %s instead of retaining a custom provider’s model and price', (name) => {
    settings.ai.baseUrl = preset(name).baseUrl;
    settings.recording = { ...settings.recording, ...applyTranscriptionPreset(preset('Mistral')) };
    serviceSelect()('same');
    expect(settings.recording).toMatchObject({ endpoint: 'same', model: preset(name).model, pricePerMinute: preset(name).pricePerMinute });
  });

  it('offers a clickable cancel button while recording startup is pending', () => {
    const button = renderToStaticMarkup(createElement(RecordButton, { rec: { ...state(), starting: true }, controls: controls(), onChoose: vi.fn() }));
    expect(button).toContain('Cancel');
    expect(button).not.toContain('disabled=""');
  });

  it('names the speech origin rather than the note AI and offers no recording with device+same', () => {
    const text = strip(settings);
    expect(text).toContain('https://speech.example.com');
    expect(text).not.toContain('https://notes.example.com');
    settings.ai.mode = 'device';
    settings.recording.endpoint = 'same';
    const unavailable = strip(settings);
    expect(unavailable).toContain('Settings → Recording');
    expect(unavailable).not.toContain('Allow and record');
  });

  it('shows each preset, separate credentials, Groq limits/data/age, and local server setup', () => {
    settings.recording = { ...settings.recording, ...applyTranscriptionPreset(preset('Groq')) };
    const groq = panel(settings);
    for (const p of TRANSCRIPTION_PRESETS) expect(groq).toContain(p.label);
    expect(groq).toContain('Same as AI connection');
    expect(groq).toContain('Custom (OpenAI-compatible)');
    expect(groq).toContain('Transcription address');
    expect(groq).toContain('Transcription API key');
    for (const limit of ['20 requests', '2,000', '7,200', '28,800', '18 or older', 'NotePilot server', 'does not train']) expect(groq).toContain(limit);
    settings.recording = { ...settings.recording, ...applyTranscriptionPreset(preset('Local')) };
    const local = panel(settings);
    expect(local).toContain('Systran/faster-whisper-small');
    expect(local).toContain('Run a Speaches server');
    expect(local).not.toContain('18 or older');
  });

  it('distinguishes stale consent from permission for the current service', () => {
    settings.recordingConsent = { endpointOrigin: 'https://old.example.com', at: 1 };
    expect(panel(settings)).toContain('Recording permission needs renewal');
  });

  it('a rendered agreement cannot consent to a newly changed speech origin', () => {
    const onAllow = vi.fn();
    const onCancel = vi.fn();
    const recControls = controls();
    hooks.active = true;
    const tree = RecordStrip({ settings, rec: state(), controls: recControls, asking: 'mic', onAllow, onCancel });
    hooks.active = false;
    const buttons: ReactElement<{ children?: ReactNode; onClick?: () => void }>[] = [];
    const visit = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
      if (node.type === 'button') buttons.push(node);
      visit(node.props.children);
    };
    visit(tree);
    settings = service('https://replacement.example.com/v1');
    setRuntimeSettings(settings);
    buttons[0].props.onClick?.();
    expect(onAllow).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
