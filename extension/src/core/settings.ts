/** User-configurable settings (persisted in chrome.storage.local; the API key never syncs). */

export type RewriteIntensity = 'light' | 'balanced' | 'thorough';
export type DetailLevel = 'concise' | 'standard' | 'detailed';
/** How far the AI may go in finishing what the notes leave unfinished. */
export type Completion = 'off' | 'finish' | 'develop';
export type InsightDepth = 'off' | 'brief' | 'standard' | 'deep';
export type Frequency = 'realtime' | 'balanced' | 'saver';
export type JsonMode = 'json_schema' | 'json_object' | 'prompt_only';
/** How the organized notes are written (see NOTE_STYLE_RULES in prompts.ts). */
export type NoteStyle = 'standard' | 'outline' | 'qa' | 'cornell';
/** How the panel looks: colors and type (see index.css). */
export type Theme = 'classic' | 'paper' | 'forest' | 'contrast';

export const NOTE_STYLES: { value: NoteStyle; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard', description: 'Clear paragraphs and lists, whichever fits each point.' },
  { value: 'outline', label: 'Outline', description: 'Everything as short, nested bullet points.' },
  { value: 'qa', label: 'Q&A', description: 'Each point as a question and its answer, for testing yourself.' },
  { value: 'cornell', label: 'Cornell', description: 'Each section opens with cue questions and ends with a one-sentence summary.' },
];

export const THEMES: { value: Theme; label: string; description: string }[] = [
  { value: 'classic', label: 'Classic', description: 'Neutral grays with a blue accent.' },
  { value: 'paper', label: 'Paper', description: 'Warm, cream pages and serif note text, like a notebook.' },
  { value: 'forest', label: 'Forest', description: 'Soft greens, calm and easy on the eyes.' },
  { value: 'contrast', label: 'Contrast', description: 'High contrast: black on white, larger note text and strong outlines.' },
];

export interface AISettings {
  /** "direct": the extension calls an OpenAI-compatible endpoint with the user's own key.
   *  "proxy":  the extension calls the NotePilot server, which holds the provider key.
   *  "device": Chrome's built-in on-device model (Gemini Nano): free, no key, and nothing leaves the computer. */
  mode: 'direct' | 'proxy' | 'device';
  baseUrl: string;
  apiKey: string;
  proxyUrl: string;
  proxyToken: string;
  fastModel: string;
  deepModel: string;
  jsonMode: JsonMode;
  /** USD per 1M tokens, used for cost estimates and limits. Edit to match your provider. */
  inputPricePerM: number;
  outputPricePerM: number;
  /** USD per 1M tokens for the deep model (insights, summary) when it is priced differently; unset = the prices above. */
  deepInputPricePerM?: number;
  deepOutputPricePerM?: number;
}

export interface PrivacySettings {
  redactPII: boolean;
  storeLocally: boolean;
  perDocApproval: boolean;
  approvedDocs: string[];
  excludedDocs: string[];
}

export interface DisplaySettings {
  showOriginLabels: boolean;
  showExpansions: boolean;
  highlightUpdates: boolean;
  theme: Theme;
}

export interface Consent {
  /** Origin (scheme+host) that the user agreed may receive note content. */
  endpointOrigin: string;
  at: number;
}

/** Lecture recording (speech-to-text through the same AI endpoint). */
export interface RecordingSettings {
  /** Transcription model at the AI endpoint: gpt-4o-mini-transcribe, gpt-4o-transcribe or whisper-1 on OpenAI. */
  model: string;
  /** Language of the lecture as an ISO-639-1 code ("en", "es"); empty lets the model detect it. */
  language: string;
  /** Seconds of audio per transcription request (one transcript line each). */
  segmentSeconds: number;
  /** USD per minute of audio, for cost estimates and the daily limit. Edit to match your provider. */
  pricePerMinute: number;
  /** Where audio is transcribed. "same": the AI connection above. "custom": its own OpenAI-compatible address and key
   *  (Groq's free Whisper, a local Whisper server…), so notes and recording can use different providers. */
  endpoint: 'same' | 'custom';
  baseUrl: string;
  apiKey: string;
}

