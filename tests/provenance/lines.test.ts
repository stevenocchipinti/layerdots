import { describe, expect, it } from 'vitest';
import { alignLines, splitText } from '../../src/provenance/lines.js';

describe('line provenance utilities', () => {
  it('preserves CRLF and a missing final newline', () => {
    expect(splitText('one\r\ntwo')).toEqual([
      { text: 'one', ending: '\r\n' },
      { text: 'two', ending: '' },
    ]);
  });

  it('marks equally optimal repeated-line ancestry ambiguous', () => {
    const result = alignLines(splitText('x\nx\n'), splitText('x\n'));
    expect(result.ambiguousNew.has(0)).toBe(true);
  });

  it('keeps forced duplicate matches unambiguous', () => {
    expect(
      alignLines(splitText('x\nx\n'), splitText('x\nx\n')).ambiguousNew.size,
    ).toBe(0);
  });

  it('marks reordered optimal alternatives ambiguous', () => {
    expect(
      alignLines(splitText('a\nb\n'), splitText('b\na\n')).ambiguousNew.size,
    ).toBe(2);
  });
});
