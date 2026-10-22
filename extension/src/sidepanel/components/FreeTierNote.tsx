import type { FreeTier } from '../../core/settings';
import { Badge } from './ui';

/**
 * What a free option gives and what it asks in return, shown where it is chosen so nobody picks it blind.
 * `about`: what the provider receives; `instead`: the account-free option to point under-18s to.
 */
export function FreeTierNote({
  free,
  savesFrequency,
  about = 'Your notes',
  instead = 'Ollama or this computer’s built-in AI, which need no account',
}: {
  free: FreeTier;
  savesFrequency?: boolean;
  about?: string;
  instead?: string;
}) {
  const lead = 'font-medium text-ink-800 dark:text-ink-100';
  return (
    <div
      data-testid="free-tier-note"
      className="space-y-1 rounded-md bg-emerald-50/60 px-2.5 py-2 text-[11.5px] leading-snug text-ink-600 ring-1 ring-emerald-200/70 dark:bg-emerald-500/5 dark:text-ink-300 dark:ring-emerald-500/20"
    >
      <p className="flex items-center gap-1.5">
        <Badge tone="green">Free</Badge>
        {free.adultsOnly && (
          <Badge tone="amber" title="The provider's terms require users to be 18 or older">
            18+
          </Badge>
        )}
      </p>
      <p>
        <span className={lead}>Limits.</span> {free.limits}
      </p>
      <p>
        <span className={lead}>{about}.</span> {free.data}
      </p>
      {free.adultsOnly && <p className="text-amber-800 dark:text-amber-200">The provider’s terms require you to be 18 or older. Under 18? Use {instead}.</p>}
      {savesFrequency && <p className="text-ink-500 dark:text-ink-400">Connecting sets Update frequency to Saver, to stay within the free limits.</p>}
    </div>
  );
}
