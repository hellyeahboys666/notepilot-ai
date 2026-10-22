import type { AISettings, RecordingSettings } from '../core/settings';
import { AIError, endpointFor } from './client';

/**
 * Speech-to-text through the recording service, or the AI endpoint / NotePilot proxy: POST /audio/transcriptions.
 * One request per recorded segment; the audio is sent once and never stored. `prompt` carries the end of the previous
 * line, so words split between segments stay consistent.
 */

export interface TranscribeOptions {
  prompt?: string;
  signal?: AbortSignal;
}

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

export function transcriptionUrl(ai: AISettings, rec?: RecordingSettings): { url: string; key: string } {
  if (rec?.endpoint === 'custom') {
    const base = rec.baseUrl.trim().replace(/\/+$/, '');
    let origin = '';
    try {
      const parsed = new URL(base);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
    } catch {
      /* invalid address: explain where to fix it below */
    }
    if (!origin) throw new AIError('bad_request', 'Enter an HTTP or HTTPS transcription service address in Settings → Recording.');
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    // Chrome's optional HTTP permissions cover only these loopback hosts.
    if (origin.startsWith('http:') && !local) throw new AIError('bad_request', 'Use HTTPS for a remote transcription service, or HTTP on localhost / 127.0.0.1, in Settings → Recording.');
    const key = rec.apiKey.trim();
    if (!local && !key) throw new AIError('auth', 'Add an API key for the transcription service in Settings → Recording.');
    return { url: `${base}/audio/transcriptions`, key };
  }
  if (ai.mode === 'device') throw new AIError('bad_request', 'The on-device AI cannot transcribe audio. Choose a transcription service in Settings → Recording.');
  const { url, key } = endpointFor(ai);
  return { url: url.replace(/\/chat\/completions$/, '/audio/transcriptions'), key };
}

export async function transcribe(
  ai: AISettings,
  rec: RecordingSettings,
  audio: Blob,
  opts: TranscribeOptions = {},
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<{ text: string; latencyMs: number }> {
  const { url, key } = transcriptionUrl(ai, rec);
  // Mistral returns JSON by default and uses context_bias, not OpenAI's prompt field.
  const mistral = /^https:\/\/api\.mistral\.ai(?::443)?\//.test(url);
  const form = new FormData();
  form.append('file', audio, `segment.${EXT[audio.type.split(';')[0]] ?? 'webm'}`);
  form.append('model', rec.model);
  if (!mistral) form.append('response_format', 'json');
  if (rec.language.trim()) form.append('language', rec.language.trim());
  if (!mistral && opts.prompt?.trim()) form.append('prompt', opts.prompt.trim().slice(-600));
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`; // no Content-Type: the browser sets the multipart boundary
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: form, signal: opts.signal });
  } catch (e) {
    if (opts.signal?.aborted) throw new AIError('aborted', 'Transcription cancelled');
    throw new AIError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (res.ok) {
    const json = (await res.json().catch(() => ({}))) as { text?: unknown };
    return { text: typeof json.text === 'string' ? json.text : '', latencyMs: Math.round(performance.now() - t0) };
  }
  let message = '';
  try {
    const err = (await res.json()) as { error?: { message?: string } | string };
    message = typeof err.error === 'string' ? err.error : err.error?.message ?? '';
  } catch {
    /* ignore */
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  if (res.status === 401 || res.status === 403) throw new AIError('auth', message || 'The AI provider rejected the API key', res.status);
  if (res.status === 429) throw new AIError('rate_limit', message || 'AI rate limit reached', 429, retryAfterMs);
  if (res.status === 402) throw new AIError('budget', message || 'The AI budget is used up', 402);
  if (res.status === 400 || res.status === 404 || res.status === 413 || res.status === 415)
    throw new AIError('bad_request', message || `The provider could not transcribe this audio (${res.status})`, res.status);
  throw new AIError('server', message || `AI provider error ${res.status}`, res.status, retryAfterMs);
}
