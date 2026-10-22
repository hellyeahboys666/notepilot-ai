import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribe } from '../src/ai/transcribe';
import { RecordingSession, type SessionDeps } from '../src/audio/session';
import type { Segment } from '../src/audio/recorder';
import { buildRewriteMessages } from '../src/core/context';
import { parseDocument } from '../src/core/docParser';
import { rewriteSystemPrompt } from '../src/core/prompts';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings';
import {
  assertTranscriptOnly,
  planTranscriptAppend,
  snapshotOf,
  TRANSCRIPT_HEADING,
  TRANSCRIPT_RANGE,
  transcriptLine,
  transcriptRange,
  type DocsWriteRequest,
  type WriteSnapshot,
} from '../src/core/transcript';
import { emptyOrganizedDoc, UNSORTED_SECTION_ID } from '../src/core/types';
import { TRANSCRIPT_SCOPES, type AuthProvider } from '../src/google/auth';
import { createTranscriptWriter, TranscriptWriteError } from '../src/google/transcriptWriter';
import { docsResponse } from './fixtures';
import { createHarness, type RewritePayload } from './harness';

/**
 * A tiny model of a Docs body: its text, where index 1 is the first character (index 0 is the section break), and the
 * transcript named range. Inserting inside the range grows it, as Docs does.
 */
class Body {
  constructor(
    public text: string,
    public range: { startIndex: number; endIndex: number } | null = null,
  ) {}
  get end() {
    return 1 + this.text.length;
  }
  /** What the writer's documents.get returns for this body. */
  doc() {
    let at = 1;
    const content = this.text
      .split('\n')
      .slice(0, -1)
      .map((para) => {
        const el = { startIndex: at, endIndex: at + para.length + 1, paragraph: { elements: [{ textRun: { content: `${para}\n` } }] } };
        at += para.length + 1;
        return el;
      });
    return { revisionId: 'rev-7', body: { content }, namedRanges: this.range ? { [TRANSCRIPT_RANGE]: { namedRanges: [{ name: TRANSCRIPT_RANGE, ranges: [{ ...this.range }] }] } } : undefined };
  }
  snapshot(): WriteSnapshot {
    return snapshotOf(this.doc());
  }
  slice(r: { startIndex: number; endIndex: number }) {
    return this.text.slice(r.startIndex - 1, r.endIndex - 1);
  }
  apply(requests: DocsWriteRequest[]) {
    for (const r of requests) {
      if ('insertText' in r) {
        const { index } = r.insertText.location;
        const n = r.insertText.text.length;
        this.text = this.text.slice(0, index - 1) + r.insertText.text + this.text.slice(index - 1);
        if (this.range && index > this.range.startIndex && index < this.range.endIndex) this.range = { ...this.range, endIndex: this.range.endIndex + n };
      } else if ('createNamedRange' in r) this.range = { ...r.createNamedRange.range };
    }
  }
}

const NOTES = 'Photosynthesis\nChlorophyll absorbs light\n';
const at = (h: number, m: number) => new Date(2026, 9, 22, h, m).getTime();

