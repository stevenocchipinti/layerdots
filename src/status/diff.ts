import type { ManagedObject } from '../domain/objects.js';
import { classifyFileContent } from '../repositories/tree-reader.js';
import type { ManagedStatusEntry } from './status.js';

export type DiffColor = 'always' | 'never';

const ansi = {
  reset: '\u001b[0m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

export function renderManagedDiff(
  entries: readonly ManagedStatusEntry[],
  options: { readonly color: DiffColor },
): string {
  const color = options.color === 'always';
  const output: string[] = [];
  for (const entry of [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    output.push(
      style(`${entry.status.toUpperCase()} ${entry.path}`, ansi.cyan, color),
    );
    if (entry.status === 'unchanged') continue;
    const text = canRenderText(entry);
    if (text && hasExecutableChange(entry)) {
      output.push(renderMetadata(entry, color));
    }
    if (text) {
      output.push(...renderTextDiff(entry, color));
    } else {
      output.push(renderMetadata(entry, color));
    }
  }
  return output.join('\n') + (output.length === 0 ? '' : '\n');
}

function canRenderText(entry: ManagedStatusEntry): boolean {
  const before = entry.expected;
  const after = entry.actual;
  return (
    (before === undefined || before.kind === 'file') &&
    (after === undefined || after.kind === 'file') &&
    (before === undefined || classifyFileContent(before.content) === 'text') &&
    (after === undefined || classifyFileContent(after.content) === 'text')
  );
}

function hasExecutableChange(entry: ManagedStatusEntry): boolean {
  return (
    entry.expected?.kind === 'file' &&
    entry.actual?.kind === 'file' &&
    entry.expected.executable !== entry.actual.executable
  );
}

function renderTextDiff(entry: ManagedStatusEntry, color: boolean): string[] {
  const before =
    entry.expected?.kind === 'file' ? entry.expected.content : undefined;
  const after =
    entry.actual?.kind === 'file' ? entry.actual.content : undefined;
  const oldLines = splitLines(before === undefined ? new Uint8Array() : before);
  const newLines = splitLines(after === undefined ? new Uint8Array() : after);
  const lines: string[] = ['--- expected', '+++ actual', '@@'];
  for (const edit of lineEdits(oldLines, newLines)) {
    const prefix =
      edit.kind === 'same' ? ' ' : edit.kind === 'remove' ? '-' : '+';
    const code =
      edit.kind === 'remove' ? ansi.red : edit.kind === 'add' ? ansi.green : '';
    lines.push(
      style(formatLine(prefix, edit.line), code, color && code !== ''),
    );
    if (edit.kind !== 'same' && edit.line.ending === '') {
      lines.push('\\ No newline at end of file');
    }
  }
  return lines;
}

interface LineEdit {
  readonly kind: 'same' | 'add' | 'remove';
  readonly line: TextLine;
}

function lineEdits(
  oldLines: readonly TextLine[],
  newLines: readonly TextLine[],
): LineEdit[] {
  const lengths = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const row = lengths[oldIndex];
      const nextRow = lengths[oldIndex + 1];
      const oldLine = oldLines[oldIndex];
      const newLine = newLines[newIndex];
      if (
        row === undefined ||
        nextRow === undefined ||
        oldLine === undefined ||
        newLine === undefined
      ) {
        throw new Error('Invalid line diff state');
      }
      row[newIndex] = equalLines(oldLine, newLine)
        ? 1 + (nextRow[newIndex + 1] ?? 0)
        : Math.max(nextRow[newIndex] ?? 0, row[newIndex + 1] ?? 0);
    }
  }

  const edits: LineEdit[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];
    if (
      oldLine !== undefined &&
      newLine !== undefined &&
      equalLines(oldLine, newLine)
    ) {
      edits.push({ kind: 'same', line: oldLine });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newLine !== undefined &&
      (oldLine === undefined ||
        (lengths[oldIndex]?.[newIndex + 1] ?? 0) >
          (lengths[oldIndex + 1]?.[newIndex] ?? 0))
    ) {
      edits.push({ kind: 'add', line: newLine });
      newIndex += 1;
    } else if (oldLine !== undefined) {
      edits.push({ kind: 'remove', line: oldLine });
      oldIndex += 1;
    }
  }
  return edits;
}

function equalLines(left: TextLine, right: TextLine): boolean {
  return left.text === right.text && left.ending === right.ending;
}

function formatLine(prefix: string, line: TextLine): string {
  return `${prefix}${line.text}${line.ending === '\r\n' ? '\r' : ''}`;
}

interface TextLine {
  readonly text: string;
  readonly ending: string;
}

function splitLines(content: Uint8Array): TextLine[] {
  const text = new TextDecoder().decode(content);
  if (text.length === 0) return [];
  const result: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    const cr = index > start && text[index - 1] === '\r';
    result.push({
      text: text.slice(start, cr ? index - 1 : index),
      ending: cr ? '\r\n' : '\n',
    });
    start = index + 1;
  }
  if (start < text.length) result.push({ text: text.slice(start), ending: '' });
  return result;
}

function renderMetadata(entry: ManagedStatusEntry, color: boolean): string {
  const before = describe(entry.expected);
  const after = describe(entry.actual);
  return style(`${before} -> ${after}`, ansi.yellow, color);
}

function describe(object: ManagedObject | undefined): string {
  if (object === undefined) return 'absent';
  if (object.kind === 'symlink')
    return `symlink ${JSON.stringify(object.target)}`;
  const kind =
    classifyFileContent(object.content) === 'text' ? 'text' : 'binary';
  return `${kind} (${String(object.content.length)} bytes${object.executable ? ', executable' : ''})`;
}

function style(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ansi.reset}` : value;
}
