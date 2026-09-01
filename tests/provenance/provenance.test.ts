import { describe, expect, it } from 'vitest';
import type { LayerSnapshot, ManagedObject } from '../../src/domain/objects.js';
import { composeLayers } from '../../src/composition/compose.js';
import { calculateProvenance } from '../../src/provenance/provenance.js';

const file = (text: string): ManagedObject => ({
  kind: 'file',
  content: new TextEncoder().encode(text),
  executable: false,
});
const layer = (
  id: string,
  objects: Record<string, ManagedObject>,
  parent = false,
): LayerSnapshot => ({
  id,
  root: '.',
  manifest: parent
    ? { version: 1, parent: { url: 'x', branch: 'main', commit: 'x' } }
    : { version: 1 },
  objects: new Map(Object.entries(objects)),
});

describe('provenance', () => {
  it('reports base, overlay replacement, patch lines, and tombstones', () => {
    const base = layer('base', {
      a: file('one\ntwo\n'),
      deleted: file('gone'),
    });
    const overlay = layer(
      'work',
      {
        'a.patch': file('--- a\n+++ a\n@@ -1,2 +1,2 @@\n one\n-two\n+work\n'),
        'deleted.delete': file(''),
      },
      true,
    );
    const composed = composeLayers(base, [overlay]);
    const result = calculateProvenance([base, overlay], composed);
    expect(result.files.get('a')).toMatchObject({
      owner: 'work',
      operation: 'patch',
      overridesLower: true,
    });
    expect(result.lines.get('a')?.map((line) => line.owner)).toEqual([
      'base',
      'work',
    ]);
    expect(result.files.get('deleted')).toMatchObject({
      owner: 'work',
      operation: 'delete',
      deleted: true,
    });
  });

  it('gives whole-object provenance to binary files and symlinks', () => {
    const base = layer('base', {
      bin: {
        kind: 'file',
        content: Uint8Array.from([0, 255]),
        executable: false,
      },
      link: { kind: 'symlink', target: 'x' },
    });
    const result = calculateProvenance([base], composeLayers(base));
    expect(result.files.get('bin')?.owner).toBe('base');
    expect(result.lines.has('bin')).toBe(false);
    expect(result.lines.has('link')).toBe(false);
  });

  it('makes replacements own identical lines and additions non-overriding', () => {
    const base = layer('base', { same: file('x\ny\n') });
    const overlay = layer(
      'overlay',
      { same: file('x\ny\n'), added: file('z\n') },
      true,
    );
    const result = calculateProvenance(
      [base, overlay],
      composeLayers(base, [overlay]),
    );
    expect(
      result.lines.get('same')?.every((line) => line.owner === 'overlay'),
    ).toBe(true);
    expect(result.lines.get('same')?.every((line) => line.overridesLower)).toBe(
      true,
    );
    expect(
      result.lines.get('added')?.every((line) => !line.overridesLower),
    ).toBe(true);
  });

  it('preserves provenance through an upper patch and documents delete/re-add', () => {
    const base = layer('base', { a: file('base\nkeep\n') });
    const first = layer(
      'first',
      {
        'a.patch': file(
          '--- a\n+++ a\n@@ -1,2 +1,2 @@\n-base\n+private\n keep\n',
        ),
      },
      true,
    );
    const second = layer(
      'second',
      {
        'a.patch': file(
          '--- a\n+++ a\n@@ -1,2 +1,2 @@\n private\n-keep\n+changed\n',
        ),
      },
      true,
    );
    const result = calculateProvenance(
      [base, first, second],
      composeLayers(base, [first, second]),
    );
    expect(result.lines.get('a')?.map((line) => line.owner)).toEqual([
      'first',
      'second',
    ]);
    const deleted = layer('deleted', { 'a.delete': file('') }, true);
    const readded = layer('readded', { a: file('new\n') }, true);
    expect(
      calculateProvenance(
        [base, deleted, readded],
        composeLayers(base, [deleted, readded]),
      ).files.get('a'),
    ).toMatchObject({ operation: 'add', overridesLower: false });
  });

  it('marks replacement over binary lower content at file and line level', () => {
    const base = layer('base', {
      a: { kind: 'file', content: Uint8Array.from([0, 1]), executable: false },
    });
    const overlay = layer('overlay', { a: file('text\n') }, true);
    const result = calculateProvenance(
      [base, overlay],
      composeLayers(base, [overlay]),
    );
    expect(result.files.get('a')?.overridesLower).toBe(true);
    expect(result.lines.get('a')?.[0]?.overridesLower).toBe(true);
  });
});
