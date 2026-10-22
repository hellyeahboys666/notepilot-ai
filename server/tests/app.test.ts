import { describe, expect, it, afterEach } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, multipartFields } from '../src/app';
import { loadConfig, type ServerConfig } from '../src/config';

const TOKEN = 'student-token-0123456789';
let server: Server | null = null;
afterEach(() => server?.close());

type Call = { url: string; auth: string; body: Record<string, unknown>; contentType: string; raw: Buffer | null };

async function start(
  env: Record<string, string> = {},
  upstream?: (body: Record<string, unknown>, signal?: AbortSignal | null) => Promise<Response>,
  patch: Partial<ServerConfig> = {},
) {
  const calls: Call[] = [];
  let now = Date.parse('2026-10-19T12:00:00Z');
  const config = { ...loadConfig({ UPSTREAM_API_KEY: 'sk-upstream', ACCESS_TOKENS: `alice:${TOKEN}`, RATE_LIMIT_PER_MIN: '3', DAILY_TOKEN_LIMIT: '5000', ...env }), ...patch };
  const { handler } = createApp(config, {
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const json = typeof init.body === 'string';
      const body = json ? JSON.parse(String(init.body)) : {};
      calls.push({ url, auth: headers.Authorization, body, contentType: headers['Content-Type'], raw: json ? null : Buffer.from(init.body as Uint8Array) });
      if (upstream) return upstream(body, init.signal);
      if (url.endsWith('/audio/transcriptions'))
        return new Response(JSON.stringify({ text: 'Hello class', usage: { type: 'tokens', input_tokens: 300, output_tokens: 20, total_tokens: 320 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ops":[]}' } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }), { status: 200 });
    }) as typeof fetch,
  });
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const post = (body: unknown, token = TOKEN) =>
    fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const transcribe = (form: FormData | string, token = TOKEN, contentType?: string) =>
    fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) }, body: form });
  const usage = async () => (await fetch(`${base}/v1/usage`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  return { base, post, transcribe, usage, calls, tick: (ms: number) => (now += ms) };
}

// A lecture chunk as the extension uploads it: a standalone WebM/Opus file plus the model field.
const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01, 0x02, 0x03, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
const audioForm = (fields: Record<string, string> = { model: 'gpt-4o-mini-transcribe' }, file: Buffer | null = AUDIO) => {
  const form = new FormData();
  if (file) form.append('file', new Blob([file], { type: 'audio/webm' }), 'chunk-0001.webm');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
};

const req = (content = 'hi') => ({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content }] });

