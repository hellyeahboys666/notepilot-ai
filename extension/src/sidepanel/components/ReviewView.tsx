import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_REVIEW, QUESTION_KINDS, type QuestionKind, type ReviewOptions, type ReviewQuestion } from '../../core/review';
import type { Settings } from '../../core/settings';
import { UNSORTED_SECTION_ID } from '../../core/types';
import type { EngineView } from '../../engine/state';
import type { ReviewControls, ReviewState } from '../hooks/useReview';
import { Markdown } from './Markdown';
import { Button, Icon, Segmented, cx } from './ui';

const card = 'mx-4 mt-3 overflow-hidden rounded-xl border border-ink-200/80 bg-white font-sans shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-ink-800 dark:bg-ink-900/40';

/** Review: a quiz on the notes, or a prompt that has another AI run one. */
export function ReviewView({ view, settings, state, controls, onGo }: { view: EngineView; settings: Settings; state: ReviewState; controls: ReviewControls; onGo: (sectionId: string) => void }) {
  const [options, setOptions] = useState<ReviewOptions>(DEFAULT_REVIEW);
  const doc = view.organized;
  if (!doc.rootSections.length) {
    return <p className="px-6 py-12 text-center font-sans text-[12.5px] text-ink-500">Once your notes are organized, you can test yourself on them here.</p>;
  }
  const { quiz } = state;
  if (!quiz) return <ReviewSetup view={view} settings={settings} state={state} controls={controls} options={options} setOptions={setOptions} />;

  const q = quiz.questions[state.index];
  if (!q) return <Results view={view} settings={settings} state={state} controls={controls} options={options} onGo={onGo} />;
  const answered = state.answers[q.id];
  const last = state.index === quiz.questions.length - 1;
  return (
    <div className="pb-10">
      <section aria-label="Quiz" className={card}>
        <header className="flex items-center gap-2 border-b border-ink-100 bg-ink-50/70 px-3.5 py-2 text-[11.5px] text-ink-500 dark:border-ink-800 dark:bg-ink-900/60">
          <span className="font-medium text-ink-800 dark:text-ink-100">
            Question {state.index + 1} of {quiz.questions.length}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={controls.close} className="np-focus rounded px-1.5 py-0.5 hover:bg-ink-100 dark:hover:bg-ink-800">
            End quiz
          </button>
        </header>
        <div className="h-1 bg-ink-100 dark:bg-ink-800" aria-hidden>
          <div className="h-full bg-accent-500 transition-[width]" style={{ width: `${(state.index / quiz.questions.length) * 100}%` }} />
        </div>
        <div className="space-y-3 px-3.5 pb-4 pt-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">{QUESTION_KINDS.find((k) => k.value === q.kind)?.label}</p>
          <QuestionBody key={q.id} q={q} answer={answered} controls={controls} />
          {answered && (answered.correct !== null || q.kind !== 'short') && <Feedback q={q} correct={answered.correct} doc={view.organized} onGo={onGo} />}
          {answered && answered.correct !== null && (
            <Button variant="primary" onClick={controls.next}>
              {last ? 'See results' : 'Next question'}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

function ReviewSetup({
  view,
  settings,
  state,
  controls,
  options,
  setOptions,
}: {
  view: EngineView;
  settings: Settings;
  state: ReviewState;
  controls: ReviewControls;
  options: ReviewOptions;
  setOptions: (o: ReviewOptions) => void;
}) {
  const doc = view.organized;
  const toggle = (k: QuestionKind) => {
    const kinds = options.kinds.includes(k) ? options.kinds.filter((x) => x !== k) : [...options.kinds, k];
    if (kinds.length) setOptions({ ...options, kinds: QUESTION_KINDS.map((x) => x.value).filter((x) => kinds.includes(x)) });
  };
  const writing = state.phase === 'writing';
  return (
    <div className="pb-10">
      <section aria-label="Review" className={card}>
        <header className="flex items-center gap-2.5 border-b border-ink-100 bg-ink-50/70 px-3.5 py-2 dark:border-ink-800 dark:bg-ink-900/60">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-50 text-accent-600 ring-1 ring-accent-100 dark:bg-accent-500/10 dark:text-accent-300 dark:ring-accent-500/20">
            <Icon name="practice" />
          </span>
          <div className="leading-tight">
            <h2 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50">Test yourself</h2>
            <p className="text-[10.5px] text-ink-400">Questions on your organized notes</p>
          </div>
        </header>
        <div className="space-y-3.5 px-3.5 pb-4 pt-3 text-[12px] text-ink-700 dark:text-ink-300">
          <Option label="Questions">
            <Segmented size="sm" label="Number of questions" value={String(options.count)} onChange={(v) => setOptions({ ...options, count: Number(v) })} options={['5', '10', '15', '20'].map((v) => ({ value: v, label: v }))} />
          </Option>
          <Option label="Kinds">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kinds of question">
              {QUESTION_KINDS.map((k) => {
                const on = options.kinds.includes(k.value);
                return (
                  <button
                    key={k.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(k.value)}
                    className={cx(
                      'np-focus inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium ring-1 transition-colors',
                      on ? 'bg-accent-50 text-accent-700 ring-accent-300 dark:bg-accent-500/10 dark:text-accent-200 dark:ring-accent-500/40' : 'text-ink-500 ring-ink-200 hover:bg-ink-50 dark:ring-ink-700 dark:hover:bg-ink-800',
                    )}
                  >
                    {on && <Icon name="check" className="h-3 w-3" />}
                    {k.label}
                  </button>
                );
              })}
            </div>
          </Option>
          <Option label="Cover">
            <select
              aria-label="Which notes to cover"
              className="np-focus h-7 w-full rounded-md border border-ink-200 bg-white px-2 text-[12px] dark:border-ink-700 dark:bg-ink-900"
              value={options.sectionIds[0] ?? ''}
              onChange={(e) => setOptions({ ...options, sectionIds: e.target.value ? [e.target.value] : [] })}
            >
              <option value="">All my notes</option>
              {doc.rootSections
                .filter((id) => doc.sections[id] && id !== UNSORTED_SECTION_ID)
                .map((id) => (
                  <option key={id} value={id}>
                    {doc.sections[id].title}
                  </option>
                ))}
            </select>
          </Option>

          <div className="grid gap-2 border-t border-ink-100 pt-3.5 dark:border-ink-800">
            <div>
              <Button variant="primary" onClick={() => controls.start(view, settings, options)} disabled={writing} className="w-full">
                {writing ? 'Writing your quiz…' : 'Start quiz'}
              </Button>
              <p className="mt-1 text-[11px] leading-snug text-ink-400">Uses your AI connection once to write the questions. Answering and retrying are free.</p>
            </div>
            <div>
              <Button onClick={() => controls.copyPrompt(view, settings, options)} className="w-full">
                <Icon name="copy" /> {state.copiedAt ? 'Copied' : 'Copy a review prompt'}
              </Button>
              <p className="mt-1 text-[11px] leading-snug text-ink-400">
                Free: paste it into ChatGPT, Claude or Gemini and it quizzes you there, with your notes included. Uses none of your API.
              </p>
            </div>
          </div>
          <CopyFeedback state={state} />
          {state.error && <p role="alert" className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11.5px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{state.error}</p>}
        </div>
      </section>
    </div>
  );
}

/** "Copied", or the prompt to copy by hand when Chrome refused the clipboard. */
function CopyFeedback({ state }: { state: ReviewState }) {
  return (
    <>
      {state.copiedAt > 0 && <p role="status" className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11.5px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">Copied. Paste it into a chat with any AI to start your review.</p>}
      {state.promptText && (
        <div className="space-y-1">
          <p className="text-[11.5px] text-amber-800 dark:text-amber-200">Chrome didn't allow copying. Select the text below and copy it yourself:</p>
          <textarea readOnly aria-label="Review prompt" value={state.promptText} onFocus={(e) => e.currentTarget.select()} className="np-focus h-32 w-full rounded-md border border-ink-200 bg-ink-50 p-2 font-mono text-[10.5px] dark:border-ink-700 dark:bg-ink-900" />
        </div>
      )}
    </>
  );
}

function Option({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11.5px] font-medium text-ink-600 dark:text-ink-300">{label}</p>
      {children}
    </div>
  );
}

function QuestionBody({ q, answer, controls }: { q: ReviewQuestion; answer?: { given: string; correct: boolean | null }; controls: ReviewControls }) {
  const [text, setText] = useState('');
  const done = !!answer;
  const prompt = <div className="text-[13.5px] font-medium leading-snug text-ink-900 dark:text-ink-50"><Markdown text={q.prompt} className="np-inline" markFills={false} /></div>;

  if (q.kind === 'mc' || q.kind === 'tf') {
    const choices = q.kind === 'tf' ? ['true', 'false'] : q.choices;
    return (
      <div className="space-y-2.5">
        {prompt}
        <div className={cx('grid gap-1.5', q.kind === 'tf' && 'grid-cols-2')}>
          {choices.map((c, i) => {
            const right = done && c === q.answer;
            const wrong = done && c === answer.given && !right;
            return (
              <button
                key={c}
                type="button"
                disabled={done}
                onClick={() => controls.answer(q.id, c)}
                className={cx(
                  'np-focus flex items-start gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] ring-1 transition-colors',
                  right ? 'bg-emerald-50 text-emerald-900 ring-emerald-300 dark:bg-emerald-500/10 dark:text-emerald-100 dark:ring-emerald-500/40' : wrong ? 'bg-red-50 text-red-900 ring-red-300 dark:bg-red-500/10 dark:text-red-100 dark:ring-red-500/40' : 'text-ink-800 ring-ink-200 hover:bg-ink-50 disabled:hover:bg-transparent dark:text-ink-100 dark:ring-ink-700 dark:hover:bg-ink-800',
                  done && !right && !wrong && 'opacity-60',
                )}
              >
                {q.kind === 'mc' && <span className="font-semibold text-ink-400">{'ABCDEFGH'[i]}</span>}
                <span className="min-w-0 flex-1">{q.kind === 'tf' ? (c === 'true' ? 'True' : 'False') : c}</span>
                {right && <Icon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                {(right || wrong) && <span className="sr-only">{right ? ' (correct answer)' : ' (your answer, wrong)'}</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (q.kind === 'fill') {
    return (
      <form
        className="space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) controls.answer(q.id, text);
        }}
      >
        {prompt}
        <div className="flex gap-2">
          <input
            aria-label="Your answer"
            value={done ? answer.given : text}
            disabled={done}
            onChange={(e) => setText(e.target.value)}
            placeholder="The missing words"
            className="np-focus h-8 min-w-0 flex-1 rounded-md border border-ink-200 bg-white px-2.5 text-[12.5px] dark:border-ink-700 dark:bg-ink-900"
          />
          {!done && (
            <Button type="submit" variant="primary" disabled={!text.trim()}>
              Check
            </Button>
          )}
        </div>
      </form>
    );
  }

  // Short answer: write it, see the model answer, then mark it yourself.
  return (
    <div className="space-y-2.5">
      {prompt}
      <textarea
        aria-label="Your answer"
        value={done ? answer.given : text}
        disabled={done}
        onChange={(e) => setText(e.target.value)}
        placeholder="Answer in a sentence or two"
        className="np-focus h-20 w-full rounded-md border border-ink-200 bg-white p-2.5 text-[12.5px] dark:border-ink-700 dark:bg-ink-900"
      />
      {!done && <Button onClick={() => controls.answer(q.id, text)}>Show the answer</Button>}
      {done && (
        <div className="space-y-2 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] ring-1 ring-ink-200 dark:bg-ink-900 dark:ring-ink-700">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">A good answer</p>
          <Markdown text={q.answer} className="np-prose-sm" markFills={false} />
          {answer.correct === null && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11.5px] text-ink-500">Did you get it?</span>
              <Button size="sm" onClick={() => controls.mark(q.id, true)}>
                Yes
              </Button>
              <Button size="sm" onClick={() => controls.mark(q.id, false)}>
                Not quite
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Feedback({ q, correct, doc, onGo }: { q: ReviewQuestion; correct: boolean | null; doc: EngineView['organized']; onGo: (id: string) => void }) {
  const answerText = q.kind === 'tf' ? (q.answer === 'true' ? 'True' : 'False') : q.answer;
  // The answer buttons are disabled once answered: keep keyboard focus here rather than losing it to the page.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="status"
      className={cx(
        'space-y-1 rounded-lg px-3 py-2 text-[12px] ring-1 focus:outline-none',
        correct ? 'bg-emerald-50/70 text-emerald-900 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-100 dark:ring-emerald-500/30' : 'bg-amber-50/70 text-amber-900 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-100 dark:ring-amber-400/30',
      )}
    >
      <p className="font-semibold">{correct ? 'Correct!' : q.kind === 'short' ? 'Worth another look.' : `Not quite. The answer is: ${answerText}`}</p>
      {q.explanation && <p className="leading-snug">{q.explanation}</p>}
      <SectionLinks ids={q.sectionIds} doc={doc} onGo={onGo} />
    </div>
  );
}

function SectionLinks({ ids, doc, onGo }: { ids: string[]; doc: EngineView['organized']; onGo: (id: string) => void }) {
  const live = ids.filter((id) => doc.sections[id]);
  if (!live.length) return null;
  return (
    <p className="flex flex-wrap items-center gap-1 pt-0.5 text-[11px]">
      <span className="opacity-70">In your notes:</span>
      {live.map((id) => (
        <button key={id} type="button" onClick={() => onGo(id)} className="np-focus max-w-[12rem] truncate rounded bg-white/80 px-1.5 py-px font-medium text-accent-700 ring-1 ring-ink-200 hover:bg-accent-50 dark:bg-ink-950 dark:text-accent-300 dark:ring-ink-700">
          {doc.sections[id].title}
        </button>
      ))}
    </p>
  );
}

function Results({ view, settings, state, controls, options, onGo }: { view: EngineView; settings: Settings; state: ReviewState; controls: ReviewControls; options: ReviewOptions; onGo: (id: string) => void }) {
  const questions = state.quiz!.questions;
  const right = questions.filter((q) => state.answers[q.id]?.correct === true).length;
  const missed = questions.filter((q) => state.answers[q.id]?.correct === false);
  const pct = Math.round((right / questions.length) * 100);
  const missedSections = [...new Set(missed.flatMap((q) => q.sectionIds))];
  return (
    <div className="pb-10">
      <section aria-label="Results" className={card}>
        <div className="space-y-3 px-3.5 pb-4 pt-4 text-[12px] text-ink-700 dark:text-ink-300">
          <div className="flex items-baseline gap-2">
            <span className="text-[28px] font-semibold tabular-nums leading-none text-ink-900 dark:text-ink-50">
              {right}/{questions.length}
            </span>
            <span className="text-ink-500">{pct >= 90 ? 'Excellent!' : pct >= 70 ? 'Good work.' : pct >= 50 ? 'Getting there.' : 'Keep reviewing.'}</span>
          </div>
          {missed.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Review these</p>
              <ul className="space-y-1.5">
                {missed.map((q) => (
                  <li key={q.id} className="rounded-md bg-amber-50/60 px-2.5 py-1.5 ring-1 ring-amber-200/60 dark:bg-amber-400/5 dark:ring-amber-400/20">
                    <Markdown text={q.prompt} className="np-prose-sm np-inline" markFills={false} />
                    <p className="mt-0.5 text-[11.5px] text-ink-500">Answer: {q.kind === 'tf' ? (q.answer === 'true' ? 'True' : 'False') : q.answer}</p>
                  </li>
                ))}
              </ul>
              <SectionLinks ids={missedSections} doc={view.organized} onGo={onGo} />
            </div>
          ) : (
            <p>You got every question right.</p>
          )}
          <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3 dark:border-ink-800">
            {missed.length > 0 && (
              <Button variant="primary" onClick={controls.retryMissed}>
                Retry the {missed.length} I missed
              </Button>
            )}
            <Button onClick={controls.close}>New quiz</Button>
            {missedSections.length > 0 && (
              <Button variant="ghost" onClick={() => controls.copyPrompt(view, settings, { ...options, sectionIds: missedSections })}>
                <Icon name="copy" /> {state.copiedAt ? 'Copied' : 'Prompt for these topics'}
              </Button>
            )}
          </div>
          <CopyFeedback state={state} />
        </div>
      </section>
    </div>
  );
}
