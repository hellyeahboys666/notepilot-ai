import type { SummarySection } from '../../core/summary';
import type { OrganizedDoc } from '../../core/types';
import type { SummaryState } from '../hooks/useSummary';
import { Markdown } from './Markdown';
import { Icon, cx, relativeTime, sectionHeadingClass } from './ui';

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
        <div className="mt-2 space-y-4">
          {stale && (
            <p className="flex items-center gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
              <Icon name="warn" className="h-3 w-3 shrink-0" /> Your notes changed since this summary.
              <button type="button" onClick={onRefresh} disabled={busy} className="np-focus font-semibold underline underline-offset-2 disabled:opacity-50">
                Update
              </button>
            </p>
          )}
          <div className="rounded-md border-l-2 border-amber-300 bg-amber-50/50 px-3 py-2 dark:bg-amber-400/5">
            <Markdown text={summary.overview} markFills={false} />
          </div>

          <div>
            {summary.sections.map((s) => (
              <SummarySectionRow key={s.sectionId} section={s} live={!!doc.sections[s.sectionId]} onGo={onGo} />
            ))}
          </div>

          {summary.keyTerms.length > 0 && (
            <div>
              <h3 className={cx('m-0', sectionHeadingClass(1))}>Key Terms</h3>
              <div className="np-prose mt-2 overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Term</th>
                      <th>Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.keyTerms.map((t, i) => (
                      <tr key={i}>
                        <td className="font-semibold">
                          {t.sectionIds[0] && doc.sections[t.sectionIds[0]] ? (
                            <button type="button" className="np-focus text-left hover:underline" onClick={() => onGo(t.sectionIds[0])} title={`Go to “${doc.sections[t.sectionIds[0]].title}”`}>
                              {t.term}
                            </button>
                          ) : (
                            t.term
                          )}
                        </td>
                        <td>
                          <Markdown text={t.definition} className="np-inline" markFills={false} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {summary.review.length > 0 && (
            <div>
              <h3 className={cx('m-0', sectionHeadingClass(1))}>Review Next</h3>
              <ul className="mt-2 space-y-1">
                {summary.review.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <Icon name="gap" className="mt-1 h-3 w-3 shrink-0 text-amber-600" />
                    <div className="min-w-0">
                      <Markdown text={r.text} className="np-prose np-inline" markFills={false} />
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

/** One section of the summary, laid out like the same section in the organized notes. */
function SummarySectionRow({ section: s, live, onGo }: { section: SummarySection; live: boolean; onGo: (id: string) => void }) {
  const Tag = s.depth === 1 ? 'h3' : s.depth === 2 ? 'h4' : 'h5';
  const heading = (
    <>
      {s.number && <span className="mr-1 font-normal tabular-nums text-ink-300 dark:text-ink-600">{s.number}</span>}
      <span className="min-w-0 flex-1">{s.title}</span>
    </>
  );
  return (
    <div className={cx(s.depth === 1 ? 'mt-4 first:mt-0' : s.depth === 2 ? 'mt-3' : 'mt-2')} style={{ paddingLeft: (s.depth - 1) * 10 }} data-testid="summary-section">
      <Tag className={cx('m-0 flex items-baseline gap-1', sectionHeadingClass(s.depth))}>
        {live ? (
          <button type="button" onClick={() => onGo(s.sectionId)} title="Go to this section in your notes" className="np-focus flex min-w-0 flex-1 items-baseline gap-1 rounded text-left hover:underline hover:decoration-ink-300 hover:underline-offset-4">
            {heading}
          </button>
        ) : (
          heading
        )}
      </Tag>
      {s.content && (
        <div className="mt-1.5">
          <Markdown text={s.content} markFills={false} />
        </div>
      )}
    </div>
  );
}
