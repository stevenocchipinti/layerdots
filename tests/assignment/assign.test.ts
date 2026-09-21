/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-condition */
import { describe, expect, it } from 'vitest';
import type { LayerManifestV1 } from '../../src/domain/manifest.js';
import type { LayerSnapshot, ManagedObject } from '../../src/domain/objects.js';
import { composeLayers } from '../../src/composition/compose.js';
import { detectUnassignedChanges } from '../../src/provenance/unassigned.js';
import { assignUnassignedChange } from '../../src/assignment/assign.js';
import { equalManagedObjects } from '../../src/domain/objects.js';
import type { UnassignedHunk } from '../../src/provenance/unassigned.js';

const file = (
  text: string | Uint8Array,
  executable = false,
): ManagedObject => ({
  kind: 'file',
  content:
    typeof text === 'string'
      ? new TextEncoder().encode(text)
      : new Uint8Array(text),
  executable,
});
const baseManifest: LayerManifestV1 = { version: 1 };
const overlayManifest: LayerManifestV1 = {
  version: 1,
  parent: { url: 'x', branch: 'main', commit: 'x' },
};
const snapshot = (
  id: string,
  manifest: LayerManifestV1,
  objects: Record<string, ManagedObject>,
): LayerSnapshot => ({
  id,
  root: '.',
  manifest,
  objects: new Map(Object.entries(objects)),
});
const text = (object: ManagedObject | undefined) =>
  object?.kind === 'file'
    ? new TextDecoder().decode(object.content)
    : undefined;

function change(
  layers: LayerSnapshot[],
  target: Map<string, ManagedObject>,
  path = 'config',
): ReturnType<typeof detectUnassignedChanges>[number] {
  const first = layers[0];
  if (!first) throw new Error('missing base');
  const composed = composeLayers(first, layers.slice(1));
  const result = detectUnassignedChanges(layers, composed, target, [path]).find(
    (item) => item.path === path,
  );
  if (!result) throw new Error('missing change');
  return result;
}

