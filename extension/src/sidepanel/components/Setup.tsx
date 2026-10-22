import { useEffect, useState } from 'react';
import { availability } from '../../ai/onDevice';
import { endpointOrigin, isAIConfigured, type Settings } from '../../core/settings';
import type { EngineView } from '../../engine/state';
import { auth } from '../../google/auth';
import { AIConnectionForm } from './AIConnectionForm';
import { Button, Icon, cx } from './ui';

/** First-run flow: Google (read-only) → AI connection → consent. After this, everything is automatic. */
export function Setup({ view, settings, update, onSignedIn }: { view: EngineView | null; settings: Settings; update: (fn: (s: Settings) => Settings) => void; onSignedIn: () => void }) {
  const [authError, setAuthError] = useState<string | null>(null);
  const [deviceReady, setDeviceReady] = useState(false);
  const googleDone = !!view && view.status !== 'needs_auth' && view.status !== 'starting';
  const onDevice = settings.ai.mode === 'device';
  const aiDone = isAIConfigured(settings.ai) && (!onDevice || deviceReady);
  const origin = endpointOrigin(settings.ai);
  const consentDone = aiDone && !!origin && settings.consent?.endpointOrigin === origin;

  useEffect(() => {
    setDeviceReady(false);
    if (!onDevice) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const status = await availability();
        if (active) setDeviceReady(status === 'available');
      } catch {
        if (active) setDeviceReady(false);
      } finally {
        if (active) timer = setTimeout(() => void check(), 3000);
      }
    };
    // Saved local settings are not proof that Chrome still has the model installed.
    void check();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [onDevice]);

  const signIn = async () => {
    setAuthError(null);
    try {
      await auth.getToken(true);
      onSignedIn();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    }
  };

  const allowProcessing = () => update((s) => {
    // Consent belongs to the connection shown here, not a newly switched provider.
    if (!aiDone || !origin || !isAIConfigured(s.ai) || endpointOrigin(s.ai) !== origin) return s;
    return { ...s, consent: { endpointOrigin: origin, at: Date.now() } };
  });

  return (
    <div className="px-4 py-5">
      <h2 className="text-[15px] font-semibold text-ink-900 dark:text-ink-50">Set up NotePilot</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-500 dark:text-ink-400">Three quick steps. After that, your organized notes update on their own while you type.</p>
      <ol className="mt-4 space-y-3">
        <Step n={1} title="Connect Google Docs (read-only)" done={googleDone} active={!googleDone}>
          <p className="text-[12px] text-ink-500 dark:text-ink-400">NotePilot asks only for permission to read documents. It can't edit, comment on, or create files.</p>
          <Button variant="primary" onClick={() => void signIn()} className="mt-2">
            <Icon name="google" /> Sign in with Google
          </Button>
          {authError && <p className="mt-2 text-[11.5px] text-red-600 dark:text-red-400">{authError}</p>}
        </Step>
        <Step n={2} title="Connect an AI model" done={aiDone} active={googleDone && !aiDone}>
          <AIConnectionForm settings={settings} update={update} compact />
        </Step>
        <Step n={3} title={onDevice ? 'Allow local note processing' : 'Allow sending notes for rewriting'} done={consentDone} active={googleDone && aiDone && !consentDone}>
          <p className="text-[12px] leading-relaxed text-ink-600 dark:text-ink-300">
            {onDevice ? (
              <>
                The text of the Google Docs you open with this panel will be rewritten and analyzed on this computer using Chrome’s built-in AI. Note text is not sent to AI providers.{' '}
                Your documents are never modified.{' '}
                {settings.privacy.redactPII ? 'Email addresses, phone and ID numbers are redacted before local processing. ' : ''}
              </>
            ) : (
              <>
                The text of the Google Docs you open with this panel will be sent to <span className="font-semibold">{origin || 'your AI provider'}</span> to be rewritten and analyzed. Your
                documents are never modified.{' '}
                {settings.privacy.redactPII ? 'Email addresses, phone and ID numbers are redacted before sending. ' : ''}
              </>
            )}
            You can revoke this at any time in Settings.
          </p>
          <Button variant="primary" className="mt-2" onClick={allowProcessing}>
            Allow and start organizing
          </Button>
        </Step>
      </ol>
    </div>
  );
}

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <li className={cx('rounded-lg border px-3 py-2.5', active ? 'border-ink-300 bg-white dark:border-ink-600 dark:bg-ink-900' : 'border-ink-100 dark:border-ink-800')}>
      <div className="flex items-center gap-2">
        <span
          className={cx(
            'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold',
            done ? 'bg-emerald-500 text-white' : active ? 'bg-ink-900 text-white dark:bg-ink-100 dark:text-ink-900' : 'bg-ink-100 text-ink-400 dark:bg-ink-800',
          )}
        >
          {done ? <Icon name="check" className="h-3 w-3" /> : n}
        </span>
        <span className={cx('text-[12.5px] font-medium', done ? 'text-ink-400' : 'text-ink-900 dark:text-ink-100')}>{title}</span>
      </div>
      {active && <div className="mt-2 pl-7">{children}</div>}
    </li>
  );
}
