import { DEFAULT_SETTINGS, type AISettings, type FreeTier, type RecordingSettings } from './settings';

/** Speech-to-text services, independent of the model that organizes the notes. Prices are USD per audio minute. */
export interface TranscriptionPreset {
  label: string;
  baseUrl: string;
  model: string;
  pricePerMinute: number;
  needsKey: boolean;
  free?: FreeTier;
}

// Checked 2026-10-22 against the providers' speech-to-text docs and pricing pages.
export const TRANSCRIPTION_PRESETS: TranscriptionPreset[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', pricePerMinute: 0.003, needsKey: true },
  {
    label: 'Groq (free tier)', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', pricePerMinute: 0, needsKey: true,
    free: {
      limits: '20 requests a minute, 2,000 a day; 7,200 audio seconds an hour and 28,800 a day (about 8 hours). Limits apply to your organization; see console.groq.com/settings/limits for yours.',
      data: 'Groq does not train on what you send unless you explicitly allow it.',
      adultsOnly: true,
    },
  },
  {
    label: 'Local Whisper (free, private)', baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-small', pricePerMinute: 0, needsKey: false,
    free: {
      limits: 'No provider quota: your computer does the work. Run a Speaches server on port 8000 and download Systran/faster-whisper-small first; see speaches.ai/usage/speech-to-text/.',
      data: 'Audio stays on your computer when the server runs locally.',
      adultsOnly: false,
    },
  },
  // Mistral's docs use the alias for /audio/transcriptions (Voxtral Mini Transcribe 2, $0.003 a minute).
  { label: 'Mistral (Voxtral Mini)', baseUrl: 'https://api.mistral.ai/v1', model: 'voxtral-mini-latest', pricePerMinute: 0.003, needsKey: true },
];

const base = (url: string) => url.trim().replace(/\/+$/, '');

/** Custom addresses and models stay custom instead of silently showing a different preset's limits. */
export const transcriptionPresetFor = (rec: RecordingSettings): TranscriptionPreset | undefined =>
  rec.endpoint === 'custom' ? TRANSCRIPTION_PRESETS.find((p) => base(p.baseUrl) === base(rec.baseUrl) && p.model === rec.model) : undefined;

/** Never carry another transcription provider's key into the new service. */
export const applyTranscriptionPreset = (p: TranscriptionPreset): Partial<RecordingSettings> => ({
  endpoint: 'custom',
  baseUrl: p.baseUrl,
  apiKey: '',
  model: p.model,
  pricePerMinute: p.pricePerMinute,
});

/** Returning to the note connection must not keep a different service's model or free-tier price. */
export function sameTranscriptionDefaults(ai: AISettings): Pick<RecordingSettings, 'model' | 'pricePerMinute'> {
  const address = ai.mode === 'device' ? '' : ai.mode === 'proxy' ? ai.proxyUrl : ai.baseUrl;
  const p = TRANSCRIPTION_PRESETS.find((p) => base(p.baseUrl) === base(address)) ?? DEFAULT_SETTINGS.recording;
  return { model: p.model, pricePerMinute: p.pricePerMinute };
}