describe('the transcript section in the doc', () => {
  it('a first line adds the heading and the line after the notes, styling and naming only that new text', () => {
    const body = new Body(NOTES);
    const s = body.snapshot();
    const line = transcriptLine('  Light reactions happen   in the thylakoids ', at(10, 42), 'en-GB');
    expect(line).toBe('[10:42] Light reactions happen in the thylakoids');
    const plan = planTranscriptAppend(s, line);
    assertTranscriptOnly(plan, s);
    body.apply(plan);
    expect(body.text).toBe(`${NOTES}${TRANSCRIPT_HEADING}\n${line}\n`);
    expect(body.text.startsWith(NOTES)).toBe(true);
    const styles = plan.flatMap((r) => ('updateParagraphStyle' in r ? [r.updateParagraphStyle] : []));
    expect(styles.map((x) => [body.slice(x.range), x.paragraphStyle.namedStyleType])).toEqual([
      [`${TRANSCRIPT_HEADING}\n`, 'HEADING_2'],
      [`${line}\n`, 'NORMAL_TEXT'],
    ]);
    // the student's last paragraph style (alignment, indents…) and text style (bold, links…) are not inherited
    expect(styles.every((x) => /alignment,indentStart/.test(x.fields))).toBe(true);
    const text = plan.flatMap((r) => ('updateTextStyle' in r ? [r.updateTextStyle] : []));
    expect(text.map((x) => [body.slice(x.range), x.textStyle, /bold,italic.*link/.test(x.fields)])).toEqual([[`${TRANSCRIPT_HEADING}\n${line}`, {}, true]]);
    const bullets = plan.find((r) => 'deleteParagraphBullets' in r) as { deleteParagraphBullets: { range: { startIndex: number; endIndex: number } } };
    expect(body.slice(bullets.deleteParagraphBullets.range)).toBe(`${TRANSCRIPT_HEADING}\n${line}\n`);
    expect(body.slice(body.range!)).toBe(`${TRANSCRIPT_HEADING}\n${line}\n`);
  });

  it('later lines go inside the section, even when the student has typed below it', () => {
    const body = new Body(NOTES);
    body.apply(planTranscriptAppend(body.snapshot(), '[10:42] First line'));
    body.text += 'My own note typed after the transcript\n';
    for (const line of ['[10:43] Second line', '[10:44] Third line']) {
      const s = body.snapshot();
      const plan = planTranscriptAppend(s, line);
      expect(plan.map((r) => Object.keys(r)[0])).toEqual(['insertText', 'updateTextStyle', 'updateParagraphStyle']);
      assertTranscriptOnly(plan, s);
      body.apply(plan);
    }
    expect(body.text).toBe(`${NOTES}${TRANSCRIPT_HEADING}\n[10:42] First line\n[10:43] Second line\n[10:44] Third line\nMy own note typed after the transcript\n`);
    expect(body.slice(body.range!)).toBe(`${TRANSCRIPT_HEADING}\n[10:42] First line\n[10:43] Second line\n[10:44] Third line\n`);
  });

  it('text the student types at the end of the section stays theirs: new lines go before it, without splitting it', () => {
    const body = new Body(NOTES);
    body.apply(planTranscriptAppend(body.snapshot(), '[10:42] First line'));
    body.apply([{ insertText: { location: { index: body.range!.endIndex - 1 }, text: '\nMy own note, typed after the last line' } }]); // inside the range, as Docs does
    body.apply(planTranscriptAppend(body.snapshot(), '[10:43] Second line'));
    expect(body.text).toBe(`${NOTES}${TRANSCRIPT_HEADING}\n[10:42] First line\n[10:43] Second line\nMy own note, typed after the last line\n`);
    const blocks = parseDocument({ ...body.doc(), tabs: undefined } as never).blocks;
    expect(blocks.filter((b) => b.text.startsWith('My own note')).map((b) => !!b.transcript)).toEqual([false]);
    expect(blocks.filter((b) => b.transcript).map((b) => b.text)).toEqual(['[10:42] First line', '[10:43] Second line']);
  });

  it('anything but inserting and dressing its own text is refused before it is sent', () => {
    const fresh: WriteSnapshot = { revisionId: 'r', bodyEnd: 40, range: null, anchor: null, lastLine: null, after: null };
    const existing: WriteSnapshot = { revisionId: 'r', bodyEnd: 90, range: { startIndex: 40, endIndex: 80 }, anchor: 80, lastLine: '[1:00] y', after: null };
    const insert = (index: number) => ({ insertText: { location: { index }, text: '\n[1:00] x' } });
    expect(() => assertTranscriptOnly([insert(79)], existing)).not.toThrow();
    expect(() => assertTranscriptOnly([insert(10)], existing)).toThrow(/after the last transcript line/);
    expect(() => assertTranscriptOnly([insert(79), { updateTextStyle: { range: { startIndex: 80, endIndex: 88 }, textStyle: {}, fields: 'bold' } }], existing)).not.toThrow();
    expect(() => assertTranscriptOnly([insert(79), insert(79)], existing)).toThrow(/one insertion/);
    expect(() => assertTranscriptOnly([insert(79), { deleteContentRange: { range: { startIndex: 2, endIndex: 9 } } } as never], existing)).toThrow(/not allowed/);
    expect(() => assertTranscriptOnly([insert(79), { createNamedRange: { name: TRANSCRIPT_RANGE, range: { startIndex: 80, endIndex: 85 } } }], existing)).toThrow(/not allowed/);
    expect(() => assertTranscriptOnly([insert(39), { updateParagraphStyle: { range: { startIndex: 5, endIndex: 45 }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } }], fresh)).toThrow(/inserted text/);
    expect(() => planTranscriptAppend(fresh, 'two\nlines')).toThrow();
    expect(() => planTranscriptAppend(fresh, '')).toThrow();
  });

  it('the section is found by its name, in the body only', () => {
    const group = (ranges: object[]) => ({ [TRANSCRIPT_RANGE]: { namedRanges: [{ name: TRANSCRIPT_RANGE, ranges }] } });
    expect(transcriptRange(undefined)).toBeNull();
    expect(transcriptRange(group([{ startIndex: 5, endIndex: 9, segmentId: 'kix.header' }]))).toBeNull();
    expect(transcriptRange(group([{ startIndex: 30, endIndex: 50 }, { startIndex: 60, endIndex: 90 }, { startIndex: 7, endIndex: 7 }]))).toEqual({ startIndex: 60, endIndex: 90 });
  });
});

