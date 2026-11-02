import { transcriptLine } from '../core/transcript';
import type { AudioSource, Segment } from './recorder';

/**
 * One recording: segments in, transcript lines out. Segments are handled strictly in order (a line never overtakes the
 * one before it): transcribe, tidy, append to the doc's transcript section. The end of the previous line is passed to
 * the transcriber so a sentence cut between segments stays consistent. Silent segments are skipped, not sent.
 */

export type RecordingPhase = 'recording' | 'finishing' | 'stopped';

export interface RecordingState {
  phase: RecordingPhase;
  source: AudioSource;
  docId: string;
  startedAt: number;
  /** Lines written to the doc. */
  lines: number;
  /** Segments waiting to be transcribed or written. */
  pending: number;
  /** Silent segments that were not sent. */
  skipped: number;
  /** Unheard segments in a row: a microphone set too low, or a muted tab. */
  quietInRow: number;
  lastLine: string;
  /** Why the recording stopped or a segment was lost; null while all is well. */
  error: string | null;
}

export interface SessionDeps {
  transcribe(audio: Blob, prompt: string, signal: AbortSignal): Promise<{ text: string }>;
  write(docId: string, line: string, signal: AbortSignal): Promise<void>;
  /** Counts the seconds sent toward today's cost; false when the daily limit is reached. */
  spend(seconds: number): boolean;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  locale?: string;
}

/** An error the session can be told apart by: kind as in AIError / TranscriptWriteError. */
interface KindError {
  kind?: string;
  message?: string;
  retryAfterMs?: number;
}

const RETRYABLE = new Set(['rate_limit', 'server', 'network']);
// What speech-to-text commonly invents for near-silence or music.
const PHANTOM = /^(?:thank you(?: (?:so much|very much))?|thanks for watching|bye|you|\.+|♪+)[.!?]*$/i;

export class RecordingSession {
  private queue: Segment[] = [];
  private busy = false;
  private readonly ctl = new AbortController();
  private previous = '';
  /** Set once the session stopped itself: no further audio is sent (or paid for). */
  private closing = false;
  /** Parts lost in a row; three in a row stop the recording rather than let the backlog grow. */
  private lostInRow = 0;
  state: RecordingState;

  constructor(
    docId: string,
    source: AudioSource,
    private readonly deps: SessionDeps,
    private readonly onChange: (s: RecordingState) => void,
    /** Called when the session must stop recording by itself (doc not writable, cost limit, sign-in lost). */
    private readonly onFatal: () => void,
  ) {
    this.state = { phase: 'recording', source, docId, startedAt: deps.now(), lines: 0, pending: 0, skipped: 0, quietInRow: 0, lastLine: '', error: null };
  }

  push(segment: Segment): void {
    if (this.state.phase === 'stopped' || this.closing) return;
    if (!segment.heard) return this.update({ skipped: this.state.skipped + 1, quietInRow: this.state.quietInRow + 1 });
    this.queue.push(segment);
    this.update({ pending: this.queue.length + (this.busy ? 1 : 0), quietInRow: 0 });
    void this.pump();
  }

  /** No more segments will come; finishes the queue, then stops. */
  finish(): void {
    if (this.state.phase !== 'recording') return;
    this.update({ phase: this.busy || this.queue.length ? 'finishing' : 'stopped' });
  }

  /** Stops at once; segments not yet written are dropped. */
  cancel(): void {
    this.queue = [];
    this.ctl.abort();
    this.update({ phase: 'stopped', pending: 0 });
  }

  private update(p: Partial<RecordingState>): void {
    this.state = { ...this.state, ...p };
    this.onChange(this.state);
  }

  private fatal(message: string): void {
    this.closing = true;
    this.queue = [];
    this.update({ error: message, pending: this.busy ? 1 : 0 });
    this.onFatal();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let seg = this.queue.shift(); seg && !this.ctl.signal.aborted; seg = this.queue.shift()) {
        this.update({ pending: this.queue.length + 1 });
        await this.handle(seg);
      }
    } finally {
      this.busy = false;
      this.update({ pending: this.queue.length, ...(this.state.phase === 'finishing' && !this.queue.length ? { phase: 'stopped' as const } : {}) });
    }
  }

  private async handle(seg: Segment): Promise<void> {
    if (!this.deps.spend(seg.seconds)) return this.fatal('Recording stopped: today’s cost limit was reached. Raise it in Settings → Cost limits.');
    const text = await this.attempt(() => this.deps.transcribe(seg.blob, this.previous, this.ctl.signal).then((r) => r.text), 'transcribe');
    if (text === null) return;
    const words = text.replace(/\s+/g, ' ').trim();
    if (!words || PHANTOM.test(words)) return this.update({ skipped: this.state.skipped + 1 });
    const line = transcriptLine(words, seg.startedAt, this.deps.locale);
    const wrote = await this.attempt(() => this.deps.write(this.state.docId, line, this.ctl.signal).then(() => true), 'write');
    if (!wrote) return;
    this.previous = words;
    this.lostInRow = 0;
    this.update({ lines: this.state.lines + 1, lastLine: line, error: null });
  }

  /** Runs one step with up to three tries for passing problems; anything else ends the recording or skips the line. */
  private async attempt<T>(step: () => Promise<T>, what: 'transcribe' | 'write'): Promise<T | null> {
    for (let tryNo = 1; ; tryNo++) {
      try {
        return await step();
      } catch (e) {
        if (this.ctl.signal.aborted) return null;
        const err = (e ?? {}) as KindError;
        if (RETRYABLE.has(err.kind ?? '') && tryNo < 3) {
          await this.deps.sleep(Math.min(30_000, err.retryAfterMs ?? 2000 * tryNo), this.ctl.signal).catch(() => undefined);
          continue;
        }
        const reason = err.message || 'unknown error';
        if (what === 'write' && ['auth', 'forbidden', 'not_found', 'conflict'].includes(err.kind ?? '')) {
          this.fatal(`Recording stopped: the transcript could not be added to the doc (${reason}).`);
        } else if (what === 'transcribe' && err.kind === 'auth') {
          this.fatal(`Recording stopped: the AI provider refused the transcription (${reason}).`);
        } else if (err.kind === 'budget') {
          this.fatal(`Recording stopped: the AI budget is used up (${reason}).`);
        } else if (++this.lostInRow >= 3) {
          this.fatal(`Recording stopped: three parts in a row were lost (${reason}).`);
        } else {
          this.update({ error: `A part of the recording was lost (${reason}). Recording continues.` });
        }
        return null;
      }
    }
  }
}
