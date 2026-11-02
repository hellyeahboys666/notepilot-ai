import { useCallback, useEffect, useRef, useState } from 'react';
import { AIError } from '../../ai/client';
import { transcribe, transcriptionUrl } from '../../ai/transcribe';
import { AudioSourceError, openAudio, SegmentRecorder, type AudioSource } from '../../audio/recorder';
import { RecordingSession, type RecordingState } from '../../audio/session';
import { transcriptionOrigin, type Settings } from '../../core/settings';
import { auth, TRANSCRIPT_SCOPES } from '../../google/auth';
import { gateFor, getSettings, requestTranscriptionPermission, transcriptWriter, usage } from '../runtime';

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
  /** Records that the user agreed audio may go to the current transcription service. */
  allow(update: (fn: (s: Settings) => Settings) => void): void;
  openMicPage(): void;
  /** The input's current loudness for the level meter, or null when not recording. */
  level(): number | null;
}

const GATE_MESSAGE: Record<string, string> = {
  not_configured: 'Connect an AI provider in Settings first.',
  no_consent: 'Allow NotePilot to send notes to your AI provider first (Settings).',
  excluded: 'This document is excluded from AI processing.',
  needs_approval: 'Approve this document for AI processing first.',
  budget: 'Daily cost limit reached. Raise it in Settings → Cost limits.',
  disabled: 'Processing is paused.',
};

export const needsRecordingConsent = (s: Settings) => !transcriptionOrigin(s) || s.recordingConsent?.endpointOrigin !== transcriptionOrigin(s);

const stopStream = (stream: MediaStream | null) => stream?.getTracks().forEach((t) => t.stop());

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

/** One lecture recording at a time, for the whole panel; it keeps writing to the doc it started on. */
export function useRecording(): [RecordingView, RecordingControls] {
  const [view, setView] = useState<RecordingView>({ state: null, starting: false, error: null, micBlocked: false });
  const live = useRef<{ recorder: SegmentRecorder; session: RecordingSession } | null>(null);
  const pending = useRef<{ cancelled: boolean; stream: MediaStream | null } | null>(null);

  const cancelPending = useCallback(() => {
    const attempt = pending.current;
    if (!attempt) return;
    attempt.cancelled = true;
    stopStream(attempt.stream);
    pending.current = null;
  }, []);

  const finish = useCallback(async () => {
    cancelPending();
    setView((v) => v.starting ? { ...v, starting: false } : v);
    const cur = live.current;
    if (!cur) return;
    await cur.recorder.stop();
    cur.session.finish();
  }, [cancelPending]);

  // Closing the panel ends the recording (the panel is what records).
  useEffect(() => {
    const end = () => {
      cancelPending();
      void live.current?.recorder.stop();
    };
    window.addEventListener('pagehide', end);
    return () => {
      window.removeEventListener('pagehide', end);
      end();
    };
  }, [cancelPending]);

  const start = useCallback(
    (source: AudioSource, docId: string) => {
      if (pending.current || (live.current && live.current.session.state.phase !== 'stopped')) return;
      const settings = getSettings();
      try {
        transcriptionUrl(settings.ai, settings.recording); // explain missing services and keys before opening any audio
        if (needsRecordingConsent(settings)) throw new AIError('auth', 'Allow audio to be sent to the transcription service before recording.');
      } catch (e) {
        return setView((v) => ({ ...v, error: e instanceof Error ? e.message : 'Choose a transcription service in Settings → Recording.', micBlocked: false }));
      }
      const gate = gateFor(docId, { manual: true });
      if (!gate.ok) return setView((v) => ({ ...v, error: GATE_MESSAGE[gate.reason] ?? 'AI processing is not available.', micBlocked: false }));
      const origin = transcriptionOrigin(settings);
      const checkConsent = () => {
        const current = getSettings();
        if (transcriptionOrigin(current) !== origin || needsRecordingConsent(current))
          throw new AIError('auth', 'The transcription service or recording consent changed. Record again to allow the current service.');
      };
      const attempt = { cancelled: false, stream: null as MediaStream | null };
      pending.current = attempt;
      setView({ state: null, starting: true, error: null, micBlocked: false });
      // Both prompts need this click. No recorder starts until Chrome has allowed the transcription host.
      const permission = requestTranscriptionPermission(settings);
      const audio = openAudio(source).then(
        (stream) => {
          attempt.stream = stream;
          if (attempt.cancelled) stopStream(stream);
          return { stream };
        },
        (error: unknown) => ({ error }),
      );
      void (async () => {
        try {
          if (!(await permission)) throw new Error(`Chrome permission to contact ${origin} was not granted. Allow it before recording.`);
          if (attempt.cancelled) return;
          checkConsent();
          const media = await audio;
          if (attempt.cancelled) return;
          if ('error' in media) throw media.error;
          checkConsent();
          try {
            await auth.getToken(true, TRANSCRIPT_SCOPES);
          } catch (e) {
            throw new Error(`${e instanceof Error ? e.message : 'Google permission was not granted'}. NotePilot needs it to add the transcript to your doc.`);
          }
          if (attempt.cancelled) return;
          checkConsent();
          let secondsToCount: number | null = null;
          const session: RecordingSession = new RecordingSession(
            docId,
            source,
            {
              transcribe: async (audio, prompt, signal) => {
                checkConsent(); // a new host or withdrawn consent must also stop queued segments and retries
                if (secondsToCount !== null) {
                  usage.recordAudio(secondsToCount, settings.recording.pricePerMinute);
                  secondsToCount = null; // retries of this segment are counted only once
                }
                return transcribe(settings.ai, settings.recording, audio, { prompt, signal });
              },
              write: (id, line, signal) => transcriptWriter.append(id, line, signal),
              spend: (seconds) => {
                if (usage.overBudget(getSettings().dailyBudgetUSD)) return false;
                secondsToCount = seconds; // count it only after consent is checked, just before sending
                return true;
              },
              now: () => Date.now(),
              sleep,
              locale: navigator.language,
            },
            (state) => setView((v) => ({ ...v, state })),
            () => void finish(),
          );
          const recorder = new SegmentRecorder(media.stream, {
            segmentMs: settings.recording.segmentSeconds * 1000,
            onSegment: (seg) => session.push(seg),
            onEnded: () => session.finish(),
          });
          live.current = { recorder, session };
          recorder.start();
          setView({ state: session.state, starting: false, error: null, micBlocked: false });
        } catch (e) {
          if (attempt.cancelled) return;
          attempt.cancelled = true;
          stopStream(attempt.stream); // a late media prompt result is stopped by its handler, too
          live.current = null;
          const err = e instanceof AudioSourceError ? e : null;
          setView({ state: null, starting: false, error: e instanceof Error ? e.message : 'Could not start recording.', micBlocked: err?.kind === 'mic_blocked' });
        } finally {
          if (pending.current === attempt) pending.current = null;
        }
      })();
    },
    [finish],
  );

  const controls: RecordingControls = {
    start,
    stop: () => void finish(),
    dismiss: () => {
      cancelPending();
      setView((v) => (v.state?.phase === 'recording' || v.state?.phase === 'finishing' ? { ...v, error: null } : { state: null, starting: false, error: null, micBlocked: false }));
    },
    allow: (update) => update((s) => {
      const origin = transcriptionOrigin(s);
      return origin ? { ...s, recordingConsent: { endpointOrigin: origin, at: Date.now() } } : s;
    }),
    openMicPage: () => void chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') }),
    level: () => live.current?.recorder.level ?? null,
  };
  return [view, controls];
}
