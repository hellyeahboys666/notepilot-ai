import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildRewriteMessages } from '../src/core/context';
import { rewriteSystemPrompt } from '../src/core/prompts';
import { DEFAULT_SETTINGS, NOTE_STYLES, THEMES, mergeSettings, type Settings } from '../src/core/settings';
import { simpleRewriteSystem } from '../src/core/simpleRewrite';
import { emptyOrganizedDoc } from '../src/core/types';
import { ThemePicker } from '../src/sidepanel/components/ThemePicker';

const withStyle = (noteStyle: Settings['noteStyle']): Settings => ({ ...DEFAULT_SETTINGS, noteStyle });

describe('note styles', () => {
  it('Standard leaves the instructions as they were; every other style adds its own rules', () => {
    expect(rewriteSystemPrompt(withStyle('standard'))).not.toContain('NOTE STYLE');
    expect(rewriteSystemPrompt(withStyle('outline'))).toContain('NOTE STYLE: OUTLINE');
    expect(rewriteSystemPrompt(withStyle('qa'))).toContain('NOTE STYLE: QUESTIONS AND ANSWERS');
    const cornell = rewriteSystemPrompt(withStyle('cornell'));
    expect(cornell).toContain('**Cue questions**');
    expect(cornell).toContain('**Summary:**');
    expect(cornell).toContain('every source block must still be rewritten in a regular unit');
  });

  it('the on-device task follows the style too', () => {
    expect(simpleRewriteSystem('outline')).toContain('short "- " bullet points');
    expect(simpleRewriteSystem('qa')).toContain('**Q: …?**');
    expect(simpleRewriteSystem('cornell')).toBe(simpleRewriteSystem('standard'));
    const device = { ...withStyle('qa'), ai: { ...DEFAULT_SETTINGS.ai, mode: 'device' as const } };
    const built = buildRewriteMessages({ organized: emptyOrganizedDoc('d'), currentBlocks: [], batch: { added: [], modified: [], removed: [] }, settings: device });
    expect(built.messages[0].content).toBe(simpleRewriteSystem('qa'));
  });

  it('settings saved before styles existed get Standard and Classic', () => {
    const old = mergeSettings({ rewriteIntensity: 'light', display: { showOriginLabels: false, showExpansions: true, highlightUpdates: true } } as never);
    expect(old.noteStyle).toBe('standard');
    expect(old.display.theme).toBe('classic');
    expect(old.display.showOriginLabels).toBe(false);
    expect(NOTE_STYLES.map((n) => n.value)).toEqual(['standard', 'outline', 'qa', 'cornell']);
  });
});

describe('theme picker', () => {
  it('offers every theme, marks the chosen one, and describes it', () => {
    const html = renderToStaticMarkup(createElement(ThemePicker, { value: 'paper', onChange: () => {} }));
    expect(html.match(/role="radio"/g)).toHaveLength(THEMES.length);
    expect(html).toMatch(/aria-checked="true"[^>]*title="Warm, cream pages/);
    expect(html).toContain('Warm, cream pages and serif note text, like a notebook.');
  });
});
