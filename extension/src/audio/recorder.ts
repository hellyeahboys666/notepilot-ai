/**
 * Lecture audio, cut into segments for transcription.
 *
 * Sources: the microphone (a lecture in the room), or a tab the user picks in Chrome's own "Choose what to share"
 * dialog (an online class or a video). Tab sharing keeps playing the sound for the user, and needs no extension
 * permission. Only the audio is used; the video track that the dialog requires is stopped at once.
 *
 * Each segment is its own complete recording: the recorder is stopped and restarted every few seconds, because the
 * pieces a running MediaRecorder hands out after the first cannot be decoded on their own. A level meter marks
 * segments in which nothing was heard, so silence is not sent (speech-to-text tends to invent words for it).
 * Audio exists only in memory until it is transcribed.
 */

export type AudioSource = 'mic' | 'tab';

export interface Segment {
  blob: Blob;
  startedAt: number;
  seconds: number;
  /** Something louder than background hiss was heard (always true when no level meter is available). */
  heard: boolean;
}

export class AudioSourceError extends Error {
  constructor(
    readonly kind: 'mic_blocked' | 'cancelled' | 'no_audio' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'AudioSourceError';
  }
}

/** Opens the chosen source. Must be called from a click (the share dialog and the microphone prompt need one). */
export async function openAudio(source: AudioSource, media: MediaDevices = navigator.mediaDevices): Promise<MediaStream> {
  if (!media?.getUserMedia) throw new AudioSourceError('unsupported', 'This browser cannot record audio here');
  if (source === 'mic') {
    try {
      return await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === 'NotFoundError') throw new AudioSourceError('no_audio', 'No microphone was found');
      throw new AudioSourceError('mic_blocked', 'Chrome has not allowed NotePilot to use the microphone');
    }
  }
  let stream: MediaStream;
  try {
    stream = await media.getDisplayMedia({
      video: true, // required by Chrome; stopped below
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch {
    throw new AudioSourceError('cancelled', 'No tab was shared');
  }
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new AudioSourceError('no_audio', 'The shared tab had no sound. Share it again and turn on "Also share tab audio".');
  }
  return new MediaStream(stream.getAudioTracks());
}

/** RMS loudness below which a stretch counts as unheard (background hiss, a muted tab, a microphone set far too low). */
export const QUIET_LEVEL = 0.012;

export interface RecorderEnv {
  MediaRecorder: typeof MediaRecorder;
  AudioContext?: typeof AudioContext;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export interface RecorderOptions {
  segmentMs: number;
  onSegment(segment: Segment): void;
  /** The source ended by itself (tab closed, sharing stopped, microphone unplugged). */
  onEnded(): void;
  /** RMS level that counts as hearing something; quieter segments are marked unheard. */
  quietLevel?: number;
  /** Segments shorter than this (the tail when stopping) are dropped. */
  minMs?: number;
}

const browserEnv = (): RecorderEnv => ({
  MediaRecorder,
  AudioContext: globalThis.AudioContext,
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
});

interface RecorderPart {
  startedAt: number;
  chunks: Blob[];
  stopped: Promise<void>;
  details: { seconds: number; heard: boolean } | null;
}

export class SegmentRecorder {
  private recorder: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array | null = null;
  private meter = 0;
  private cut = 0;
  private peak = 0;
  private current = 0;
  private done = false;
  private stopping: Promise<void> | null = null;
  private pending = new Set<Promise<void>>();
  private readonly mime: string;

  constructor(
    private readonly stream: MediaStream,
    private readonly opts: RecorderOptions,
    private readonly env: RecorderEnv = browserEnv(),
  ) {
    const R = env.MediaRecorder;
    this.mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => R.isTypeSupported?.(t)) ?? '';
  }

  start(): void {
    for (const t of this.stream.getAudioTracks()) t.addEventListener('ended', () => this.ended());
    if (this.env.AudioContext) {
      try {
        this.ctx = new this.env.AudioContext();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.samples = new Float32Array(this.analyser.fftSize);
        this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
        this.meter = this.env.setInterval(() => this.sample(), 200);
      } catch {
        this.analyser = null; // no meter: every segment counts as heard
      }
    }
    this.next();
  }

  /** Ends the recording. Resolves once every part has been delivered (if long enough). */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.done = true;
    this.env.clearTimeout(this.cut);
    this.env.clearInterval(this.meter);
    this.finish(this.recorder);
    this.recorder = null;
    this.stopping = Promise.all([...this.pending]).then(() => {
      this.stream.getTracks().forEach((t) => t.stop());
      void this.ctx?.close().catch(() => undefined);
    });
    return this.stopping;
  }

  private ended(): void {
    if (this.done) return;
    void this.stop().then(() => this.opts.onEnded());
  }

  private sample(): void {
    if (!this.analyser || !this.samples) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    this.current = Math.sqrt(sum / this.samples.length);
    this.peak = Math.max(this.peak, this.current);
  }

  /** The latest loudness (RMS; speech is roughly 0.02–0.2), or null when there is no level meter or it has stopped. */
  get level(): number | null {
    return this.analyser && !this.done ? this.current : null;
  }

  private next(): void {
    if (this.done) return;
    let rec: MediaRecorder;
    try {
      rec = new this.env.MediaRecorder(this.stream, { ...(this.mime ? { mimeType: this.mime } : {}), audioBitsPerSecond: 32_000 });
    } catch {
      this.ended();
      return;
    }
    const startedAt = this.env.now();
    const chunks: Blob[] = [];
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
    const np: RecorderPart = { startedAt, chunks, stopped, details: null };
    rec.addEventListener('dataavailable', (e) => {
      if (e.data?.size) chunks.push(e.data);
    });
    // A track can stop the recorder before finish runs, so listen from the start.
    rec.addEventListener('stop', () => {
      const { seconds, heard } = np.details ?? {
        seconds: (this.env.now() - startedAt) / 1000,
        heard: !this.analyser || this.peak >= (this.opts.quietLevel ?? QUIET_LEVEL),
      };
      try {
        if (chunks.length && seconds * 1000 >= (this.opts.minMs ?? 1500)) {
          this.opts.onSegment({ blob: new Blob(chunks, { type: rec.mimeType || this.mime || 'audio/webm' }), startedAt, seconds, heard });
        }
      } finally {
        resolveStop();
      }
    }, { once: true });
    (rec as MediaRecorder & { np?: RecorderPart }).np = np;
    this.peak = 0;
    rec.start();
    this.recorder = rec;
    this.cut = this.env.setTimeout(() => {
      this.finish(rec);
      this.next();
    }, this.opts.segmentMs);
  }

  /** Stops one recorder and hands its audio over once the browser has flushed it. */
  private finish(rec: MediaRecorder | null): Promise<void> {
    if (!rec) return Promise.resolve();
    const np = (rec as MediaRecorder & { np?: RecorderPart }).np!;
    np.details ??= {
      heard: !this.analyser || this.peak >= (this.opts.quietLevel ?? QUIET_LEVEL),
      seconds: (this.env.now() - np.startedAt) / 1000,
    };
    this.peak = 0;
    this.pending.add(np.stopped);
    void np.stopped.then(() => this.pending.delete(np.stopped));
    if (rec.state !== 'inactive') rec.stop();
    return np.stopped;
  }
}
