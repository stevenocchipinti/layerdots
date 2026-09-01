import { describe, expect, it } from 'vitest';
import { compareManagedState } from '../../src/status/status.js';
import type { ManagedObject } from '../../src/domain/objects.js';

const file = (content: string, executable = false): ManagedObject => ({
  kind: 'file',
  content: new TextEncoder().encode(content),
  executable,
});

describe('compareManagedState', () => {
  it('classifies the union in deterministic order', () => {
    const expected = new Map<string, ManagedObject>([
      ['same', file('x')],
      ['changed', file('x')],
      ['gone', file('x')],
      ['kind', file('x')],
      ['link', { kind: 'symlink', target: 'a' }],
    ]);
    const actual = new Map<string, ManagedObject>([
      ['same', file('x')],
      ['changed', file('y')],
      ['new', file('z')],
      ['kind', { kind: 'symlink', target: 'x' }],
      ['link', { kind: 'symlink', target: 'b' }],
    ]);
    expect(compareManagedState(expected, actual)).toMatchObject([
      { path: 'changed', status: 'modified' },
      { path: 'gone', status: 'deleted' },
      { path: 'kind', status: 'type-changed' },
      { path: 'link', status: 'modified' },
      { path: 'new', status: 'added' },
      { path: 'same', status: 'unchanged' },
    ]);
  });

  it('detects executable and byte changes without crawling anything', () => {
    const expected = new Map([
      ['script', file('x', false)],
      [
        'binary',
        {
          kind: 'file' as const,
          content: Uint8Array.from([0, 255]),
          executable: false,
        },
      ],
    ]);
    const actual = new Map([
      ['script', file('x', true)],
      [
        'binary',
        {
          kind: 'file' as const,
          content: Uint8Array.from([0, 254]),
          executable: false,
        },
      ],
    ]);
    expect(
      compareManagedState(expected, actual).map((entry) => entry.status),
    ).toEqual(['modified', 'modified']);
  });
});
