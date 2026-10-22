import { assertTranscriptOnly, planTranscriptAppend, snapshotOf, type EndShape } from '../core/transcript';
import { AuthRequiredError, TRANSCRIPT_SCOPES, type AuthProvider } from './auth';

/**
 * The one module that writes to a Google Doc: it appends lecture-transcript lines to NotePilot's own section at the
 * end of the document's first tab (see core/transcript.ts). Each append reads the first tab's paragraphs and the
 * section's named range, plans the insertion, checks that the plan only inserts and styles its own new text, and sends
 * it with the revision it was planned against, so Docs merges it with whatever the user typed in the meantime.
 * A line that is already the section's last line is not written again, so retrying after a lost reply is safe.
 *
 * The write permission (the full Docs scope) is asked for only when the user starts a recording.
 */

const API = 'https://docs.googleapis.com/v1/documents/';
const FIELDS = 'revisionId,namedRanges,body(content(startIndex,endIndex,paragraph(elements(textRun(content)))))';

/** `conflict`: the section did not take the last line in, so a new line could land out of order. */
export type WriteErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate_limit' | 'server' | 'network' | 'conflict';

export class TranscriptWriteError extends Error {
  constructor(
    readonly kind: WriteErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TranscriptWriteError';
  }
}

export interface TranscriptWriter {
  append(docId: string, line: string, signal?: AbortSignal): Promise<void>;
}

export function createTranscriptWriter(auth: AuthProvider, fetchImpl: typeof fetch = (...a) => fetch(...a)): TranscriptWriter {
  const written = new Map<string, string>(); // the last line written to each doc
  async function call<T>(method: 'GET' | 'POST', url: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let token: string;
    try {
      token = await auth.getToken(false, TRANSCRIPT_SCOPES);
    } catch (e) {
      throw new TranscriptWriteError('auth', e instanceof AuthRequiredError ? e.message : 'Permission to add the transcript to your doc is missing');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal,
          cache: 'no-store',
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new TranscriptWriteError('network', 'Could not reach Google Docs');
      }
      if (res.ok) return (await res.json()) as T;
      if (res.status === 401 && attempt === 0) {
        await auth.invalidate(token);
        token = await auth.getToken(false, TRANSCRIPT_SCOPES).catch(() => '');
        if (token) continue;
      }
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        /* ignore */
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
      if (res.status === 401) throw new TranscriptWriteError('auth', 'Google sign-in expired');
      if (res.status === 429 || (res.status === 403 && /rate|quota/i.test(detail))) throw new TranscriptWriteError('rate_limit', 'Google Docs is busy', retryAfterMs ?? 10_000);
      if (res.status === 403) throw new TranscriptWriteError('forbidden', 'You can view this doc but not edit it, so the transcript cannot be added to it');
      if (res.status === 404) throw new TranscriptWriteError('not_found', 'The doc was not found');
      throw new TranscriptWriteError('server', detail || `Google Docs error ${res.status}`, retryAfterMs);
    }
    throw new TranscriptWriteError('auth', 'Google sign-in expired');
  }

  return {
    async append(docId, line, signal) {
      const id = encodeURIComponent(docId);
      // Without includeTabsContent, `body` and `namedRanges` are the first tab's, and requests without a tabId apply to it.
      const doc = await call<EndShape>('GET', `${API}${id}?fields=${FIELDS}`, null, signal);
      const snapshot = snapshotOf(doc);
      if (snapshot.lastLine === line) return void written.set(docId, line); // already there (a retry after a lost reply)
      const previous = written.get(docId);
      if (previous && snapshot.range && snapshot.after === previous && snapshot.lastLine !== previous) {
        throw new TranscriptWriteError('conflict', 'The transcript section in the doc stopped growing, so new lines could end up out of order');
      }
      const requests = planTranscriptAppend(snapshot, line);
      assertTranscriptOnly(requests, snapshot);
      await call('POST', `${API}${id}:batchUpdate`, { requests, ...(snapshot.revisionId ? { writeControl: { targetRevisionId: snapshot.revisionId } } : {}) }, signal);
      written.set(docId, line);
    },
  };
}