export interface Settings {
  autoProcess: boolean;
  ai: AISettings;
  rewriteIntensity: RewriteIntensity;
  detailLevel: DetailLevel;
  /** off: keep fragments as written · finish: complete cut-off sentences · develop: also write out half-developed ideas. */
  completion: Completion;
  noteStyle: NoteStyle;
  insightDepth: InsightDepth;
  subject: string;
  aiExpansion: boolean;
  frequency: Frequency;
  dailyBudgetUSD: number;
  privacy: PrivacySettings;
  display: DisplaySettings;
  consent: Consent | null;
  recording: RecordingSettings;
  /** The user agreed that recordings may be sent to this endpoint for transcription (separate from note text). */
  recordingConsent: Consent | null;
}

export const DEFAULT_SETTINGS: Settings = {
  autoProcess: true,
  ai: {
    mode: 'direct',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    proxyUrl: 'http://localhost:8787/v1',
    proxyToken: '',
    fastModel: 'gpt-5.4-mini',
    deepModel: 'gpt-5.4',
    jsonMode: 'json_object',
    inputPricePerM: 0.75,
    outputPricePerM: 4.5,
  },
  rewriteIntensity: 'balanced',
  detailLevel: 'standard',
  completion: 'develop',
  noteStyle: 'standard',
  insightDepth: 'standard',
  subject: '',
  aiExpansion: true,
  frequency: 'balanced',
  dailyBudgetUSD: 1,
  privacy: { redactPII: true, storeLocally: true, perDocApproval: false, approvedDocs: [], excludedDocs: [] },
  display: { showOriginLabels: true, showExpansions: true, highlightUpdates: true, theme: 'classic' },
  consent: null,
  recording: { model: 'gpt-4o-mini-transcribe', language: '', segmentSeconds: 20, pricePerMinute: 0.003, endpoint: 'same', baseUrl: '', apiKey: '' },
  recordingConsent: null,
};

/** What a free option gives, and what it asks in return, in plain words for the settings panel. */
export interface FreeTier {
  limits: string;
  data: string;
  /** The provider's terms require an adult account (or a guardian's consent). */
  adultsOnly: boolean;
}

