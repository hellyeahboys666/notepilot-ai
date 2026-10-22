import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, PROVIDER_PRESETS, applyPreset, keyForAddress, presetFor, presetInUse, type Settings } from '../src/core/settings';
import { AIConnectionForm, connectedSettings } from '../src/sidepanel/components/AIConnectionForm';

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

describe('switching providers', () => {
  const ai = (label: string) => ({ ...DEFAULT_SETTINGS.ai, mode: 'direct' as const, ...applyPreset(PROVIDER_PRESETS.find((x) => x.label === label)!) });

  it('recording "same as the AI connection" follows the notes to the new service’s transcription model and price', () => {
    const before: Settings = { ...DEFAULT_SETTINGS, ai: ai('OpenAI') }; // gpt-4o-mini-transcribe at $0.003
    const groq = connectedSettings(before, ai('Groq (free tier)'));
    expect(groq.recording).toMatchObject({ endpoint: 'same', model: 'whisper-large-v3-turbo', pricePerMinute: 0 });
    expect(groq.frequency).toBe('saver');
    expect(connectedSettings(groq, ai('OpenAI')).recording).toMatchObject({ model: 'gpt-4o-mini-transcribe', pricePerMinute: 0.003 });
    // Same address: a model the user chose is kept. A separate service is never touched.
    const own = { ...before, recording: { ...before.recording, model: 'whisper-1' } };
    expect(connectedSettings(own, ai('OpenAI, low cost (GPT-6 Luna)')).recording.model).toBe('whisper-1');
    const custom = { ...before, recording: { ...before.recording, endpoint: 'custom' as const, baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-small' } };
    expect(connectedSettings(custom, ai('Groq (free tier)')).recording).toEqual(custom.recording);
  });

  it('a key stays with the host it was entered for', () => {
    expect(keyForAddress('sk-1', 'https://api.openai.com/v1', 'https://generativelanguage.googleapis.com/v1beta/openai')).toBe('');
    expect(keyForAddress('sk-1', 'https://api.openai.com/v1', 'https://api.openai.com/v2')).toBe('sk-1');
    expect(keyForAddress('gsk-1', 'https://api.groq.com/openai/v1', 'https://whisper.example.org/v1')).toBe('');
    expect(keyForAddress('sk-1', '', 'https://api.openai.com/v1')).toBe('sk-1'); // typed before the address
  });

  it('a paid account at a free preset’s address, with its own models, is not shown as the free tier', () => {
    const paid = { ...ai('Google Gemini (free tier)'), fastModel: 'gemini-3.8-pro', deepModel: 'gemini-3.8-pro', inputPricePerM: 1.25 };
    expect(presetFor(paid)?.label).toBe('Google Gemini (free tier)'); // the address still picks the menu entry
    expect(presetInUse(paid)).toBeUndefined();
    const html = form({ ...DEFAULT_SETTINGS, ai: paid });
    expect(html).not.toContain('free-tier-note');
    expect(connectedSettings({ ...DEFAULT_SETTINGS, ai: ai('OpenAI') }, paid).frequency).toBe('balanced');
  });
});
