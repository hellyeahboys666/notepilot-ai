import type { AISettings, RecordingSettings } from '../core/settings';
import { AIError, endpointFor } from './client';

/**
 * Speech-to-text through the user's OpenAI-compatible endpoint (or the NotePilot proxy): POST /audio/transcriptions
 * beside the /chat/completions the rest of NotePilot uses. One request per recorded segment; the audio is sent once
 * and never stored. `prompt` carries the end of the previous line, so words split between segments stay consistent.
 */

export interface TranscribeOptions {
  prompt?: string;
  signal?: AbortSignal;
}

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

export function transcriptionUrl(ai: AISettings): { url: string; key: string } {
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
  const { url, key } = transcriptionUrl(ai);
  const form = new FormData();
  form.append('file', audio, `segment.${EXT[audio.type.split(';')[0]] ?? 'webm'}`);
  form.append('model', rec.model);
  form.append('response_format', 'json');
  if (rec.language.trim()) form.append('language', rec.language.trim());
  if (opts.prompt?.trim()) form.append('prompt', opts.prompt.trim().slice(-600));
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