/** Provider presets. Prices are USD per 1M input/output tokens for the fast (rewrite) and deep (insights, summary) models. */
export interface ProviderPreset {
  label: string;
  baseUrl: string;
  /** Empty: the user picks a model (free model lists change too often to fix one here). */
  fast: string;
  deep: string;
  jsonMode: JsonMode;
  price: { in: number; out: number };
  deepPrice?: { in: number; out: number };
  free?: FreeTier;
  /** The Frequency setting that keeps within the free limits. */
  pacing?: Frequency;
}
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', fast: 'gpt-5.4-mini', deep: 'gpt-5.4', jsonMode: 'json_object', price: { in: 0.75, out: 4.5 }, deepPrice: { in: 2.5, out: 15 } },
  // The cheapest current OpenAI model rewrites (repeated prompt text is billed at $0.01 / 1M); gpt-5.4-mini writes insights.
  { label: 'OpenAI, low cost (GPT-6 Luna)', baseUrl: 'https://api.openai.com/v1', fast: 'gpt-6-luna', deep: 'gpt-5.4-mini', jsonMode: 'json_object', price: { in: 0.1, out: 0.5 }, deepPrice: { in: 0.75, out: 4.5 } },
  // The cheapest good rewrite model: Claude Haiku 5.5 rewrites, Claude Sonnet 5.5 writes insights and summaries.
  { label: 'Anthropic, low cost (Claude Haiku 5.5)', baseUrl: 'https://api.anthropic.com/v1', fast: 'claude-haiku-5-5', deep: 'claude-sonnet-5-5', jsonMode: 'prompt_only', price: { in: 0.1, out: 0.5 }, deepPrice: { in: 2, out: 10 } },
  { label: 'Anthropic (OpenAI-compatible)', baseUrl: 'https://api.anthropic.com/v1', fast: 'claude-haiku-5-5', deep: 'claude-opus-5-5', jsonMode: 'prompt_only', price: { in: 0.1, out: 0.5 }, deepPrice: { in: 4, out: 20 } },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', fast: 'openai/gpt-5.4-mini', deep: 'openai/gpt-5.4', jsonMode: 'json_object', price: { in: 0.75, out: 4.5 }, deepPrice: { in: 2.5, out: 15 } },
  // ---- Free options (limits checked 2026-10-22; providers change them, so the panel points to each account page)
  {
    label: 'Groq (free tier)', baseUrl: 'https://api.groq.com/openai/v1', fast: 'openai/gpt-oss-20b', deep: 'openai/gpt-oss-120b', jsonMode: 'json_object',
    price: { in: 0, out: 0 }, deepPrice: { in: 0, out: 0 }, pacing: 'saver',
    free: { limits: 'About 200,000 tokens a day (roughly 40–60 notes updates) and 30 requests a minute. Your exact limits are at console.groq.com/settings/limits.', data: 'Groq does not train on what you send.', adultsOnly: true },
  },
  {
    label: 'Google Gemini (free tier)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', fast: 'gemini-3.8-flash', deep: 'gemini-3.8-flash', jsonMode: 'json_object',
    price: { in: 0, out: 0 }, deepPrice: { in: 0, out: 0 }, pacing: 'saver',
    free: { limits: 'Set per model; see yours at aistudio.google.com/rate-limit.', data: 'On the free tier Google may use what you send to improve its models, and people may review it. Don’t use it for personal or confidential notes.', adultsOnly: true },
  },
  {
    label: 'Mistral (free mode)', baseUrl: 'https://api.mistral.ai/v1', fast: 'mistral-small-latest', deep: 'mistral-medium-latest', jsonMode: 'json_object',
    price: { in: 0, out: 0 }, deepPrice: { in: 0, out: 0 }, pacing: 'saver',
    free: { limits: 'A small monthly allowance; see your Mistral console.', data: 'Mistral may train on free-mode data unless you opt out in its privacy settings.', adultsOnly: true },
  },
  {
    label: 'OpenRouter (free models)', baseUrl: 'https://openrouter.ai/api/v1', fast: '', deep: '', jsonMode: 'json_object',
    price: { in: 0, out: 0 }, deepPrice: { in: 0, out: 0 }, pacing: 'saver',
    free: { limits: '50 requests a day (1,000 after a one-time $10 credit purchase). Enter a model whose name ends in ":free" from openrouter.ai/models; they change often.', data: 'Depends on the model’s provider; OpenRouter keeps nothing unless you opt in.', adultsOnly: true },
  },
  {
    // gemma3:4b: on an 8 GB M2 it wrote ~29 tokens/s with no thinking step (qwen3.5:4b: ~22, and it thinks first by default).
    label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', fast: 'gemma3:4b', deep: 'gemma3:4b', jsonMode: 'json_object', price: { in: 0, out: 0 }, deepPrice: { in: 0, out: 0 },
    free: { limits: 'None: your computer does the work. A 3.4 GB model download (ollama pull gemma3:4b); runs on 8 GB of memory, better with 16. Run Ollama with OLLAMA_ORIGINS set to allow Chrome extensions (see docs/SETUP.md).', data: 'Nothing leaves your computer.', adultsOnly: false },
  },
];

/** Chrome's built-in model, offered as its own mode rather than an address (see AISettings.mode). */
export const ON_DEVICE: FreeTier = {
  limits: 'No limits or account. Needs Chrome on Windows, macOS 13+, Linux or a Chromebook Plus, 22 GB of free disk for a one-time model download, and a graphics chip with more than 4 GB of memory or 16 GB of RAM.',
  data: 'Nothing leaves your computer.',
  adultsOnly: false,
};
/** endpointOrigin() for the on-device mode: consent is still asked, for processing on this computer. */
export const ON_DEVICE_ORIGIN = 'on-device';

/**
 * The preset in use, matched by model and not by address alone: what its free-tier note and pacing apply to (a paid
 * account at a free preset's address, with its own models, is not on the free tier).
 */
export const presetInUse = (ai: Pick<AISettings, 'baseUrl' | 'fastModel' | 'deepModel'> & Partial<Pick<AISettings, 'inputPricePerM'>>): ProviderPreset | undefined =>
  PROVIDER_PRESETS.find((p) => p.baseUrl === ai.baseUrl && p.fast === ai.fastModel && p.deep === ai.deepModel) ??
  PROVIDER_PRESETS.find((p) => p.baseUrl === ai.baseUrl && p.fast === ai.fastModel) ??
  // The free OpenRouter preset's models are typed in: a "…:free" model, or one typed after choosing it (its $0 prices still set), stays on it.
  (ai.fastModel.endsWith(':free') || ai.inputPricePerM === 0 ? PROVIDER_PRESETS.find((p) => p.baseUrl === ai.baseUrl && p.free && !p.fast) : undefined);

