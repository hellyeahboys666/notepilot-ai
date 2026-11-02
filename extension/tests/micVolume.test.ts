import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RecordingSession, type RecordingState } from '../src/audio/session';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { RecordStrip } from '../src/sidepanel/components/RecordControl';
import type { RecordingControls } from '../src/sidepanel/hooks/useRecording';

// The strip's runtime keeps usage in chrome.storage, which tests don't have.
vi.mock('../src/storage/settingsStore', async (original) => ({
  ...await original<typeof import('../src/storage/settingsStore')>(),
  usagePersistence: { load: async () => null, save: async () => undefined },
}));

const segment = (heard: boolean) => ({ blob: new Blob(['x'], { type: 'audio/webm' }), startedAt: 0, seconds: 20, heard });

describe('silence while recording', () => {
  it('counts unheard stretches in a row, and starts over once something is heard', () => {
    const states: RecordingState[] = [];
    const session = new RecordingSession(
      'doc',
      'mic',
      { transcribe: () => new Promise(() => {}), write: async () => undefined, spend: () => true, now: () => 0, sleep: async () => undefined, locale: 'en-US' },
      (s) => states.push(s),
      () => {},
    );
    session.push(segment(false));
    session.push(segment(false));
    expect(session.state).toMatchObject({ quietInRow: 2, skipped: 2 });
    session.push(segment(true));
    expect(session.state.quietInRow).toBe(0);
  });
});

describe('the recording bar', () => {
  const controls = { start: vi.fn(), stop: vi.fn(), dismiss: vi.fn(), allow: vi.fn(), openMicPage: vi.fn(), level: () => 0.05 } as RecordingControls;
  const strip = (state: Partial<RecordingState>) =>
    renderToStaticMarkup(
      createElement(RecordStrip, {
        rec: { state: { phase: 'recording', source: 'mic', docId: 'd', startedAt: 1, lines: 0, pending: 0, skipped: 0, quietInRow: 0, lastLine: '', error: null, ...state }, starting: false, error: null, micBlocked: false },
        controls,
        asking: null,
        settings: DEFAULT_SETTINGS,
        onAllow: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

  it('reminds the user to check the microphone volume at the start of every microphone recording', () => {
    const html = strip({});
    expect(html).toContain('mic-volume-tip');
    expect(html).toContain('Check your microphone volume');
    expect(html).toContain('System Settings → Sound → Input');
    expect(html).not.toContain('Nothing heard');
    expect(strip({ source: 'tab' })).not.toContain('mic-volume-tip'); // a tab has no microphone to adjust
  });

  it('warns once nothing has been heard for a while, with the fix for the source', () => {
    expect(strip({ quietInRow: 1 })).not.toContain('Nothing heard');
    const mic = strip({ quietInRow: 2 });
    expect(mic).toContain('Nothing heard for 40 seconds.');
    expect(mic).toContain('Turn up your microphone’s input volume');
    expect(strip({ source: 'tab', quietInRow: 3 })).toContain('The tab may be muted or quiet');
    expect(strip({ phase: 'stopped', quietInRow: 3 })).not.toContain('Nothing heard');
  });
});
