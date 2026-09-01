import { describe, expect, it } from 'vitest';
import { composeLayers } from '../../src/composition/compose.js';
import type { LayerManifestV1 } from '../../src/domain/manifest.js';
import type { LayerSnapshot, ManagedObject } from '../../src/domain/objects.js';
import { rebaseOverlay } from '../../src/synchronization/rebase.js';

const enc = (s: string) => new TextEncoder().encode(s);
const f = (s: string, executable = false): ManagedObject => ({
  kind: 'file',
  content: enc(s),
  executable,
});
const baseManifest: LayerManifestV1 = { version: 1 };
const parent = (commit: string): LayerManifestV1 => ({
  version: 1,
  parent: { url: 'base', branch: 'main', commit },
});
const layer = (
  id: string,
  manifest: LayerManifestV1,
  objects: Record<string, ManagedObject>,
): LayerSnapshot => ({
  id,
  root: `/tmp/${id}`,
  manifest,
  objects: new Map(Object.entries(objects)),
});
const content = (snapshot: LayerSnapshot | undefined, path: string) =>
  snapshot?.objects.get(path);

describe('rebaseOverlay', () => {
  it('updates the exact pin, incorporates parent changes, and regenerates representations', () => {
    const oldParent = layer('old', baseManifest, {
      config: f('a\nb\nc\n'),
      removed: f('gone'),
    });
    const overlay = layer('overlay', parent('old-sha'), {
      'config.patch': f(
        '--- a/config\n+++ b/config\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
      ),
      'removed.delete': f(''),
      added: f('private'),
    });
    const nextParent = layer('new', baseManifest, {
      config: f('A\nb\nc\n'),
      addedByParent: f('public'),
    });
    const ref = {
      url: 'base',
      branch: 'main',
      commit: '0123456789abcdef0123456789abcdef01234567',
    };
    const plan = rebaseOverlay(oldParent, overlay, nextParent, ref);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.candidate?.manifest.parent).toEqual(ref);
    expect(content(plan.candidate, 'config.patch')?.kind).toBe('file');
    expect(content(plan.candidate, 'removed.delete')).toBeUndefined();
    expect(content(plan.candidate, 'added')?.kind).toBe('file');
    if (plan.candidate === undefined) throw new Error('Expected candidate');
    const recomposed = composeLayers(nextParent, [plan.candidate]);
    expect(recomposed.objects.get('config')).toEqual({
      kind: 'file',
      content: enc('A\nB\nc\n'),
      executable: false,
    });
    expect(recomposed.objects.has('removed')).toBe(false);
  });

  it.each([
    ['sha256', 'a'.repeat(64)],
    ['sha1', 'b'.repeat(40)],
  ])('accepts exact %s parent refs', (_name, commit) => {
    const old = layer('old', baseManifest, { x: f('old') });
    const overlay = layer('overlay', parent('old'), { x: f('ours') });
    const plan = rebaseOverlay(old, overlay, old, {
      url: 'u',
      branch: 'b',
      commit,
    });
    expect(plan.candidate?.manifest.parent?.commit).toBe(commit);
  });

  it('returns no candidate or pin when a conflict exists and leaves inputs untouched', () => {
    const old = layer('old', baseManifest, { x: f('base\n') });
    const overlay = layer('overlay', parent('old'), { x: f('ours\n') });
    const next = layer('next', baseManifest, { x: f('theirs\n') });
    const before = [...overlay.objects.entries()];
    const plan = rebaseOverlay(old, overlay, next, {
      url: 'u',
      branch: 'b',
      commit: 'c'.repeat(40),
    });
    expect(plan.candidate).toBeUndefined();
    expect(plan.conflicts[0]?.path).toBe('x');
    expect([...overlay.objects.entries()]).toEqual(before);
    expect(overlay.manifest.parent?.commit).toBe('old');
  });

  it('falls back to plain replacement for unrepresentable newline changes', () => {
    const old = layer('old', baseManifest, { x: f('a\n') });
    const overlay = layer('overlay', parent('old'), { x: f('a\r\n') });
    const plan = rebaseOverlay(old, overlay, old, {
      url: 'u',
      branch: 'b',
      commit: 'd'.repeat(40),
    });
    expect(plan.candidate?.objects.has('x')).toBe(true);
    expect(plan.candidate?.objects.has('x.patch')).toBe(false);
  });

  it('rejects malformed parent references', () => {
    const old = layer('old', baseManifest, { x: f('old') });
    const overlay = layer('overlay', parent('old'), { x: f('ours') });
    for (const ref of [
      { url: ' ', branch: 'main', commit: 'a'.repeat(40) },
      { url: 'base', branch: '\t', commit: 'a'.repeat(40) },
      { url: 'base', branch: 'main', commit: 'bad' },
    ])
      expect(() => rebaseOverlay(old, overlay, old, ref)).toThrow(
        expect.objectContaining({ code: 'invalid-parent-reference' }),
      );
  });
});
