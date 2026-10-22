import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Static guarantees for how NotePilot touches Google Docs (spec §11, plus lecture recording).
 * Notes are read, never edited. The one exception is the lecture transcript: google/transcriptWriter.ts may append
 * lines to NotePilot's own section at the end of the doc, with the full Docs scope asked for only when a recording
 * starts. These scan the shipped source and manifest so a future change cannot quietly widen either.
 */

const root = resolve(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const sources = files(join(root, 'src')).map((p) => ({ p, text: readFileSync(p, 'utf8') }));

describe('Google Docs: read, and append only to the transcript section', () => {
  it('the manifest requests only the read-only Docs scope (writing is asked for at the first recording)', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.base.json'), 'utf8'));
    expect(manifest.oauth2.scopes).toEqual(['https://www.googleapis.com/auth/documents.readonly']);
    expect(manifest.permissions).not.toContain('scripting');
    expect(manifest.permissions).not.toContain('tabs');
  });

  it('only the transcript writer calls batchUpdate, and only auth.ts names the write scope', () => {
    for (const { p, text } of sources) {
      if (!p.endsWith('google/transcriptWriter.ts')) expect(text, p).not.toMatch(/batchUpdate/);
      if (!p.endsWith('google/auth.ts')) expect(text, p).not.toMatch(/auth\/documents['"`]/); // full (write) Docs scope
      // drive.file (files NotePilot creates itself) is the only Drive scope allowed.
      expect(text, p).not.toMatch(/auth\/drive(?!\.file['"`])/);
    }
    const scopeUsers = sources.filter((s) => /TRANSCRIPT_SCOPES|DOCS_EDIT_SCOPE/.test(s.text)).map((s) => s.p.replace(/.*\/src\//, '')).sort();
    expect(scopeUsers).toEqual(['google/auth.ts', 'google/transcriptWriter.ts', 'sidepanel/hooks/useRecording.ts']);
  });

  it('the transcript writer only reads the doc’s end and sends checked, transcript-only batch updates', () => {
    const writer = sources.find((s) => s.p.endsWith('google/transcriptWriter.ts'))!.text;
    expect([...writer.matchAll(/call(?:<[^>]+>)?\('(GET|POST)'/g)].map((m) => m[1])).toEqual(['GET', 'POST']);
    expect(writer).toMatch(/call\('POST', `\$\{API\}\$\{id\}:batchUpdate`/);
    expect(writer.indexOf('assertTranscriptOnly(requests, snapshot)')).toBeLessThan(writer.indexOf(":batchUpdate"));
    expect(writer).toMatch(/writeControl: \{ targetRevisionId: snapshot\.revisionId \}/);
    for (const forbidden of [/deleteContentRange/, /replaceAllText/, /replaceNamedRangeContent/, /deleteNamedRange/, /insertTable|insertInlineImage/]) expect(writer).not.toMatch(forbidden);
  });

  it('only the companion-doc exporter talks to Google Drive, and only through the upload endpoint', () => {
    for (const { p, text } of sources) {
      if (p.endsWith('google/driveExport.ts')) continue;
      expect(text, p).not.toMatch(/googleapis\.com\/(upload\/)?drive/);
    }
    const drive = sources.find((s) => s.p.endsWith('google/driveExport.ts'))!.text;
    expect(drive).not.toMatch(/docs\.googleapis\.com/);
    expect([...drive.matchAll(/https:\/\/[^'"`\s$]+/g)].map((m) => m[0])).toEqual(['https://www.googleapis.com/upload/drive/v3/files', 'https://docs.google.com/document/d/']);
    const methods = new Set([...drive.matchAll(/'(GET|POST|PUT|PATCH|DELETE)'/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(['PATCH', 'POST']);
    expect(drive).not.toMatch(/method:\s*'DELETE'|\/copy|\/permissions/);
  });

  it('only ever issues GET requests to the Docs API', () => {
    const docsApi = sources.find((s) => s.p.endsWith('google/docsApi.ts'))!.text;
    const methods = [...docsApi.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
    expect(methods).toEqual(['GET']);
  });

  it('the content script never touches document content, selection or focus', () => {
    const content = sources.find((s) => s.p.endsWith('content/activity.ts'))!.text;
    for (const forbidden of [/execCommand/, /\.focus\(/, /getSelection/, /innerHTML|textContent|innerText/, /preventDefault/, /dispatchEvent/, /\.value\s*=/]) {
      expect(content).not.toMatch(forbidden);
    }
  });
});
