import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribe } from '../../ai/transcribe';
import { AudioSourceError, openAudio, SegmentRecorder, type AudioSource } from '../../audio/recorder';
import { RecordingSession, type RecordingState } from '../../audio/session';
import { endpointOrigin, type Settings } from '../../core/settings';
import { auth, TRANSCRIPT_SCOPES } from '../../google/auth';
import { gateFor, getSettings, transcriptWriter, usage } from '../runtime';

export interface RecordingView {
  state: RecordingState | null;
  starting: boolean;
  /** Why a recording could not start. */
  error: string | null;
  /** The microphone prompt could not be shown here: offer the one-time "Allow microphone" page. */
  micBlocked: boolean;
}

export interface RecordingControls {
  /** Call from a click: the share dialog and the microphone prompt need one. */
  start(source: AudioSource, docId: string): void;
  stop(): void;
  dismiss(): void;
  /** Records that the user agreed audio may go to the current AI endpoint. */
  allow(update: (fn: (s: Settings) => Settings) => void): void;
  openMicPage(): void;
}

const GATE_MESSAGE: Record<string, string> = {
  not_configured: 'Connect an AI provider in Settings first.',
  no_consent: 'Allow NotePilot to send notes to your AI provider first (Settings).',
  excluded: 'This document is excluded from AI processing.',
  needs_approval: 'Approve this document for AI processing first.',
  budget: 'Daily cost limit reached. Raise it in Settings → Cost limits.',
  disabled: 'Processing is paused.',
};

export const needsRecordingConsent = (s: Settings) => !s.recordingConsent || s.recordingConsent.endpointOrigin !== endpointOrigin(s.ai);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

/** One lecture recording at a time, for the whole panel; it keeps writing to the doc it started on. */
export function useRecording(): [RecordingView, RecordingControls] {
  const [view, setView] = useState<RecordingView>({ state: null, starting: false, error: null, micBlocked: false });
  const live = useRef<{ recorder: SegmentRecorder; session: RecordingSession } | null>(null);

  const finish = useCallback(async () => {
    const cur = live.current;
    if (!cur) return;
    await cur.recorder.stop();
    cur.session.finish();
  }, []);

  // Closing the panel ends the recording (the panel is what records).
  useEffect(() => {
    const end = () => void live.current?.recorder.stop();
    window.addEventListener('pagehide', end);
    return () => window.removeEventListener('pagehide', end);
  }, []);

  const start = useCallback(
    (source: AudioSource, docId: string) => {
      if (live.current && live.current.session.state.phase !== 'stopped') return;
      const gate = gateFor(docId, { manual: true });
      if (!gate.ok) return setView((v) => ({ ...v, error: GATE_MESSAGE[gate.reason] ?? 'AI processing is not available.', micBlocked: false }));
      setView({ state: null, starting: true, error: null, micBlocked: false });
      void (async () => {
        let stream: MediaStream;
        try {
          stream = await openAudio(source); // first: it needs the click
        } catch (e) {
          const err = e instanceof AudioSourceError ? e : null;
          return setView({ state: null, starting: false, error: err?.message ?? 'Could not start recording.', micBlocked: err?.kind === 'mic_blocked' });
        }
        try {
          await auth.getToken(true, TRANSCRIPT_SCOPES);
        } catch (e) {
          stream.getTracks().forEach((t) => t.stop());
          return setView({ state: null, starting: false, error: `${e instanceof Error ? e.message : 'Google permission was not granted'}. NotePilot needs it to add the transcript to your doc.`, micBlocked: false });
        }
        const session: RecordingSession = new RecordingSession(
          docId,
          source,
          {
            transcribe: (audio, prompt, signal) => {
              const s = getSettings();
              return transcribe(s.ai, s.recording, audio, { prompt, signal });
            },
            write: (id, line, signal) => transcriptWriter.append(id, line, signal),
            spend: (seconds) => {
              const s = getSettings();
              if (usage.overBudget(s.dailyBudgetUSD)) return false;
              usage.recordAudio(seconds, s.recording.pricePerMinute);
              return true;
            },
            now: () => Date.now(),
            sleep,
            locale: navigator.language,
          },
          (state) => setView((v) => ({ ...v, state })),
          () => void finish(),
        );
        const recorder = new SegmentRecorder(stream, {
          segmentMs: getSettings().recording.segmentSeconds * 1000,
          onSegment: (seg) => session.push(seg),
          onEnded: () => session.finish(),
        });
        live.current = { recorder, session };
        recorder.start();
        setView({ state: session.state, starting: false, error: null, micBlocked: false });
      })();
    },
    [finish],
  );

  const controls: RecordingControls = {
    start,
    stop: () => void finish(),
    dismiss: () => setView((v) => (v.state?.phase === 'recording' || v.state?.phase === 'finishing' ? { ...v, error: null } : { state: null, starting: false, error: null, micBlocked: false })),
    allow: (update) => update((s) => ({ ...s, recordingConsent: { endpointOrigin: endpointOrigin(s.ai), at: Date.now() } })),
    openMicPage: () => void chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') }),
  };
  return [view, controls];
}
