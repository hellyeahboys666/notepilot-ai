import { useCallback, useEffect, useRef, useState } from 'react';
import { AIError } from '../../ai/client';
import { buildReviewMessages, buildReviewPrompt, checkAnswer, type ReviewOptions, type ReviewQuiz } from '../../core/review';
import type { Settings } from '../../core/settings';
import type { EngineView } from '../../engine/state';
import { gateFor, pipelines } from '../runtime';

export interface ReviewAnswer {
  given: string;
  /** null: a short answer the student hasn't marked yet. */
  correct: boolean | null;
}

export interface ReviewState {
  quiz: ReviewQuiz | null;
  answers: Record<string, ReviewAnswer>;
  index: number;
  phase: 'idle' | 'writing';
  error: string | null;
  /** Set when the review prompt couldn't be copied: the panel shows it for copying by hand. */
  promptText: string | null;
  copiedAt: number;
}

export interface ReviewControls {
  /** Has the AI write a new quiz. Call from a click. */
  start(view: EngineView, settings: Settings, options: ReviewOptions): void;
  answer(questionId: string, given: string): void;
  /** The student's own mark for a short answer. */
  mark(questionId: string, correct: boolean): void;
  next(): void;
  /** A new round with only the questions answered wrongly: no AI call. */
  retryMissed(): void;
  close(): void;
  /** Copies a prompt that has any chat AI run the review. No AI call. */
  copyPrompt(view: EngineView, settings: Settings, options: ReviewOptions): void;
}

const GATE_MESSAGE: Record<string, string> = {
  not_configured: 'Connect an AI provider in Settings first, or copy a review prompt instead.',
  no_consent: 'Allow NotePilot to send notes to your AI provider first (Settings).',
  excluded: 'This document is excluded from AI processing.',
  needs_approval: 'Approve this document for AI processing first.',
  budget: 'Daily cost limit reached. Copy a review prompt instead, or raise the limit in Settings → Cost limits.',
  disabled: 'Processing is paused.',
};

const AI_MESSAGE: Record<string, string> = {
  auth: 'The AI provider rejected the API key. Check Settings → AI model.',
  rate_limit: 'The AI provider is rate-limiting requests. Try again in a minute, or copy a review prompt instead.',
  network: 'Could not reach the AI provider. Check your connection.',
  invalid_output: 'The AI returned an unusable quiz. Try again.',
  bad_request: 'The AI provider rejected the request',
  server: 'The AI provider had an error. Try again shortly.',
  aborted: 'Writing the quiz took too long. Try again with fewer questions.',
};

const EMPTY: ReviewState = { quiz: null, answers: {}, index: 0, phase: 'idle', error: null, promptText: null, copiedAt: 0 };

/** The review for the active document: kept while switching tabs, cleared when the document changes. */
export function useReview(docId: string | null): [ReviewState, ReviewControls] {
  const [state, setState] = useState<ReviewState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The request in flight: cancelled (and its reply ignored) when the document changes or a newer one starts.
  const request = useRef<{ ctl: AbortController; token: number } | null>(null);
  const tokens = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    request.current?.ctl.abort();
    request.current = null;
    setState(EMPTY);
  }, [docId]);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const start = useCallback((view: EngineView, settings: Settings, options: ReviewOptions) => {
    if (stateRef.current.phase !== 'idle') return;
    const token = ++tokens.current;
    const patch = (p: Partial<ReviewState>) => tokens.current === token && setState((s) => ({ ...s, ...p }));
    if (!view.organized.rootSections.length) return void patch({ error: 'There are no organized notes to review yet.' });
    const gate = gateFor(view.docId, { manual: true });
    if (!gate.ok) return void patch({ error: GATE_MESSAGE[gate.reason] ?? 'AI processing is not available.' });
    patch({ phase: 'writing', error: null, promptText: null });
    const ctl = new AbortController();
    request.current = { ctl, token };
    void (async () => {
      const timer = setTimeout(() => ctl.abort(), settings.ai.mode === 'device' ? 240_000 : 120_000);
      try {
        const messages = buildReviewMessages({ organized: view.organized, settings, options });
        const { quiz } = await pipelines.review(messages, view.organized, options.kinds, ctl.signal);
        patch({ phase: 'idle', quiz, answers: {}, index: 0 });
      } catch (e) {
        if (tokens.current !== token) return; // cancelled by a document switch: nothing to report
        const msg = e instanceof AIError ? `${AI_MESSAGE[e.kind] ?? 'AI error'}${e.kind === 'bad_request' ? `: ${e.message.slice(0, 120)}` : ''}` : 'Could not write the quiz.';
        patch({ phase: 'idle', error: msg });
      } finally {
        clearTimeout(timer);
        if (request.current?.token === token) request.current = null;
      }
    })();
  }, []);

  // A document switch invalidates any reply still on its way.
  useEffect(() => {
    tokens.current++;
  }, [docId]);

  const controls: ReviewControls = {
    start,
    answer: (qid, given) =>
      setState((s) => {
        const q = s.quiz?.questions.find((x) => x.id === qid);
        if (!q || s.answers[qid]) return s;
        return { ...s, answers: { ...s.answers, [qid]: { given, correct: checkAnswer(q, given) } } };
      }),
    mark: (qid, correct) => setState((s) => (s.answers[qid] ? { ...s, answers: { ...s.answers, [qid]: { ...s.answers[qid], correct } } } : s)),
    next: () => setState((s) => ({ ...s, index: s.index + 1 })),
    retryMissed: () =>
      setState((s) => {
        if (!s.quiz) return s;
        const missed = s.quiz.questions.filter((q) => s.answers[q.id]?.correct === false);
        return missed.length ? { ...s, quiz: { ...s.quiz, questions: missed }, answers: {}, index: 0 } : s;
      }),
    close: () => setState(EMPTY),
    copyPrompt: (view, settings, options) => {
      const text = buildReviewPrompt({ organized: view.organized, insights: view.insights, settings, options });
      // From the click: the clipboard needs it. If it's refused, the panel shows the text to copy by hand.
      navigator.clipboard.writeText(text).then(
        () => {
          setState((s) => ({ ...s, copiedAt: Date.now(), promptText: null, error: null }));
          clearTimeout(copiedTimer.current);
          copiedTimer.current = setTimeout(() => setState((s) => ({ ...s, copiedAt: 0 })), 8000);
        },
        () => setState((s) => ({ ...s, promptText: text, copiedAt: 0, error: null })),
      );
    },
  };
  return [state, controls];
}