describe('reading the transcript back', () => {
  it('lines in the section are marked as recording, and NotePilot’s own heading is not note content', () => {
    const doc = docsResponse([
      'Photosynthesis makes glucose',
      { text: TRANSCRIPT_HEADING, style: 'HEADING_2', transcript: true },
      { text: '[10:42] The light reactions happen in the thylakoids', transcript: true },
      { text: '[10:43] This will be on the test', transcript: true },
      'A note typed after',
    ]);
    const blocks = parseDocument(doc).blocks;
    expect(blocks.map((b) => [b.text, !!b.transcript])).toEqual([
      ['Photosynthesis makes glucose', false],
      ['[10:42] The light reactions happen in the thylakoids', true],
      ['[10:43] This will be on the test', true],
      ['A note typed after', false],
    ]);
  });

  it('the rewrite sees recording lines flagged, with rules for folding them into the notes', () => {
    const blocks = parseDocument(docsResponse(['Mitochondria make ATP', { text: '[10:42] the my toe Kondria is the powerhouse', transcript: true }])).blocks.map((b, i) => ({ ...b, id: `b${i + 1}` }));
    const built = buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: blocks, batch: { added: blocks, modified: [], removed: [] }, settings: DEFAULT_SETTINGS });
    const payload = JSON.parse(built.messages[1].content.slice(built.messages[1].content.indexOf('{')));
    expect(payload.changes.added.map((b: { recording?: boolean }) => !!b.recording)).toEqual([false, true]);
    const system = rewriteSystemPrompt(DEFAULT_SETTINGS);
    expect(system).toMatch(/RECORDING\n/);
    expect(system).toMatch(/Recording blocks do not each have to be cited/);
    expect(system).toMatch(/clearly misheard/);
  });
});

