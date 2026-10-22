import { useEffect, useRef, useState } from 'react';
import type { AudioSource } from '../../audio/recorder';
import { transcriptionOrigin, type Settings } from '../../core/settings';
import type { RecordingControls, RecordingView } from '../hooks/useRecording';
import { getSettings } from '../runtime';
import { useNow } from './NotesView';
import { Icon, cx } from './ui';

const SOURCE: Record<AudioSource, { label: string; icon: 'mic' | 'speaker'; hint: string }> = {
  mic: { label: 'Microphone', icon: 'mic', hint: 'A lecture or discussion in the room' },
  tab: { label: 'A tab’s audio', icon: 'speaker', hint: 'An online class or video in another tab' },
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

const toolbarBtn = 'np-focus inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium';

/** Toolbar control: Record ▾ (microphone or a tab's audio), or Stop while a recording runs. */
export function RecordButton({ rec, controls, onChoose }: { rec: RecordingView; controls: RecordingControls; onChoose: (source: AudioSource) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const phase = rec.state?.phase;
  if (rec.starting || phase === 'recording' || phase === 'finishing') {
    return (
      <button type="button" onClick={controls.stop} disabled={phase === 'finishing'} title={rec.starting ? 'Cancel starting recording' : 'Stop recording'} className={cx(toolbarBtn, 'bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-60 dark:bg-red-500/10 dark:text-red-300')}>
        <Icon name="stop" /> {rec.starting ? 'Cancel' : phase === 'finishing' ? 'Finishing…' : 'Stop'}
      </button>
    );
  }
  return (
    <div ref={box} className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Record a lecture: its transcript goes into your doc and your notes"
        className={cx(toolbarBtn, open ? 'bg-ink-100 text-ink-900 dark:bg-ink-800 dark:text-white' : 'text-ink-500 hover:bg-ink-100 dark:text-ink-400 dark:hover:bg-ink-800', 'disabled:opacity-60')}
      >
        <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden /> Record
      </button>
      {open && (
        <div role="menu" aria-label="Record from" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-ink-200 bg-white p-1 font-sans shadow-lg dark:border-ink-700 dark:bg-ink-900">
          {(Object.keys(SOURCE) as AudioSource[]).map((source) => (
            <button
              key={source}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onChoose(source);
              }}
              className="np-focus flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-ink-50 dark:hover:bg-ink-800"
            >
              <Icon name={SOURCE[source].icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
              <span>
                <span className="block text-[12px] font-medium text-ink-900 dark:text-ink-50">{SOURCE[source].label}</span>
                <span className="block text-[11px] text-ink-400">{SOURCE[source].hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Under the toolbar: the one-time agreement, the running recording, or what went wrong. */
export function RecordStrip({
  rec,
  controls,
  asking,
  settings,
  onAllow,
  onCancel,
}: {
  rec: RecordingView;
  controls: RecordingControls;
  asking: AudioSource | null;
  settings: Settings;
  onAllow: () => void;
  onCancel: () => void;
}) {
  const running = rec.state?.phase === 'recording' || rec.state?.phase === 'finishing';
  const now = useNow(running ? 1000 : 60_000);
  const shell = 'mx-4 mt-3 rounded-lg border px-3 py-2.5 font-sans text-[12px] leading-snug';
  const origin = transcriptionOrigin(settings);

  if (asking && !origin) {
    return (
      <section aria-label="Before recording" role="alert" className={cx(shell, 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100')}>
        <p>
          {settings.ai.mode === 'device' && settings.recording.endpoint === 'same'
            ? 'Choose a transcription service in Settings → Recording before recording. The on-device AI cannot transcribe audio.'
            : 'Enter a valid transcription service address in Settings → Recording before recording.'}
        </p>
        <button type="button" onClick={onCancel} className="np-focus mt-2 rounded-md px-2.5 py-1 text-[11.5px] font-medium hover:bg-amber-100 dark:hover:bg-amber-400/10">Dismiss</button>
      </section>
    );
  }

  if (asking) {
    return (
      <section aria-label="Before recording" className={cx(shell, 'border-ink-200 bg-ink-50/70 text-ink-700 dark:border-ink-800 dark:bg-ink-900/60 dark:text-ink-300')}>
        <p>
          <strong className="font-semibold text-ink-900 dark:text-ink-50">Record only with permission.</strong> NotePilot sends the audio to {origin} to be
          transcribed, adds the transcript to the end of this Google Doc (in its first tab), and puts its key points into your notes. The audio is not saved. The transcript stays in the doc for
          anyone it is shared with, and its text goes to the AI along with your notes.
        </p>
        <p className="mt-1.5">Record a teacher’s lecture with the teacher’s OK, not class discussions or classmates, and follow your school’s rules on recordings and AI.</p>
        <p className="mt-1.5 text-[11.5px] text-ink-500">
          Next, Google asks to let NotePilot “see, edit, create and delete all your Google Docs”. NotePilot only ever adds lines to this doc’s transcript section.
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => {
            if (transcriptionOrigin(getSettings()) === origin) onAllow(); // consent is only for the address shown here
            else onCancel();
          }} className="np-focus rounded-md bg-ink-900 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-ink-700 dark:bg-white dark:text-ink-900">
            Allow and record
          </button>
          <button type="button" onClick={onCancel} className="np-focus rounded-md px-2.5 py-1 text-[11.5px] font-medium text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800">
            Cancel
          </button>
        </div>
      </section>
    );
  }

  if (rec.error && !rec.state) {
    return (
      <section aria-label="Recording" role="alert" className={cx(shell, 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100')}>
        <p>{rec.error}</p>
        <div className="mt-2 flex gap-2">
          {rec.micBlocked && (
            <button type="button" onClick={controls.openMicPage} className="np-focus rounded-md bg-ink-900 px-2.5 py-1 text-[11.5px] font-medium text-white dark:bg-white dark:text-ink-900">
              Allow microphone
            </button>
          )}
          <button type="button" onClick={controls.dismiss} className="np-focus rounded-md px-2.5 py-1 text-[11.5px] font-medium hover:bg-amber-100 dark:hover:bg-amber-400/10">
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  const st = rec.state;
  if (!st) return null;
  const lines = `${st.lines} ${st.lines === 1 ? 'line' : 'lines'} added to your doc`;
  return (
    <section aria-label="Recording" className={cx(shell, running ? 'border-red-200 bg-red-50/60 dark:border-red-500/30 dark:bg-red-500/10' : 'border-ink-200 bg-ink-50/70 dark:border-ink-800 dark:bg-ink-900/60', 'text-ink-700 dark:text-ink-300')}>
      <p className="flex flex-wrap items-center gap-x-1.5" role="status">
        {running && <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />}
        <strong className="font-semibold text-ink-900 dark:text-ink-50">{st.phase === 'recording' ? 'Recording' : st.phase === 'finishing' ? 'Finishing the last lines' : 'Recording stopped'}</strong>
        <span className="text-ink-400">·</span>
        <span>{SOURCE[st.source].label}</span>
        {running && (
          <>
            <span className="text-ink-400">·</span>
            <span className="tabular-nums">{clock(now - st.startedAt)}</span>
          </>
        )}
        <span className="text-ink-400">·</span>
        <span>{lines}</span>
        {st.pending > 0 && <span className="text-ink-400">(transcribing…)</span>}
      </p>
      {st.lastLine && <p className="mt-1 truncate text-[11.5px] text-ink-500" title={st.lastLine}>{st.lastLine}</p>}
      {running && <p className="mt-1 text-[11px] text-ink-400">Keep this panel open: closing it ends the recording.</p>}
      {st.error && <p className="mt-1 text-[11.5px] text-amber-800 dark:text-amber-200">{st.error}</p>}
      {st.phase === 'stopped' && (
        <button type="button" onClick={controls.dismiss} className="np-focus mt-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-medium text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800">
          Dismiss
        </button>
      )}
    </section>
  );
}