describe('NotePilot proxy', () => {
  it('rejects missing or wrong tokens', async () => {
    const s = await start();
    expect((await s.post(req(), 'nope-nope-nope-nope-nope')).status).toBe(401);
    expect((await fetch(`${s.base}/health`)).status).toBe(200);
  });

  it('forwards to the upstream with the server-held key and records usage', async () => {
    const s = await start();
    const r = await s.post({ ...req(), stream: true });
    expect(r.status).toBe(200);
    expect(s.calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/chat/completions', auth: 'Bearer sk-upstream' });
    expect(s.calls[0].body.stream).toBe(false);
    const usage = await (await fetch(`${s.base}/v1/usage`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    expect(usage).toMatchObject({ user: 'alice', requests: 1, promptTokens: 1000, completionTokens: 200 });
  });

  it('serves identical requests from cache', async () => {
    const s = await start();
    await s.post(req('same'));
    const r = await s.post(req('same'));
    expect(r.headers.get('x-notepilot-cache')).toBe('hit');
    expect(s.calls).toHaveLength(1);
  });

  it('enforces the per-user rate limit and the daily token budget', async () => {
    const s = await start();
    for (let i = 0; i < 3; i++) expect((await s.post(req(`m${i}`))).status).toBe(200);
    const limited = await s.post(req('m3'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    s.tick(60_000);
    // 1200 tokens per request: 3600 → 4800 → 6000 ≥ 5000, so the 6th request is refused.
    expect((await s.post(req('m4'))).status).toBe(200);
    expect((await s.post(req('m5'))).status).toBe(200);
    expect((await s.post(req('m6'))).status).toBe(402);
    s.tick(24 * 3600_000);
    expect((await s.post(req('m7'))).status).toBe(200);
  });

  it('enforces the model allowlist and body validation', async () => {
    const s = await start({ ALLOWED_MODELS: 'gpt-4.1-mini' });
    expect((await s.post({ ...req(), model: 'expensive-model' })).status).toBe(400);
    expect((await s.post({ foo: 1 })).status).toBe(400);
  });

  it('passes upstream errors through and does not cache them', async () => {
    const s = await start({}, async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503, headers: { 'retry-after': '7' } }));
    const r = await s.post(req());
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('7');
    await s.post(req());
    expect(s.calls).toHaveLength(2);
  });

  it('validates configuration', () => {
    expect(() => loadConfig({ ACCESS_TOKENS: `a:${TOKEN}` })).toThrow(/UPSTREAM_API_KEY/);
    expect(() => loadConfig({ UPSTREAM_API_KEY: 'k', ACCESS_TOKENS: 'a:short' })).toThrow(/too short/);
  });
});

describe('NotePilot proxy: audio transcriptions', () => {
  it('passes the multipart upload through unchanged with the server-held key and counts its tokens', async () => {
    const s = await start();
    const r = await s.transcribe(audioForm({ model: 'gpt-4o-mini-transcribe', language: 'en', prompt: 'Earlier: photosynthesis' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ text: 'Hello class' });
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0];
    expect(call).toMatchObject({ url: 'https://api.openai.com/v1/audio/transcriptions', auth: 'Bearer sk-upstream' });
    expect(call.contentType).toMatch(/^multipart\/form-data; ?boundary=/);
    expect(call.raw!.includes(AUDIO)).toBe(true);
    expect(call.raw!.toString('latin1')).toContain('Earlier: photosynthesis');
    expect(await s.usage()).toMatchObject({ requests: 1, promptTokens: 300, completionTokens: 20 });
  });

  it('requires a token, a multipart body, a file and an allowed model, without calling the upstream', async () => {
    const s = await start({ ALLOWED_MODELS: 'gpt-5.4-mini' });
    expect((await s.transcribe(audioForm(), 'nope-nope-nope-nope-nope')).status).toBe(401);
    expect((await s.transcribe('{"model":"gpt-4o-mini-transcribe"}', TOKEN, 'application/json')).status).toBe(415);
    expect((await s.transcribe(audioForm({ model: 'gpt-4o-mini-transcribe' }, null))).status).toBe(400);
    expect((await s.transcribe(audioForm({}))).status).toBe(400);
    const refused = await s.transcribe(audioForm());
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toMatch(/not allowed/);
    expect(s.calls).toHaveLength(0);

    const listed = await start({ ALLOWED_MODELS: 'gpt-5.4-mini,gpt-4o-mini-transcribe' });
    expect((await listed.transcribe(audioForm())).status).toBe(200);
  });

  it('refuses a body over the audio cap before reading it', async () => {
    const s = await start({}, undefined, { maxAudioBytes: 1000 });
    const r = await s.transcribe(audioForm(undefined, Buffer.alloc(2000, 7)));
    expect(r.status).toBe(413);
    expect(s.calls).toHaveLength(0);
    expect(loadConfig({ UPSTREAM_API_KEY: 'k', ACCESS_TOKENS: `a:${TOKEN}` }).maxAudioBytes).toBe(25 * 1024 * 1024);
  });

  it('still answers 413 to a streamed upload with no Content-Length that passes the cap', async () => {
    const s = await start({}, undefined, { maxAudioBytes: 1000 });
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(`${s.base}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'multipart/form-data; boundary=b0', 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      for (let i = 0; i < 8; i++) r.write(Buffer.alloc(400, 1));
      r.end();
    });
    expect(status).toBe(413);
    expect(s.calls).toHaveLength(0);
  });

  it('shares the per-user rate limit and daily budget with chat', async () => {
    const s = await start({ DAILY_TOKEN_LIMIT: '1500' });
    expect((await s.post(req('notes'))).status).toBe(200);           // 1200 tokens
    expect((await s.transcribe(audioForm())).status).toBe(200);      // +320 = 1520 ≥ 1500
    expect((await s.transcribe(audioForm())).status).toBe(402);
    s.tick(24 * 3600_000);
    for (let i = 0; i < 3; i++) expect((await s.transcribe(audioForm())).status).toBe(200);
    const limited = await s.transcribe(audioForm());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('logs counts only: never the audio, its file name or the transcript', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'notepilot-')), 'usage.jsonl');
    const s = await start({ USAGE_LOG: log }, async () => new Response(JSON.stringify({ text: 'Secret lecture words', duration: 19.5, usage: { type: 'duration', seconds: 20 } }), { status: 200 }));
    await s.transcribe(audioForm({ model: 'whisper-1', prompt: 'Private context' }));
    let line = '';
    for (let i = 0; i < 50 && !line; i++) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        line = readFileSync(log, 'utf8').trim();
      } catch {
        /* not written yet */
      }
    }
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ user: 'alice', route: 'transcriptions', model: 'whisper-1', status: 200, seconds: 20 });
    expect(entry.bytes).toBeGreaterThan(AUDIO.length);
    expect(line).not.toMatch(/Secret lecture|Private context|chunk-0001/);
  });

  it('keeps a text response as text and passes upstream errors through', async () => {
    const text = await start({}, async () => new Response('Hello class', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    const r = await text.transcribe(audioForm({ model: 'gpt-4o-mini-transcribe', response_format: 'text' }));
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await r.text()).toBe('Hello class');

    const busy = await start({}, async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503, headers: { 'retry-after': '7', 'content-type': 'application/json' } }));
    const e = await busy.transcribe(audioForm());
    expect(e.status).toBe(503);
    expect(e.headers.get('retry-after')).toBe('7');
  });

  it('reads only the model field and the presence of a file part', () => {
    const body = Buffer.from(
      '--b0\r\nContent-Disposition: form-data; name="file"; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\n' +
        '\x1a\x45--b0x\r\n\r\n' +
        '\r\n--b0\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n--b0--\r\n',
      'latin1',
    );
    expect(multipartFields(body, 'b0')).toEqual({ model: 'gpt-4o-mini-transcribe', hasFile: true });
    expect(multipartFields(Buffer.from('--b0--\r\n'), 'b0')).toEqual({ model: null, hasFile: false });
  });
});