describe('assignUnassignedChange', () => {
  it('routes a hunk to an overlay and preserves the effective target', () => {
    const base = snapshot('base', baseManifest, {
      config: file('public\nkeep\n'),
    });
    const overlay = snapshot('work', overlayManifest, {
      'config.patch': file(
        '--- a/config\n+++ b/config\n@@ -1,2 +1,2 @@\n public\n-keep\n+private\n',
      ),
    });
    const layers = [base, overlay];
    const target = new Map([['config', file('public\nlocal\n')]]);
    const before = composeLayers(base, [overlay]);
    const result = assignUnassignedChange({
      layers,
      composed: before,
      change: change(layers, target),
      hunkIndexes: [0],
      destinationLayerId: 'work',
    });
    expect(
      text(
        composeLayers(result.layers[0]!, result.layers.slice(1)).objects.get(
          'config',
        ),
      ),
    ).toBe('public\nlocal\n');
    expect(result.layers[0]).not.toBe(base);
    expect(text(base.objects.get('config'))).toBe('public\nkeep\n');
  });

  it('projects a public hunk to the base without copying private overlay lines', () => {
    const base = snapshot('base', baseManifest, {
      config: file('public\nkeep\n'),
    });
    const overlay = snapshot('work', overlayManifest, {
      'config.patch': file(
        '--- a/config\n+++ b/config\n@@ -1,2 +1,2 @@\n public\n-keep\n+private\n',
      ),
    });
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const target = new Map([['config', file('changed\nprivate\n')]]);
    const result = assignUnassignedChange({
      layers,
      composed,
      change: change(layers, target),
      hunkIndexes: [0],
      destinationLayerId: 'base',
    });
    const next = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(text(next.objects.get('config'))).toBe('changed\nprivate\n');
    expect(text(result.layers[0]!.objects.get('config'))).toBe(
      'changed\nkeep\n',
    );
  });

  it('does not create an identity patch in an overlay that does not represent the path', () => {
    const base = snapshot('base', baseManifest, {
      bashrc: file('export EDITOR=nano\n'),
    });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const target = new Map([['bashrc', file('export EDITOR=vim\n')]]);
    const result = assignUnassignedChange({
      layers,
      composed: composeLayers(base, [overlay]),
      change: change(layers, target, 'bashrc'),
      hunkIndexes: [0],
      destinationLayerId: 'base',
    });
    expect(result.layers[1]!.objects.has('bashrc.patch')).toBe(false);
    expect(
      text(
        composeLayers(result.layers[0]!, result.layers.slice(1)).objects.get(
          'bashrc',
        ),
      ),
    ).toBe('export EDITOR=vim\n');
  });

  it.each([
    ['added', undefined, file('new')],
    ['deleted', file('old'), undefined],
    ['binary', file(Uint8Array.from([1, 2])), file(Uint8Array.from([3, 4]))],
  ])('routes whole-object %s changes', (_name, expected, actual) => {
    const base = snapshot(
      'base',
      baseManifest,
      expected ? { x: expected } : {},
    );
    const layers = [base];
    const composed = composeLayers(base);
    const target = new Map<string, ManagedObject>();
    if (actual) target.set('x', actual);
    const path = expected ? 'x' : 'x';
    const result = assignUnassignedChange({
      layers,
      composed,
      change: change(layers, target, path),
      hunkIndexes: [0],
      destinationLayerId: 'base',
    });
    expect(result.layers[0]!.objects.has(path)).toBe(Boolean(actual));
  });

  it('rejects invalid hunks and ambiguous base ancestry', () => {
    const base = snapshot('base', baseManifest, {
      config: file('same\nsame\n'),
    });
    const layers = [base];
    const composed = composeLayers(base);
    const target = new Map([['config', file('changed\nsame\n')]]);
    const item = change(layers, target);
    expect(() =>
      assignUnassignedChange({
        layers,
        composed,
        change: item,
        hunkIndexes: [4],
        destinationLayerId: 'base',
      }),
    ).toThrow(/hunk/i);
    expect(() =>
      assignUnassignedChange({
        layers,
        composed,
        change: item,
        hunkIndexes: [0],
        destinationLayerId: 'missing',
      }),
    ).toThrow(/layer/i);
  });

  it('selects separated hunks independently and all hunks reproduce the target', () => {
    const base = snapshot('base', baseManifest, {
      config: file('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n'),
    });
    const layers = [base];
    const composed = composeLayers(base);
    const target = new Map([
      ['config', file('a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n')],
    ]);
    const item = change(layers, target);
    expect(item.hunks.length).toBe(2);
    const later = assignUnassignedChange({
      layers,
      composed,
      change: item,
      hunkIndexes: [1],
      destinationLayerId: 'base',
    });
    expect(
      text(composeLayers(later.layers[0]!, []).objects.get('config')),
    ).toBe('a\nb\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n');
    const all = assignUnassignedChange({
      layers,
      composed,
      change: item,
      hunkIndexes: [0, 1],
      destinationLayerId: 'base',
    });
    expect(
      equalManagedObjects(
        all.layers[0]!.objects.get('config')!,
        target.get('config')!,
      ),
    ).toBe(true);
  });

  it.each([
    ['start', 'X\na\nb\n'],
    ['middle', 'a\nX\nb\n'],
    ['eof', 'a\nb\nX\n'],
  ])('projects pure insertion at %s exactly', (_where, value) => {
    const base = snapshot('base', baseManifest, { config: file('a\nb\n') });
    const layers = [base];
    const composed = composeLayers(base);
    const target = new Map([['config', file(value)]]);
    const result = assignUnassignedChange({
      layers,
      composed,
      change: change(layers, target),
      hunkIndexes: [0],
      destinationLayerId: 'base',
    });
    expect(
      text(composeLayers(result.layers[0]!, []).objects.get('config')),
    ).toBe(value);
  });

  it('preserves private lines through two overlays and invalidates both pins', () => {
    const base = snapshot('base', baseManifest, {
      config: file('public\nbase\n'),
    });
    const one = snapshot('one', overlayManifest, {
      'config.patch': file(
        '--- a/config\n+++ b/config\n@@ -1,2 +1,3 @@\n public\n+private-inserted\n base\n',
      ),
    });
    const two = snapshot('two', overlayManifest, {
      'config.patch': file(
        '--- a/config\n+++ b/config\n@@ -1,3 +1,3 @@\n public\n private-inserted\n-base\n+private-replaced\n',
      ),
    });
    const layers = [base, one, two];
    const composed = composeLayers(base, [one, two]);
    const target = new Map([
      ['config', file('changed\nprivate-inserted\nprivate-replaced\n')],
    ]);
    const result = assignUnassignedChange({
      layers,
      composed,
      change: change(layers, target),
      hunkIndexes: [0],
      destinationLayerId: 'base',
    });
    const final = composeLayers(
      result.layers[0]!,
      result.layers.slice(1),
    ).objects.get('config');
    expect(text(final)).toBe('changed\nprivate-inserted\nprivate-replaced\n');
    expect(
      new TextDecoder().decode(
        (
          result.layers[0]!.objects.get('config') as Extract<
            ManagedObject,
            { kind: 'file' }
          >
        ).content,
      ),
    ).not.toContain('private');
    expect(result.invalidatedParentPins).toEqual(['one', 'two']);
  });

  it.each([
    ['binary', file(Uint8Array.from([1, 2, 3])), file(Uint8Array.from([9, 8]))],
    [
      'symlink',
      { kind: 'symlink', target: 'old' } as ManagedObject,
      { kind: 'symlink', target: 'new' } as ManagedObject,
    ],
    ['executable', file('new', true), file('new', false)],
    [
      'type-change',
      file('old'),
      { kind: 'symlink', target: 'new' } as ManagedObject,
    ],
  ])(
    'top overlay whole-object routes %s exactly',
    (_name, expected, actual) => {
      const base = snapshot('base', baseManifest, { x: expected });
      const overlay = snapshot('overlay', overlayManifest, {});
      const layers = [base, overlay];
      const composed = composeLayers(base, [overlay]);
      const target = new Map([['x', actual]]);
      const result = assignUnassignedChange({
        layers,
        composed,
        change: change(layers, target, 'x'),
        hunkIndexes: [0],
        destinationLayerId: 'overlay',
      });
      const output = composeLayers(
        result.layers[0]!,
        result.layers.slice(1),
      ).objects.get('x');
      expect(output && actual && equalManagedObjects(output, actual)).toBe(
        true,
      );
    },
  );

  it.each([
    ['add', {}, { x: file('new') }],
    ['delete', { x: file('old') }, {}],
  ])(
    'top overlay whole-object routes %s with exact path presence',
    (_name, lower, upper) => {
      const base = snapshot('base', baseManifest, lower);
      const overlay = snapshot('overlay', overlayManifest, {});
      const layers = [base, overlay];
      const composed = composeLayers(base, [overlay]);
      const target = new Map(Object.entries(upper));
      const result = assignUnassignedChange({
        layers,
        composed,
        change: change(layers, target, 'x'),
        hunkIndexes: [0],
        destinationLayerId: 'overlay',
      });
      expect(
        composeLayers(result.layers[0]!, result.layers.slice(1)).objects.has(
          'x',
        ),
      ).toBe('x' in upper);
    },
  );

  it('rejects lower whole-object routing when an overlay owns the path', () => {
    const base = snapshot('base', baseManifest, { x: file('base') });
    const overlay = snapshot('overlay', overlayManifest, {
      x: file('private'),
    });
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const target = new Map<string, ManagedObject>();
    const item = change(layers, target, 'x');
    expect(() =>
      assignUnassignedChange({
        layers,
        composed,
        change: item,
        hunkIndexes: [0],
        destinationLayerId: 'base',
      }),
    ).toThrow(expect.objectContaining({ code: 'assignment-ambiguous' }));
  });

  it('falls back to a plain overlay replacement for newline conversion', () => {
    const base = snapshot('base', baseManifest, { x: file('a\n') });
    const overlay = snapshot('overlay', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const target = new Map([['x', file('a\r\n')]]);
    const result = assignUnassignedChange({
      layers,
      composed,
      change: change(layers, target, 'x'),
      hunkIndexes: [0],
      destinationLayerId: 'overlay',
    });
    expect(result.layers[1]!.objects.has('x')).toBe(true);
    expect(
      text(
        composeLayers(result.layers[0]!, result.layers.slice(1)).objects.get(
          'x',
        ),
      ),
    ).toBe('a\r\n');
  });

  it('rejects stale composition and malformed hunk with LayerdotsError codes', () => {
    const base = snapshot('base', baseManifest, { config: file('a\nb\n') });
    const layers = [base];
    const composed = composeLayers(base);
    const item = change(layers, new Map([['config', file('a\nB\n')]]));
    expect(() =>
      assignUnassignedChange({
        layers,
        composed: composeLayers(
          snapshot('other', baseManifest, { config: file('z') }),
        ),
        change: item,
        hunkIndexes: [0],
        destinationLayerId: 'base',
      }),
    ).toThrow(expect.objectContaining({ code: 'assignment-stale' }));
    const malformed: typeof item = {
      ...item,
      hunks: [
        {
          ...item.hunks[0]!,
          edits: [
            {
              ...item.hunks[0]!.edits[0]!,
              line: { text: 'wrong', ending: '\n' as const },
            },
          ],
        },
      ],
    };
    expect(() =>
      assignUnassignedChange({
        layers,
        composed,
        change: malformed,
        hunkIndexes: [0],
        destinationLayerId: 'base',
      }),
    ).toThrow(expect.objectContaining({ code: 'assignment-invalid' }));
  });

  it.each([
    [
      'omit removal',
      (hunk: UnassignedHunk) => ({
        ...hunk,
        edits: hunk.edits.filter((edit) => edit.kind !== 'remove'),
      }),
    ],
    [
      'omit addition',
      (hunk: UnassignedHunk) => ({
        ...hunk,
        edits: hunk.edits.filter((edit) => edit.kind !== 'add'),
      }),
    ],
    [
      'reorder edits',
      (hunk: UnassignedHunk) => ({ ...hunk, edits: [...hunk.edits].reverse() }),
    ],
    [
      'lie about counts',
      (hunk: UnassignedHunk) => ({ ...hunk, oldCount: hunk.oldCount + 1 }),
    ],
    [
      'lie about ranges',
      (hunk: UnassignedHunk) => ({ ...hunk, oldStart: hunk.oldStart + 1 }),
    ],
    [
      'misuse indices',
      (hunk: UnassignedHunk) => ({
        ...hunk,
        edits: hunk.edits.map((edit, index) =>
          index === 0
            ? {
                ...edit,
                newIndex: edit.newIndex === undefined ? 0 : edit.newIndex + 1,
              }
            : edit,
        ),
      }),
    ],
    [
      'invalid context',
      (hunk: UnassignedHunk) => ({
        ...hunk,
        contextBefore: [
          {
            ...hunk.edits[0]!,
            kind: 'same' as const,
            oldIndex: 99,
            newIndex: 99,
          },
        ],
      }),
    ],
  ])('rejects structurally invalid hunk: %s', (_label, mutate) => {
    const base = snapshot('base', baseManifest, { config: file('a\nb\nc\n') });
    const layers = [base];
    const composed = composeLayers(base);
    const item = change(layers, new Map([['config', file('a\nB\nc\n')]]));
    const validHunk = item.hunks[0];
    if (!validHunk) throw new Error('missing hunk');
    const malformed = { ...item, hunks: [mutate(validHunk)] };
    expect(() =>
      assignUnassignedChange({
        layers,
        composed,
        change: malformed,
        hunkIndexes: [0],
        destinationLayerId: 'base',
      }),
    ).toThrow(expect.objectContaining({ code: 'assignment-invalid' }));
  });

  it('does not alias input or returned object bytes', () => {
    const original = file('a\nb\n');
    const base = snapshot('base', baseManifest, { config: original });
    const composed = composeLayers(base);
    const target = new Map([['config', file('a\nB\n')]]);
    const item = change([base], target);
    const result = assignUnassignedChange({
      layers: [base],
      composed,
      change: item,
      hunkIndexes: [0],
      destinationLayerId: 'base',
    });
    const output = result.layers[0]!.objects.get('config');
    if (!output || output.kind !== 'file') throw new Error('expected file');
    output.content[0] = 90;
    if (original.kind !== 'file') throw new Error('expected file');
    expect(new TextDecoder().decode(original.content)).toBe('a\nb\n');
    const expected = item.expected;
    if (!expected || expected.kind !== 'file') throw new Error('expected file');
    expect(new TextDecoder().decode(expected.content)).toBe('a\nb\n');
  });
});
