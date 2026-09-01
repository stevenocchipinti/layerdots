import { describe, expect, it } from 'vitest';

import { applyUnifiedPatch } from '../../src/composition/patch.js';

describe('applyUnifiedPatch', () => {
  it('applies a Git-compatible patch strictly', () => {
    const result = applyUnifiedPatch(
      new TextEncoder().encode('a\nb\nc\n'),
      new TextEncoder().encode(
        'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
      ),
      'x',
      false,
    );
    expect(new TextDecoder().decode(result.content)).toBe('a\nB\nc\n');
  });

  it('surfaces malformed and non-matching patches as LayerdotsError', () => {
    expect(() =>
      applyUnifiedPatch(
        new TextEncoder().encode('a\n'),
        new TextEncoder().encode('@@ nope\n'),
        'x',
        false,
      ),
    ).toThrow(/file header|hunk/i);
    expect(() =>
      applyUnifiedPatch(
        new TextEncoder().encode('a\n'),
        new TextEncoder().encode(
          '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-bad\n+good\n',
        ),
        'x',
        false,
      ),
    ).toThrow('Patch context does not match');
  });

  it('preserves mixed source endings and uses neighboring endings for additions', () => {
    const result = applyUnifiedPatch(
      new TextEncoder().encode('one\r\ntwo\nthree'),
      new TextEncoder().encode(
        '--- a/config\n+++ b/config\n@@ -1,3 +1,4 @@\n one\r\n+insert\n two\n three\n\\ No newline at end of file\n',
      ),
      'config',
      false,
    );
    expect(new TextDecoder().decode(result.content)).toBe(
      'one\r\ninsert\r\ntwo\nthree',
    );
  });

  it('applies separated hunks while preserving the unchanged gap', () => {
    const result = applyUnifiedPatch(
      new TextEncoder().encode('one\ntwo\nthree\nfour\nfive\n'),
      new TextEncoder().encode(
        '--- a/config\n+++ b/config\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n@@ -4,2 +4,2 @@\n four\n-five\n+FIVE\n',
      ),
      'config',
      false,
    );

    expect(new TextDecoder().decode(result.content)).toBe(
      'ONE\ntwo\nthree\nfour\nFIVE\n',
    );
  });

  it('rejects multiple files, mismatched paths, bad markers, trailing content, and ranges', () => {
    const source = new TextEncoder().encode('a\n');
    const apply = (patch: string) =>
      applyUnifiedPatch(source, new TextEncoder().encode(patch), 'x', false);
    expect(() =>
      apply(
        '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-b\n+c\n',
      ),
    ).toThrow();
    expect(() => apply('--- a/y\n+++ b/y\n@@ -1,1 +1,1 @@\n-a\n+b\n')).toThrow(
      /path/i,
    );
    expect(() =>
      apply(
        '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n',
      ),
    ).toThrow(/newline/i);
    expect(() =>
      apply('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\ntrailing'),
    ).toThrow(/trailing|hunk/i);
    expect(() => apply('--- a/x\n+++ b/x\n@@ -3,1 +3,1 @@\n-a\n+b\n')).toThrow(
      /anchored|range/i,
    );
  });

  it('accepts /dev/null only for an empty source, while composition remains existing-file-only', () => {
    const patch = '--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+new\n';
    expect(() =>
      applyUnifiedPatch(
        new Uint8Array(),
        new TextEncoder().encode(patch),
        'x',
        false,
      ),
    ).not.toThrow();
    expect(() =>
      applyUnifiedPatch(
        sourceBytes('a\n'),
        new TextEncoder().encode(patch),
        'x',
        false,
      ),
    ).toThrow(/dev\/null|source/i);
  });
});

function sourceBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
