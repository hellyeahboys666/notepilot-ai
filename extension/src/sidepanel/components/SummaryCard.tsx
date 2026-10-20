import type { OrganizedDoc } from '../../core/types';
import type { SummaryState } from '../hooks/useSummary';
import { Markdown } from './Markdown';
import { Icon, cx, relativeTime } from './ui';

/** The on-demand summary shown at the top of the organized notes, with the companion Google Doc. */
export function SummaryCard({
  state,
  doc,
  now,
  onRefresh,
  onGo,
  onClose,
}: {
  state: SummaryState;
  doc: OrganizedDoc;
  now: number;
  onRefresh: () => void;
  onGo: (sectionId: string) => void;
  onClose: () => void;
}) {
  const { summary, phase, error, docError, exportDoc } = state;
  const stale = !!summary && summary.orgVersion !== doc.version;
  const busy = phase !== 'idle';

  return (
    <section aria-label="Summary" className="mx-4 mt-3 rounded-lg border border-ink-200 bg-ink-50/70 px-3 pb-3 pt-2.5 font-sans dark:border-ink-800 dark:bg-ink-900/60" data-testid="summary-card">
      <div className="flex items-center gap-1.5">
        <Icon name="summary" className="h-3.5 w-3.5 text-ink-500" />
        <h2 className="flex-1 text-[12.5px] font-semibold text-ink-900 dark:text-ink-50">Summary</h2>
        {summary && (
          <button type="button" onClick={onRefresh} disabled={busy} title="Make a new summary" aria-label="Make a new summary" className="np-focus rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-40 dark:hover:bg-ink-800 dark:hover:text-ink-200">
            <Icon name="refresh" />
          </button>
        )}
        <button type="button" onClick={onClose} title="Hide summary" aria-label="Hide summary" className="np-focus rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-ink-800 dark:hover:text-ink-200">
          <Icon name="close" />
        </button>
      </div>

      {phase === 'summarizing' && (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-ink-500" role="status">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-500" /> Summarizing your notes…
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-red-700 dark:text-red-300">{error}</p>}

      {summary && phase !== 'summarizing' && (
        <div className="mt-1.5 space-y-3">
          {stale && (
            <p className="flex items-center gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
              <Icon name="warn" className="h-3 w-3 shrink-0" /> Your notes changed since this summary.
              <button type="button" onClick={onRefresh} disabled={busy} className="np-focus font-semibold underline underline-offset-2 disabled:opacity-50">
                Update
              </button>
            </p>
          )}
          <Markdown text={summary.overview} className="np-prose-sm" />

          {summary.keyPoints.length > 0 && (
            <div>
              <h3 className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-400">Key points</h3>
              <ul className="mt-1 space-y-1.5">
                {summary.keyPoints.map((k, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-ink-700 dark:text-ink-300">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-400" />
                    <div className="min-w-0">
                      <Markdown text={k.text} className="np-prose-sm np-inline" />
                      <SectionChips ids={k.sectionIds} doc={doc} onGo={onGo} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.keyTerms.length > 0 && (
            <details open={summary.keyTerms.length <= 5} className="group">
              <summary className="np-focus cursor-pointer list-none text-[10.5px] font-semibold uppercase tracking-wide text-ink-400">
                <span className="inline-flex items-center gap-1">
                  <Icon name="chevron" className="h-2.5 w-2.5 transition-transform group-open:rotate-90" /> Key terms ({summary.keyTerms.length})
                </span>
              </summary>
              <dl className="mt-1 space-y-1">
                {summary.keyTerms.map((t, i) => (
                  <div key={i} className="text-[12.5px] leading-snug">
                    <dt className="inline font-semibold text-ink-900 dark:text-ink-50">
                      {t.sectionIds[0] ? (
                        <button type="button" className="np-focus hover:underline" onClick={() => onGo(t.sectionIds[0])}>
                          {t.term}
                        </button>
                      ) : (
                        t.term
                      )}
                    </dt>
                    <dd className="inline text-ink-600 dark:text-ink-300"> — {t.definition}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {summary.review.length > 0 && (
            <div>
              <h3 className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-400">Review next</h3>
              <ul className="mt-1 space-y-1">
                {summary.review.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-ink-700 dark:text-ink-300">
                    <Icon name="gap" className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                    <div className="min-w-0">
                      <Markdown text={r.text} className="np-prose-sm np-inline" />
                      <SectionChips ids={r.sectionIds} doc={doc} onGo={onGo} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[10.5px] text-ink-400">AI-generated from your organized notes · {relativeTime(summary.createdAt, now)}</p>
        </div>
      )}

      <div className={cx('mt-3 flex items-center gap-2 border-t border-ink-200 pt-2 text-[11.5px] dark:border-ink-800', !summary && !busy && !docError && !exportDoc && 'hidden')}>
        <Icon name="doc" className="h-4 w-4 shrink-0" />
        {phase === 'saving' ? (
          <span className="flex-1 text-ink-500" role="status">
            Saving to Google Docs…
          </span>
        ) : docError ? (
          <span className="flex-1 text-amber-800 dark:text-amber-200">{docError}</span>
        ) : exportDoc ? (
          <>
            <span className="min-w-0 flex-1 truncate text-ink-600 dark:text-ink-300">
              Google Doc · saved {relativeTime(exportDoc.updatedAt, now)}
            </span>
            <a href={exportDoc.url} target="_blank" rel="noopener noreferrer" className="np-focus inline-flex shrink-0 items-center gap-1 rounded-md border border-ink-200 bg-white px-2 py-0.5 font-medium text-ink-800 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100 dark:hover:bg-ink-800">
              Open <Icon name="external" className="h-3 w-3" />
            </a>
          </>
        ) : (
          <span className="flex-1 text-ink-500">Not saved to Google Docs yet.</span>
        )}
      </div>
    </section>
  );
}

function SectionChips({ ids, doc, onGo }: { ids: string[]; doc: OrganizedDoc; onGo: (id: string) => void }) {
  const live = ids.filter((id) => doc.sections[id]);
  if (!live.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {live.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onGo(id)}
          title={`Go to “${doc.sections[id].title}”`}
          className="np-focus max-w-[11rem] truncate rounded bg-white px-1.5 py-px text-[10.5px] font-medium text-accent-700 ring-1 ring-ink-200 hover:bg-accent-50 dark:bg-ink-950 dark:text-accent-300 dark:ring-ink-700 dark:hover:bg-ink-800"
        >
          {doc.sections[id].title}
        </button>
      ))}
    </span>
  );
}