describe('writing to Google Docs', () => {
  const auth = (scopes: string[][] = []): AuthProvider => ({
    getToken: async (_i, s) => (scopes.push(s ?? []), 'tok'),
    invalidate: async () => undefined,
    signOut: async () => undefined,
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('reads the end of the doc, then sends the checked plan against that revision with the transcript permission', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const scopes: string[][] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1 ? json(200, { revisionId: 'rev-9', body: { content: [{ endIndex: 1 }, { endIndex: 43 }] } }) : json(200, {});
    });
    await createTranscriptWriter(auth(scopes), fetchImpl as never).append('DOC_1', '[10:42] Hello');
    expect(calls[0].url).toBe('https://docs.googleapis.com/v1/documents/DOC_1?fields=revisionId,namedRanges,body(content(startIndex,endIndex,paragraph(elements(textRun(content)))))');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[1].url).toBe('https://docs.googleapis.com/v1/documents/DOC_1:batchUpdate');
    expect(calls[1].init.method).toBe('POST');
    const sent = JSON.parse(String(calls[1].init.body));
    expect(sent.writeControl).toEqual({ targetRevisionId: 'rev-9' });
    expect(sent.requests[0]).toEqual({ insertText: { location: { index: 42 }, text: `\n${TRANSCRIPT_HEADING}\n[10:42] Hello` } });
    expect(scopes.every((s) => JSON.stringify(s) === JSON.stringify(TRANSCRIPT_SCOPES))).toBe(true);
  });

  it('a line that is already there is not written twice (a retry after a lost reply)', async () => {
    const body = new Body(NOTES);
    body.apply(planTranscriptAppend(body.snapshot(), '[10:42] Hello'));
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => (init.method === 'GET' ? json(200, body.doc()) : json(200, {})));
    await createTranscriptWriter(auth(), fetchImpl as never).append('D', '[10:42] Hello');
    expect(fetchImpl.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['GET']);
  });

  it('stops rather than write out of order when the section did not take the last line in', async () => {
    const body = new Body(NOTES);
    body.apply(planTranscriptAppend(body.snapshot(), '[10:42] First line'));
    const writer = createTranscriptWriter(auth(), (async (_u: string, init: RequestInit) => {
      if (init.method === 'GET') return json(200, body.doc());
      // the insert lands, but (unlike real Docs) the range does not grow
      const range = body.range;
      body.apply(JSON.parse(String(init.body)).requests);
      body.range = range;
      return json(200, {});
    }) as never);
    await writer.append('D', '[10:43] Second line');
    const err = await writer.append('D', '[10:44] Third line').catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptWriteError);
    expect(err.kind).toBe('conflict');
  });

  it('a view-only doc is reported as such', async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => (init.method === 'GET' ? json(200, { revisionId: 'r', body: { content: [{ endIndex: 5 }] } }) : json(403, { error: { message: 'The caller does not have permission' } })));
    const err = await createTranscriptWriter(auth(), fetchImpl as never).append('D', '[1:00] x').catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptWriteError);
    expect(err.kind).toBe('forbidden');
  });
});

