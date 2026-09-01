import { describe, expect, it } from 'vitest';
import { mergeThreeWay } from '../../src/synchronization/merge.js';
import type { ManagedObject } from '../../src/domain/objects.js';

const bytes = (value: string | number[] | Uint8Array) =>
  typeof value === 'string'
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
const file = (
  value: string | number[] | Uint8Array,
  executable = false,
): Extract<ManagedObject, { kind: 'file' }> => ({
  kind: 'file',
  content: bytes(value),
  executable,
});
const snap = (objects: Record<string, ManagedObject>) => ({
  objects: new Map(Object.entries(objects)),
});
const text = (object: ManagedObject | undefined) =>
  object?.kind === 'file'
    ? new TextDecoder().decode(object.content)
    : undefined;

describe('mergeThreeWay', () => {
  it.each([
    [
      'parent-only',
      file('base\n'),
      file('base\n'),
      file('parent\n'),
      'parent\n',
    ],
    [
      'overlay-only',
      file('base\n'),
      file('overlay\n'),
      file('base\n'),
      'overlay\n',
    ],
    ['same change', file('base\n'), file('same\n'), file('same\n'), 'same\n'],
  ])('%s changes', (_name, base, ours, theirs, result) => {
    const merged = mergeThreeWay(
      snap({ x: base }),
      snap({ x: ours }),
      snap({ x: theirs }),
    );
    expect(merged.conflicts).toHaveLength(0);
    expect(text(merged.objects.get('x'))).toBe(result);
  });

  it('merges disjoint line edits, insertions, and deletions', () => {
    const base = file('a\nb\nc\nd\n');
    expect(
      text(
        mergeThreeWay(
          snap({ x: base }),
          snap({ x: file('A\nb\nc\nd\n') }),
          snap({ x: file('a\nb\nC\nd\n') }),
        ).objects.get('x'),
      ),
    ).toBe('A\nb\nC\nd\n');
    expect(
      text(
        mergeThreeWay(
          snap({ x: base }),
          snap({ x: file('a\nb\nX\nc\nd\n') }),
          snap({ x: file('a\nb\nc\n') }),
        ).objects.get('x'),
      ),
    ).toBe('a\nb\nX\nc\n');
  });

  it('handles add, delete, and replacement, and reports delete versus edit', () => {
    expect(
      mergeThreeWay(snap({}), snap({ x: file('new') }), snap({})).objects.has(
        'x',
      ),
    ).toBe(true);
    expect(
      mergeThreeWay(snap({ x: file('old') }), snap({}), snap({})).objects.has(
        'x',
      ),
    ).toBe(false);
    expect(
      text(
        mergeThreeWay(
          snap({ x: file('old') }),
          snap({ x: file('ours') }),
          snap({ x: file('old') }),
        ).objects.get('x'),
      ),
    ).toBe('ours');
    expect(
      mergeThreeWay(
        snap({ x: file('old') }),
        snap({}),
        snap({ x: file('new') }),
      ).conflicts,
    ).toHaveLength(1);
  });

  it.each([
    ['review boundary', 'a\nb\n', 'a\nB\nX\n', 'a\nb\nX\n', 'a\nB\nX\n'],
    ['symmetric boundary', 'a\nb\n', 'a\nb\nX\n', 'a\nB\nX\n', 'a\nB\nX\n'],
    [
      'insertion replacement start',
      'a/b/c\n',
      'a/X/B/c\n',
      'a/b/c\n',
      'a/X/B/c\n',
    ],
    [
      'insertion replacement end',
      'a/b/c\n',
      'a/B/c/X\n',
      'a/b/c\n',
      'a/B/c/X\n',
    ],
  ])('%s', (_name, base, ours, theirs, expected) => {
    const result = mergeThreeWay(
      snap({ x: file(base) }),
      snap({ x: file(ours) }),
      snap({ x: file(theirs) }),
    );
    expect(result.conflicts).toHaveLength(0);
    expect(text(result.objects.get('x'))).toBe(expected);
  });

  it.each([
    ['overlap', file('a\nb\nc\n'), file('a\nB\nc\n'), file('a\nC\nc\n')],
    ['binary', file([0, 255]), file([1, 255]), file([2, 255])],
  ])('reports %s conflicts', (_name, base, ours, theirs) => {
    expect(
      mergeThreeWay(snap({ x: base }), snap({ x: ours }), snap({ x: theirs }))
        .conflicts[0]?.path,
    ).toBe('x');
  });

  it('reports symlink, type, executable, and ambiguous repeated-line conflicts', () => {
    expect(
      mergeThreeWay(
        snap({ x: { kind: 'symlink', target: 'a' } }),
        snap({ x: { kind: 'symlink', target: 'b' } }),
        snap({ x: { kind: 'symlink', target: 'c' } }),
      ).conflicts,
    ).toHaveLength(1);
    expect(
      mergeThreeWay(
        snap({ x: file('a') }),
        snap({ x: { kind: 'symlink', target: 'a' } }),
        snap({ x: file('b') }),
      ).conflicts,
    ).toHaveLength(1);
    expect(
      mergeThreeWay(
        snap({ x: file('a', false) }),
        snap({ x: file('a', true) }),
        snap({ x: file('b', false) }),
      ).conflicts,
    ).toHaveLength(1);
    expect(
      mergeThreeWay(
        snap({ x: file('x\nx\n') }),
        snap({ x: file('x\n') }),
        snap({ x: file('x\nY\n') }),
      ).conflicts,
    ).toHaveLength(1);
  });

  it('preserves exact CRLF and missing-final-newline bytes and does not mutate inputs', () => {
    const baseBytes = bytes('one\r\ntwo\r\nthree');
    const oursBytes = bytes('ONE\r\ntwo\r\nthree');
    const theirsBytes = bytes('one\r\ntwo\r\nTHREE');
    const base = snap({ x: file(baseBytes) }),
      ours = snap({ x: file(oursBytes) }),
      theirs = snap({ x: file(theirsBytes) });
    const before = [...base.objects.keys()];
    const result = mergeThreeWay(base, ours, theirs).objects.get('x');
    expect(result).toMatchObject({ kind: 'file' });
    expect(result && result.kind === 'file' ? result.content : []).toEqual(
      bytes('ONE\r\ntwo\r\nTHREE'),
    );
    expect([...base.objects.keys()]).toEqual(before);
    const original = base.objects.get('x');
    expect(original?.kind === 'file' ? original.content : []).toEqual(
      baseBytes,
    );
  });

  it('deep clones conflict data', () => {
    const base = file('a\nb\n'),
      ours = file('a\nB\n'),
      theirs = file('a\nC\n');
    const conflict = mergeThreeWay(
      snap({ x: base }),
      snap({ x: ours }),
      snap({ x: theirs }),
    ).conflicts[0];
    if (conflict?.base?.kind === 'file') conflict.base.content[0] = 0;
    if (conflict?.ours?.kind === 'file') conflict.ours.content[0] = 0;
    if (conflict?.theirs?.kind === 'file') conflict.theirs.content[0] = 0;
    if (conflict?.text) conflict.text[0] = 0;
    expect(base.content[0]).toBe(97);
    expect(ours.content[0]).toBe(97);
    expect(theirs.content[0]).toBe(97);
  });
});
