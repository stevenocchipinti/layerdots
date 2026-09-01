import { describe, expect, it } from 'vitest';
import { applyUnifiedPatch } from '../../src/composition/patch.js';
import { createUnifiedPatch } from '../../src/assignment/patch-generation.js';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('createUnifiedPatch', () => {
  it.each([
    ['one\r\ntwo', 'one\r\nTHREE'],
    ['', 'added\n'],
    ['removed\n', ''],
    ['one\r\ntwo\r\n', 'one\r\nthree\r\n'],
  ])('round trips exact text bytes', (before, after) => {
    const patch = createUnifiedPatch('config', bytes(before), bytes(after));
    const result = applyUnifiedPatch(bytes(before), patch, 'config', false);
    expect(result.content).toEqual(bytes(after));
  });

  it('rejects binary input', () => {
    expect(() =>
      createUnifiedPatch('x', Uint8Array.from([255]), bytes('x')),
    ).toThrow(/UTF-8/);
  });

  it('rejects mixed newline conversion as unrepresentable', () => {
    expect(() => createUnifiedPatch('x', bytes('a\n'), bytes('a\r\n'))).toThrow(
      expect.objectContaining({ code: 'assignment-patch-unrepresentable' }),
    );
  });

  it('rejects invalid managed paths', () => {
    expect(() => createUnifiedPatch('../x', bytes('a'), bytes('b'))).toThrow(
      expect.objectContaining({ code: 'invalid-path' }),
    );
  });
});
