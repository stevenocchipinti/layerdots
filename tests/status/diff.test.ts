import { describe, expect, it } from 'vitest';
import { renderManagedDiff } from '../../src/status/diff.js';
import type { ManagedStatusEntry } from '../../src/status/status.js';
import type { ManagedObject } from '../../src/domain/objects.js';

const file = (content: string, executable = false): ManagedObject => ({
  kind: 'file',
  content: new TextEncoder().encode(content),
  executable,
});
const entry = (
  path: string,
  status: ManagedStatusEntry['status'],
  expected?: ManagedObject,
  actual?: ManagedObject,
): ManagedStatusEntry => ({
  path,
  status,
  ...(expected ? { expected } : {}),
  ...(actual ? { actual } : {}),
});

describe('renderManagedDiff', () => {
  it('renders sorted textual diffs and missing newline signals', () => {
    const output = renderManagedDiff(
      [
        entry('z', 'added', undefined, file('new\r\n')),
        entry('a', 'modified', file('old\r\n'), file('new')),
      ],
      { color: 'never' },
    );
    expect(output.indexOf('MODIFIED a')).toBeLessThan(
      output.indexOf('ADDED z'),
    );
    expect(output).toContain('-old');
    expect(output).toContain('+new');
    expect(output).toContain('\\ No newline at end of file');
  });

  it('uses metadata for binary, symlink, type, and executable changes', () => {
    const output = renderManagedDiff(
      [
        entry(
          'bin',
          'modified',
          {
            kind: 'file',
            content: Uint8Array.from([0, 255]),
            executable: false,
          },
          {
            kind: 'file',
            content: Uint8Array.from([0, 254]),
            executable: false,
          },
        ),
        entry(
          'link',
          'modified',
          { kind: 'symlink', target: 'a' },
          { kind: 'symlink', target: 'b' },
        ),
        entry('mode', 'modified', file('x'), file('x', true)),
        entry('type', 'type-changed', file('x'), {
          kind: 'symlink',
          target: 'x',
        }),
      ],
      { color: 'never' },
    );
    expect(output).toContain('binary (2 bytes) -> binary (2 bytes)');
    expect(output).toContain('symlink "a" -> symlink "b"');
    expect(output).toContain('text (1 bytes) -> text (1 bytes, executable)');
    expect(output).not.toContain('�');
  });

  it('adds ANSI escapes only in always mode and keeps status labels', () => {
    const entries = [entry('x', 'modified', file('a'), file('b'))];
    expect(renderManagedDiff(entries, { color: 'never' })).not.toContain(
      '\u001b[',
    );
    expect(renderManagedDiff(entries, { color: 'always' })).toContain(
      '\u001b[',
    );
    expect(renderManagedDiff(entries, { color: 'always' })).toContain(
      'MODIFIED x',
    );
  });

  it('renders an insertion without replacing unchanged following lines', () => {
    const output = renderManagedDiff(
      [entry('x', 'modified', file('one\ntwo\n'), file('one\nnew\ntwo\n'))],
      { color: 'never' },
    );

    expect(output).toContain(' one\n+new\n two');
    expect(output).not.toContain('-two');
  });
});
