import { THEMES, type Theme } from '../../core/settings';
import { cx } from './ui';

/** Fixed colors, so each preview shows its own theme whichever theme is active: page, text, accent. */
const SWATCH: Record<Theme, { page: string; text: string; accent: string }> = {
  classic: { page: '#ffffff', text: '#3f3f46', accent: '#3b66f5' },
  paper: { page: '#fffbf3', text: '#483d31', accent: '#b5603d' },
  forest: { page: '#fafcf9', text: '#39473d', accent: '#2f8c58' },
  contrast: { page: '#ffffff', text: '#000000', accent: '#0a47e0' },
};

export function ThemePicker({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  const current = THEMES.find((t) => t.value === value) ?? THEMES[0];
  return (
    <div className="space-y-1.5">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-4 gap-2">
        {THEMES.map((t) => {
          const c = SWATCH[t.value];
          const on = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              title={t.description}
              onClick={() => onChange(t.value)}
              className={cx(
                'np-focus flex flex-col gap-1 rounded-lg border p-1.5 text-left text-[11px] font-medium transition-colors',
                on ? 'border-accent-500 text-ink-900 ring-1 ring-accent-500 dark:text-ink-50' : 'border-ink-200 text-ink-500 hover:border-ink-300 dark:border-ink-700 dark:text-ink-400',
              )}
            >
              <span className="block h-9 w-full space-y-1 rounded-md p-1.5 ring-1 ring-black/10" style={{ background: c.page }} aria-hidden>
                <span className="block h-1 w-3/4 rounded-full" style={{ background: c.text }} />
                <span className="block h-1 w-1/2 rounded-full opacity-60" style={{ background: c.text }} />
                <span className="block h-1 w-1/3 rounded-full" style={{ background: c.accent }} />
              </span>
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-snug text-ink-400">{current.description}</p>
    </div>
  );
}
