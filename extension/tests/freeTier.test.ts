import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, PROVIDER_PRESETS, applyPreset, type Settings } from '../src/core/settings';
import { AIConnectionForm } from '../src/sidepanel/components/AIConnectionForm';

// The form's runtime keeps usage in chrome.storage, which tests don't have.
vi.mock('../src/storage/settingsStore', async (original) => ({
  ...await original<typeof import('../src/storage/settingsStore')>(),
  usagePersistence: { load: async () => null, save: async () => undefined },
}));

const form = (s: Settings) => renderToStaticMarkup(createElement(AIConnectionForm, { settings: s, update: vi.fn() }));
const withPreset = (label: string, frequency: Settings['frequency'] = 'balanced'): Settings => {
  const p = PROVIDER_PRESETS.find((x) => x.label === label)!;
  return { ...DEFAULT_SETTINGS, frequency, ai: { ...DEFAULT_SETTINGS.ai, mode: 'direct', ...applyPreset(p) } };
};

describe('free options in the AI connection form', () => {
  it('a free cloud tier shows its limits, what happens to notes, the age limit and the switch to Saver', () => {
    const html = form(withPreset('Google Gemini (free tier)'));
    expect(html).toContain('free-tier-note');
    expect(html).toContain('aistudio.google.com/rate-limit');
    expect(html).toContain('may use what you send');
    expect(html).toContain('18 or older');
    expect(html).toContain('sets Update frequency to Saver');
    // Already at Saver: nothing changes, so nothing to announce.
    expect(form(withPreset('Google Gemini (free tier)', 'saver'))).not.toContain('sets Update frequency to Saver');
  });

  it('a local model needs no adult account and keeps the frequency', () => {
    const html = form(withPreset('Ollama (local)'));
    expect(html).toContain('Nothing leaves your computer.');
    expect(html).not.toContain('18 or older');
    expect(html).not.toContain('sets Update frequency');
  });

  it('paid presets show no free note', () => {
    expect(form(withPreset('OpenAI'))).not.toContain('free-tier-note');
  });

  it('the on-device choice shows its requirements in the same note', () => {
    const html = form({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, mode: 'device' } });
    expect(html).toContain('On this computer (free)');
    expect(html).toContain('free-tier-note');
    expect(html).toContain('22 GB');
    expect(html).not.toContain('18 or older');
  });
});
