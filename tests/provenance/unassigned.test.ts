import { describe, expect, it } from 'vitest';
import type { LayerSnapshot, ManagedObject } from '../../src/domain/objects.js';
import { composeLayers } from '../../src/composition/compose.js';
import { detectUnassignedChanges } from '../../src/provenance/unassigned.js';

const file = (text: string): ManagedObject => ({
  kind: 'file',
  content: new TextEncoder().encode(text),
  executable: false,
});
const base: LayerSnapshot = {
  id: 'base',
  root: '.',
  manifest: { version: 1 },
  objects: new Map([['a', file('a\nb\nc\n')]]),
};

describe('unassigned changes', () => {
  it('detects insertion, deletion, replacement, candidate paths, and unchanged state', () => {
    const composed = composeLayers(base);
    const target = new Map([
      ['a', file('a\nnew\nc\n')],
      ['extra', file('x')],
    ]);
    const changes = detectUnassignedChanges([base], composed, target, [
      'extra',
    ]);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ path: 'a', owner: 'unassigned' });
    expect(changes[0]?.hunks[0]).toMatchObject({ oldCount: 1, newCount: 1 });
    expect(changes[1]).toMatchObject({ path: 'extra', owner: 'unassigned' });
    expect(
      detectUnassignedChanges(
        [base],
        composed,
        new Map([['a', file('a\nb\nc\n')]]),
      ),
    ).toEqual([]);
  });

  it.each([
    ['', 'x\n', 0, 0, 1, 1],
    ['a\n', 'x\na\n', 0, 0, 1, 1],
    ['a\nb\n', 'a\nx\nb\n', 1, 0, 2, 1],
    ['a\n', 'a\nx\n', 1, 0, 2, 1],
    ['x\n', '', 1, 1, 0, 0],
  ])(
    'reports Git ranges for boundary edits',
    (before, after, oldStart, oldCount, newStart, newCount) => {
      const expected: LayerSnapshot = {
        id: 'x',
        root: '.',
        manifest: { version: 1 },
        objects: new Map([['a', file(before)]]),
      };
      const change = detectUnassignedChanges(
        [expected],
        composeLayers(expected),
        new Map([['a', file(after)]]),
      )[0];
      expect(change?.hunks[0]).toMatchObject({
        oldStart,
        oldCount,
        newStart,
        newCount,
      });
      expect(change?.hunks[0]?.edits.length).toBeGreaterThan(0);
    },
  );

  it('reports whole-object changes and ignores absent candidates', () => {
    const composed = composeLayers(base);
    const target = new Map<string, ManagedObject>([
      [
        'binary',
        { kind: 'file', content: Uint8Array.from([1]), executable: false },
      ],
      ['link', { kind: 'symlink', target: 'a' }],
      ['a', { kind: 'symlink', target: 'a' }],
    ]);
    const changes = detectUnassignedChanges([base], composed, target, [
      'missing',
    ]);
    expect(changes.find((change) => change.path === 'missing')).toBeUndefined();
    expect(changes.find((change) => change.path === 'a')?.kind).toBe(
      'whole-object',
    );
  });
});