/** The preset to show as chosen: the one in use, else the first at the same address. */
export const presetFor = (ai: Pick<AISettings, 'baseUrl' | 'fastModel' | 'deepModel'> & Partial<Pick<AISettings, 'inputPricePerM'>>): ProviderPreset | undefined =>
  presetInUse(ai) ?? PROVIDER_PRESETS.find((p) => p.baseUrl === ai.baseUrl);

/** A URL's origin, or '' when it isn't one. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** A key belongs to the host it was entered for: moving to another host drops it, so it is never sent there. */
export const keyForAddress = (key: string, from: string, to: string): string => {
  const was = originOf(from);
  return !was || was === originOf(to) ? key : '';
};

const EAGERNESS: Frequency[] = ['realtime', 'balanced', 'saver'];
/** The Frequency a free preset asks for, unless the user already chose a slower one. */
export const pacedFrequency = (current: Frequency, preset: ProviderPreset | undefined): Frequency =>
  preset?.pacing && EAGERNESS.indexOf(preset.pacing) > EAGERNESS.indexOf(current) ? preset.pacing : current;

/** The settings a preset sets, prices included, so the cost limit matches what the provider charges. */
export const applyPreset = (p: ProviderPreset): Partial<AISettings> => ({
  baseUrl: p.baseUrl,
  fastModel: p.fast,
  deepModel: p.deep,
  jsonMode: p.jsonMode,
  inputPricePerM: p.price.in,
  outputPricePerM: p.price.out,
  deepInputPricePerM: p.deepPrice?.in,
  deepOutputPricePerM: p.deepPrice?.out,
});

/**
 * How eagerly AI work runs, per frequency setting (cost vs freshness):
 *  - maxWait: the longest a change waits for a typing pause before it is organized anyway;
 *  - insightsQuiet / insightsGap: quiet time before insights refresh, and a multiplier on the gap between refreshes.
 */
export const AI_PACING: Record<Frequency, { maxWait: number; insightsQuiet: number; insightsGap: number }> = {
  realtime: { maxWait: 9_000, insightsQuiet: 8_000, insightsGap: 1 },
  balanced: { maxWait: 12_000, insightsQuiet: 15_000, insightsGap: 2 },
  saver: { maxWait: 30_000, insightsQuiet: 30_000, insightsGap: 4 },
};

/** Polling cadences (ms) per frequency setting: [active, recentlyActive, idle, background]. */
export const POLL_INTERVALS: Record<Frequency, [number, number, number, number]> = {
  realtime: [2000, 3000, 8000, 30000],
  balanced: [3000, 5000, 15000, 60000],
  saver: [6000, 12000, 45000, 120000],
};

export function endpointOrigin(s: AISettings): string {
  if (s.mode === 'device') return ON_DEVICE_ORIGIN;
  try {
    return new URL(s.mode === 'proxy' ? s.proxyUrl : s.baseUrl).origin;
  } catch {
    return '';
  }
}

export function isAIConfigured(s: AISettings): boolean {
  if (s.mode === 'device') return true; // whether this computer can run it is checked when it is used
  if (!endpointOrigin(s) || !s.fastModel.trim()) return false;
  if (s.mode === 'proxy') return !!s.proxyToken.trim();
  // Local servers (e.g. Ollama) usually need no key.
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(endpointOrigin(s));
  return local || !!s.apiKey.trim();
}

/** Where recordings are transcribed: the AI connection, or the separate transcription address. '' when there is none
 *  (the on-device model has no transcription). */
export function transcriptionOrigin(s: Pick<Settings, 'ai' | 'recording'>): string {
  if (s.recording.endpoint === 'custom') return originOf(s.recording.baseUrl);
  return s.ai.mode === 'device' ? '' : endpointOrigin(s.ai);
}

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai ?? {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(s.privacy ?? {}) },
    display: { ...DEFAULT_SETTINGS.display, ...(s.display ?? {}) },
    recording: { ...DEFAULT_SETTINGS.recording, ...(s.recording ?? {}) },
  };
}
