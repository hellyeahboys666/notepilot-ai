import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentRecorder, type RecorderEnv, type Segment } from '../src/audio/recorder';

class FakeTrack extends EventTarget {
  stopCount = 0;
  recorders = new Set<FakeMediaRecorder>();

  stop(): void {
    this.stopCount++;
  }

  end(): void {
    for (const rec of this.recorders) rec.stop();
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type: string): boolean {
    return type === 'audio/webm;codecs=opus';
  }

  state: RecordingState = 'inactive';
  readonly mimeType: string;
  private readonly track: FakeTrack;
  private readonly id: number;
  private static nextId = 0;

  static resetIds(): void {
    FakeMediaRecorder.nextId = 0;
  }

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.track = stream.getAudioTracks()[0] as unknown as FakeTrack;
    this.track.recorders.add(this);
    this.mimeType = options?.mimeType ?? '';
    this.id = ++FakeMediaRecorder.nextId;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    setTimeout(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([String(this.id)]) }));
      this.dispatchEvent(new Event('stop'));
    }, 10);
  }
}

function setup(minMs?: number) {
  const track = new FakeTrack();
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const segments: Segment[] = [];
  const onEnded = vi.fn(() => segments.length);
  const env: RecorderEnv = {
    MediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id) => clearInterval(id),
  };
  const recorder = new SegmentRecorder(stream, { segmentMs: 2000, minMs, onSegment: (part) => segments.push(part), onEnded }, env);
  recorder.start();
  return { recorder, track, segments, onEnded };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  FakeMediaRecorder.resetIds();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SegmentRecorder', () => {
  it('delivers standalone segments in boundary order', async () => {
    const { recorder, segments } = setup();
    await vi.advanceTimersByTimeAsync(4010);
    expect(await Promise.all(segments.map((part) => part.blob.text()))).toEqual(['1', '2']);
    expect(segments.map((part) => part.startedAt)).toEqual([0, 2000]);
    expect(segments.map((part) => part.seconds)).toEqual([2, 2]);
    expect(segments.every((part) => part.heard && part.blob.type === 'audio/webm;codecs=opus')).toBe(true);
    const stopped = recorder.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
  });

  it('waits for the boundary segment and final segment when stopped immediately after a cut', async () => {
    const { recorder, segments } = setup(0);
    vi.advanceTimersByTime(2000);
    const stopped = recorder.stop();
    let resolved = false;
    void stopped.then(() => { resolved = true; });
    expect(segments).toHaveLength(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
    expect(resolved).toBe(true);
    expect(await Promise.all(segments.map((part) => part.blob.text()))).toEqual(['1', '2']);
  });

  it('delivers a partial segment when the track ends and calls onEnded once', async () => {
    const { track, segments, onEnded } = setup();
    vi.advanceTimersByTime(1700);
    track.end();
    track.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(await Promise.all(segments.map((part) => part.blob.text()))).toEqual(['1']);
    expect(segments[0]).toMatchObject({ startedAt: 0, seconds: 1.7, heard: true });
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded.mock.results[0].value).toBe(1);
  });

  it('drops a tail shorter than minMs', async () => {
    const { recorder, segments } = setup();
    vi.advanceTimersByTime(1000);
    const stopped = recorder.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
    expect(segments).toEqual([]);
  });

  it('stops the tracks after flushing', async () => {
    const { recorder, track } = setup();
    vi.advanceTimersByTime(1600);
    const stopped = recorder.stop();
    expect(track.stopCount).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
    expect(track.stopCount).toBe(1);
  });
});