describe('transcription', () => {
  const ai = { ...DEFAULT_SETTINGS.ai, apiKey: 'note-key', baseUrl: 'https://notes.example.com/v1/', proxyUrl: 'https://notes-proxy.example.com/v1/', proxyToken: 'proxy-token' };
  const custom = { ...DEFAULT_SETTINGS.recording, endpoint: 'custom' as const, baseUrl: ' https://speech.example.com/openai/v1/// ', apiKey: ' speech-key ', model: 'whisper-large-v3', language: ' es ' };
  const audio = (type = 'audio/webm;codecs=opus') => new Blob(['abc'], { type });
  const reply = (body: unknown = { text: ' Hello class ' }, status = 200, headers?: HeadersInit) =>
    vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status, headers }));

  it('same direct posts multipart beside the chat endpoint, ignoring custom credentials and preserving the result shape', async () => {
    const fetchImpl = reply({ text: ' Hello class ', usage: { total_tokens: 12 }, model: 'provider-model' });
    const signal = new AbortController().signal;
    const rec = { ...custom, endpoint: 'same' as const, model: 'gpt-4o-mini-transcribe', language: ' en ' };
    const out = await transcribe(ai, rec, audio(), { prompt: ' previous words ', signal }, fetchImpl as never);
    expect(out).toEqual({ text: ' Hello class ', latencyMs: expect.any(Number) });
    expect(Number.isInteger(out.latencyMs)).toBe(true);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://notes.example.com/v1/audio/transcriptions');
    expect(init).toMatchObject({ method: 'POST', signal });
    expect(init.headers).toEqual({ Authorization: 'Bearer note-key' }); // the browser supplies the multipart Content-Type
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['file', 'model', 'response_format', 'language', 'prompt']);
    expect([form.get('model'), form.get('language'), form.get('prompt'), form.get('response_format')]).toEqual(['gpt-4o-mini-transcribe', 'en', 'previous words', 'json']);
    expect((form.get('file') as File).name).toBe('segment.webm');
    expect(await (form.get('file') as File).text()).toBe('abc');
  });

  it('same proxy keeps its proxy address and token, never the direct or custom keys', async () => {
    const fetchImpl = reply();
    await transcribe({ ...ai, mode: 'proxy' }, { ...custom, endpoint: 'same' }, audio(), {}, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://notes-proxy.example.com/v1/audio/transcriptions');
    expect(init.headers).toEqual({ Authorization: 'Bearer proxy-token' });
    expect((init.body as FormData).get('model')).toBe('whisper-large-v3');
  });

  it.each(['direct', 'proxy', 'device'] as const)('custom uses only its own host, key and model with %s note AI', async (mode) => {
    const fetchImpl = reply();
    await transcribe({ ...ai, mode }, custom, audio(), { prompt: 'previous words' }, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://speech.example.com/openai/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer speech-key' });
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['file', 'model', 'response_format', 'language', 'prompt']);
    expect([form.get('model'), form.get('language'), form.get('prompt'), form.get('response_format')]).toEqual(['whisper-large-v3', 'es', 'previous words', 'json']);
    expect((form.get('file') as File).name).toBe('segment.webm');
    expect(await (form.get('file') as File).text()).toBe('abc');
  });

  it.each(['localhost', '127.0.0.1'])('custom HTTP %s needs no key and never borrows note or proxy credentials', async (host) => {
    const fetchImpl = reply();
    await transcribe({ ...ai, mode: 'proxy' }, { ...custom, baseUrl: `http://${host}:8000/v1/`, apiKey: '  ', language: ' ' }, audio(), { prompt: ' ' }, fetchImpl as never);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`http://${host}:8000/v1/audio/transcriptions`);
    expect(init.headers).toEqual({});
    expect([...(init.body as FormData).keys()]).toEqual(['file', 'model', 'response_format']);
  });

  it.each(['localhost', '127.0.0.1'])('same direct HTTP %s still works without a key', async (host) => {
    const fetchImpl = reply();
    await transcribe({ ...ai, baseUrl: `http://${host}:8000/v1/`, apiKey: '' }, DEFAULT_SETTINGS.recording, audio(), {}, fetchImpl as never);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`http://${host}:8000/v1/audio/transcriptions`);
    expect(init.headers).toEqual({});
  });

  it.each([
    ['https://speech.example.com/v1', ''],
    ['https://speech.example.com/v1', '  '],
    ['https://localhost/v1', ''],
  ])('rejects a missing custom key at %s before sending audio (key %j)', async (baseUrl, apiKey) => {
    const fetchImpl = reply();
    await expect(transcribe({ ...ai, mode: 'proxy' }, { ...custom, baseUrl, apiKey }, audio(), {}, fetchImpl as never)).rejects.toMatchObject({
      name: 'AIError', kind: 'auth', message: expect.stringContaining('Settings → Recording'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['http://speech.example.com/v1', 'http://192.168.1.20:8000/v1', 'http://localhost.example.com/v1', 'http://127.0.0.1.example.com/v1'])('rejects undeclared remote HTTP hosts at %s before sending audio or credentials', async (baseUrl) => {
    const fetchImpl = reply();
    await expect(transcribe(ai, { ...custom, baseUrl }, audio(), {}, fetchImpl as never)).rejects.toMatchObject({
      name: 'AIError', kind: 'bad_request', message: expect.stringContaining('HTTPS'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['', 'not an address', 'ftp://speech.example.com/v1'])('rejects an invalid custom service address %j before sending audio', async (baseUrl) => {
    const fetchImpl = reply();
    await expect(transcribe(ai, { ...custom, baseUrl }, audio(), {}, fetchImpl as never)).rejects.toMatchObject({
      name: 'AIError', kind: 'bad_request', message: expect.stringContaining('Settings → Recording'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('same on-device AI points to Settings → Recording rather than sending to stale AI or custom addresses', async () => {
    const fetchImpl = reply();
    await expect(transcribe({ ...ai, mode: 'device' }, { ...custom, endpoint: 'same' }, audio(), {}, fetchImpl as never)).rejects.toMatchObject({
      name: 'AIError', kind: 'bad_request', message: expect.stringContaining('Choose a transcription service in Settings → Recording'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/ogg', 'ogg'],
    ['audio/mp4', 'mp4'],
    ['audio/mpeg', 'mp3'],
    ['audio/wav', 'wav'],
    ['application/octet-stream', 'webm'],
  ])('preserves the file name for %s audio', async (type, ext) => {
    const fetchImpl = reply();
    await transcribe(ai, custom, audio(type), {}, fetchImpl as never);
    const file = (fetchImpl.mock.calls[0][1].body as FormData).get('file') as File;
    expect(file.name).toBe(`segment.${ext}`);
    expect(file.type).toBe(type);
    expect(await file.text()).toBe('abc');
  });

  it('keeps only the trimmed last 600 prompt characters', async () => {
    const fetchImpl = reply();
    await transcribe(ai, custom, audio(), { prompt: `  discarded ${'x'.repeat(600)}  ` }, fetchImpl as never);
    expect((fetchImpl.mock.calls[0][1].body as FormData).get('prompt')).toBe('x'.repeat(600));
  });

  it.each([
    [401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [402, 'budget'],
    [400, 'bad_request'], [404, 'bad_request'], [413, 'bad_request'], [415, 'bad_request'], [503, 'server'],
  ])('maps custom provider status %i to %s and preserves retry metadata without retrying in the transport', async (status, kind) => {
    const fetchImpl = reply({ error: { message: 'Provider detail' } }, status as number, { 'retry-after': '2.5' });
    await expect(transcribe(ai, custom, audio(), {}, fetchImpl as never)).rejects.toMatchObject({
      name: 'AIError', kind, status, message: 'Provider detail', retryAfterMs: kind === 'rate_limit' || kind === 'server' ? 2500 : undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('preserves a provider string error', async () => {
    await expect(transcribe(ai, custom, audio(), {}, reply({ error: 'Invalid transcription key' }, 401) as never)).rejects.toMatchObject({
      name: 'AIError', kind: 'auth', status: 401, message: 'Invalid transcription key',
    });
  });

  it('uses the normal error fallback for a non-JSON response and ignores an invalid retry-after', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'retry-after': 'later' } }));
    await expect(transcribe(ai, custom, audio(), {}, fetchImpl as never)).rejects.toMatchObject({
      name: 'AIError', kind: 'server', status: 503, message: 'AI provider error 503', retryAfterMs: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([{}, { text: 12 }, { text: null }])('preserves an empty transcript when the success response has no string text (%j)', async (body) => {
    await expect(transcribe(ai, custom, audio(), {}, reply(body) as never)).resolves.toEqual({ text: '', latencyMs: expect.any(Number) });
  });

  it('preserves an empty transcript when the success response is not JSON', async () => {
    await expect(transcribe(ai, custom, audio(), {}, (async () => new Response('not JSON')) as never)).resolves.toEqual({ text: '', latencyMs: expect.any(Number) });
  });

  it('reports network failures without retrying in the transport', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('Connection refused'); });
    await expect(transcribe(ai, custom, audio(), {}, fetchImpl as never)).rejects.toMatchObject({ name: 'AIError', kind: 'network', message: 'Connection refused' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('passes the abort signal through and reports cancellation rather than a network error', async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(ctl.signal);
      ctl.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(transcribe(ai, custom, audio(), { signal: ctl.signal }, fetchImpl as never)).rejects.toMatchObject({ name: 'AIError', kind: 'aborted', message: 'Transcription cancelled' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('lets the recording session retry custom rate-limit/server failures and counts audio usage once', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      attempts++;
      return attempts < 3
        ? new Response('{}', { status: attempts === 1 ? 429 : 503, headers: { 'retry-after': String(attempts + 1) } })
        : new Response(JSON.stringify({ text: 'Lecture words' }));
    });
    const write = vi.fn(async () => undefined);
    const spend = vi.fn(() => true);
    const sleep = vi.fn(async () => undefined);
    const onFatal = vi.fn();
    const session = new RecordingSession('DOC', 'mic', {
      transcribe: (blob, prompt, signal) => transcribe(ai, custom, blob, { prompt, signal }, fetchImpl as never),
      write, spend, sleep, now: () => at(10, 40), locale: 'en-GB',
    }, () => undefined, onFatal);
    session.push({ blob: audio(), startedAt: at(10, 40), seconds: 20, heard: true });
    session.finish();
    await vi.waitFor(() => expect(session.state.phase).toBe('stopped'));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.headers])).toEqual(Array.from({ length: 3 }, () => ['https://speech.example.com/openai/v1/audio/transcriptions', { Authorization: 'Bearer speech-key' }]));
    expect(sleep.mock.calls).toEqual([[2000, expect.any(AbortSignal)], [3000, expect.any(AbortSignal)]]);
    expect(spend.mock.calls).toEqual([[20]]);
    expect(write).toHaveBeenCalledWith('DOC', '[10:40] Lecture words', expect.any(AbortSignal));
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('maps provider errors to the usual kinds', async () => {
    const run = (status: number) =>
      transcribe(DEFAULT_SETTINGS.ai, DEFAULT_SETTINGS.recording, new Blob(['x']), {}, (async () => new Response('{}', { status })) as never).catch((e) => e.kind);
    expect(await run(401)).toBe('auth');
    expect(await run(429)).toBe('rate_limit');
    expect(await run(400)).toBe('bad_request');
    expect(await run(402)).toBe('budget');
    expect(await run(503)).toBe('server');
  });

  it('recording settings get defaults when stored settings predate them', () => {
    const s = mergeSettings({ dailyBudgetUSD: 2 } as never);
    expect(s.recording).toEqual(DEFAULT_SETTINGS.recording);
    expect(s.recordingConsent).toBeNull();
  });
});

describe('a recording session', () => {
  const seg = (n: number, heard = true): Segment => ({ blob: new Blob([`audio ${n}`]), startedAt: at(10, 40 + n), seconds: 20, heard });
  function session(over: Partial<SessionDeps> = {}) {
    const written: string[] = [];
    const prompts: string[] = [];
    const spent: number[] = [];
    let fatal = 0;
    const deps: SessionDeps = {
      transcribe: async (blob, prompt) => (prompts.push(prompt), { text: (await blob.text()).replace('audio', 'words') }),
      write: async (_d, line) => void written.push(line),
      spend: (s) => (spent.push(s), true),
      now: () => at(10, 40),
      sleep: async () => undefined,
      locale: 'en-GB',
      ...over,
    };
    const s = new RecordingSession('DOC', 'mic', deps, () => undefined, () => fatal++);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { s, written, prompts, spent, fatal: () => fatal, settle };
  }

  it('writes lines in order, passes the previous words along, and skips silence and invented filler', async () => {
    const t = session({ transcribe: async (blob, prompt) => (t.prompts.push(prompt), { text: (await blob.text()) === 'audio 3' ? 'Thank you.' : (await blob.text()).replace('audio', 'words') }) });
    for (const n of [1, 2, 3, 4]) t.s.push(seg(n));
    t.s.push(seg(5, false));
    t.s.finish();
    await vi.waitFor(() => expect(t.s.state.phase).toBe('stopped'));
    expect(t.written).toEqual(['[10:41] words 1', '[10:42] words 2', '[10:44] words 4']);
    expect(t.prompts).toEqual(['', 'words 1', 'words 2', 'words 2']);
    expect(t.s.state.skipped).toBe(2);
    expect(t.spent).toEqual([20, 20, 20, 20]);
  });

  it('retries passing problems, then keeps recording when one part is lost', async () => {
    let calls = 0;
    const t = session({ transcribe: async () => (++calls <= 5 ? Promise.reject(Object.assign(new Error('busy'), { kind: 'rate_limit' })) : { text: 'later words' }) });
    t.s.push(seg(1));
    t.s.push(seg(2));
    t.s.finish();
    await vi.waitFor(() => expect(t.s.state.phase).toBe('stopped'));
    expect(calls).toBe(6); // the first part: three failed tries, then dropped; the second: two failures, then success
    expect(t.written).toEqual(['[10:42] later words']);
    expect(t.fatal()).toBe(0);
  });

  it('sends nothing more once it has stopped itself, and stops after three lost parts in a row or a spent budget', async () => {
    let sent = 0;
    const viewOnly = session({ transcribe: async () => (sent++, { text: 'words' }), write: async () => Promise.reject(Object.assign(new Error('view only'), { kind: 'forbidden' })) });
    viewOnly.s.push(seg(1));
    await vi.waitFor(() => expect(viewOnly.fatal()).toBe(1));
    viewOnly.s.push(seg(2)); // the recorder's final part, delivered while it stops
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toBe(1);
    const flaky = session({ transcribe: async () => Promise.reject(Object.assign(new Error('down'), { kind: 'server' })) });
    for (const n of [1, 2, 3, 4]) flaky.s.push(seg(n));
    await vi.waitFor(() => expect(flaky.fatal()).toBe(1));
    expect(flaky.s.state.error).toMatch(/three parts in a row/);
    const spent = session({ transcribe: async () => Promise.reject(Object.assign(new Error('402'), { kind: 'budget' })) });
    spent.s.push(seg(1));
    await vi.waitFor(() => expect(spent.fatal()).toBe(1));
    expect(spent.s.state.error).toMatch(/budget/);
  });

  it('stops by itself when the doc cannot be written or the cost limit is reached', async () => {
    const viewOnly = session({ write: async () => Promise.reject(Object.assign(new Error('view only'), { kind: 'forbidden' })) });
    viewOnly.s.push(seg(1));
    viewOnly.s.push(seg(2));
    await vi.waitFor(() => expect(viewOnly.fatal()).toBe(1));
    expect(viewOnly.s.state.error).toMatch(/could not be added to the doc/);
    const broke = session({ spend: () => false });
    broke.s.push(seg(1));
    await vi.waitFor(() => expect(broke.fatal()).toBe(1));
    expect(broke.s.state.error).toMatch(/cost limit/);
  });
});

describe('organizing the transcript', () => {
  afterEach(() => vi.useRealTimers());
  const notes = ['Cells need energy'];
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `[10:4${i}] spoken line ${i}`, transcript: true }));

  it('transcript lines are organized about once a minute, but typed notes go through at once', async () => {
    const h = createHarness();
    h.docs.set([...notes]);
    h.ai.onRewrite = (p: RewritePayload) => ({ ops: [{ op: 'create_section', ref: 'new:s', title: 'Notes', parent: null }, ...(p.changes.added ?? []).map((b, i) => ({ op: 'create_unit', ref: `new:u${i}`, section: 'new:s', content: b.text, origin: 'user', sources: [b.id] }))] });
    await h.engine.start();
    await h.advance(15_000);
    const before = h.ai.rewriteCalls.length;
    h.docs.set([...notes, { text: TRANSCRIPT_HEADING, style: 'HEADING_2', transcript: true }, ...lines(1)]);
    await h.advance(20_000);
    h.docs.set([...notes, { text: TRANSCRIPT_HEADING, style: 'HEADING_2', transcript: true }, ...lines(2)]);
    await h.advance(20_000);
    expect(h.ai.rewriteCalls.length).toBe(before); // still waiting: only transcript lines so far
    await h.advance(30_000);
    expect(h.ai.rewriteCalls.length).toBe(before + 1); // one call for both lines
    h.docs.set(['Cells need energy', 'ATP is the energy currency', { text: TRANSCRIPT_HEADING, style: 'HEADING_2', transcript: true }, ...lines(3)]);
    await h.advance(12_000);
    expect(h.ai.rewriteCalls.length).toBe(before + 2); // a typed note does not wait
    h.engine.stop();
  });

  it('lines the model leaves out are not forced into the notes or shown as unorganized', async () => {
    const h = createHarness();
    h.docs.set(['Cells need energy', { text: TRANSCRIPT_HEADING, style: 'HEADING_2', transcript: true }, { text: '[10:40] okay everyone settle down', transcript: true }, { text: '[10:41] cells need energy to survive', transcript: true }]);
    h.ai.onRewrite = (p: RewritePayload) => {
      const added = p.changes.added ?? [];
      const typed = added.find((b) => !b.recording)!;
      const useful = added.find((b) => b.text.includes('survive'))!;
      return { ops: [{ op: 'create_section', ref: 'new:s', title: 'Energy', parent: null }, { op: 'create_unit', ref: 'new:u', section: 'new:s', content: 'Cells need energy to survive.', origin: 'user', sources: [typed.id, useful.id] }] };
    };
    await h.engine.start();
    await h.advance(90_000);
    const doc = h.engine.state.organized;
    expect(Object.values(doc.units).map((u) => u.content)).toEqual(['Cells need energy to survive.']);
    expect(doc.sections[UNSORTED_SECTION_ID]).toBeUndefined();
    expect(h.ai.rewriteCalls.every((c) => !c.changes.unrepresented)).toBe(true);
    h.engine.stop();
  });
});
