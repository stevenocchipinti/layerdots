import { LayerdotsError } from '../domain/errors.js';

export interface AppliedPatch {
  readonly content: Uint8Array;
  readonly executable: boolean;
}

type Ending = '' | '\n' | '\r\n';
interface Line {
  readonly text: string;
  readonly ending: Ending;
}
interface PatchLine {
  readonly type: 'context' | 'add' | 'remove';
  readonly text: string;
  readonly noNewline: boolean;
}
interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly PatchLine[];
}

/** Apply exactly one strict Git-style file patch. */
export function applyUnifiedPatch(
  source: Uint8Array,
  patch: Uint8Array,
  expectedPath: string,
  executable: boolean,
): AppliedPatch {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sourceText: string;
  let patchText: string;
  try {
    sourceText = decoder.decode(source);
    patchText = decoder.decode(patch);
  } catch (error) {
    throw patchError('Patch and target must both be valid UTF-8.', error);
  }
  const sourceLines = splitLines(sourceText);
  const lines = patchText.split('\n').map(stripPatchEnding);
  if (patchText.endsWith('\n')) lines.pop();
  const framing = parseFraming(lines, expectedPath, sourceLines.length === 0);
  const hunks = parseHunks(lines, framing.end);
  if (hunks.length === 0) throw patchError('Patch contains no hunks.');

  const output: Line[] = [];
  let sourceIndex = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunk.oldStart === 0 && hunk.oldCount !== 0) {
      throw patchError('A zero-based hunk must have zero old lines.');
    }
    if (hunk.newStart === 0 && hunk.newCount !== 0) {
      throw patchError('A zero-based hunk must have zero new lines.');
    }
    if (start < sourceIndex || start > sourceLines.length) {
      throw patchError('Patch hunk range is not anchored to the target file.');
    }
    const unchangedGap = start - sourceIndex;
    const newStart = output.length + unchangedGap;
    if (
      (hunk.newStart === 0 && newStart !== 0) ||
      (hunk.newStart !== 0 && hunk.newStart - 1 !== newStart)
    ) {
      throw patchError(
        'Patch new-line range is not anchored to the target file.',
      );
    }
    output.push(...sourceLines.slice(sourceIndex, start));
    sourceIndex = start;
    let oldSeen = 0;
    let newSeen = 0;
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        output.push({
          text: line.text,
          ending: line.noNewline
            ? ''
            : additionEnding(sourceLines, sourceIndex),
        });
        newSeen += 1;
        continue;
      }
      const actual = sourceLines[sourceIndex];
      if (actual === undefined || actual.text !== line.text) {
        throw patchError('Patch context does not match the target file.');
      }
      if (line.noNewline !== (actual.ending === '')) {
        throw patchError('No-newline marker does not match the source line.');
      }
      if (line.type === 'context') {
        output.push(actual);
        newSeen += 1;
      }
      oldSeen += 1;
      sourceIndex += 1;
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
      throw patchError('Patch hunk line counts are invalid.');
    }
  }
  output.push(...sourceLines.slice(sourceIndex));
  return {
    content: new TextEncoder().encode(
      output.map((line) => line.text + line.ending).join(''),
    ),
    executable,
  };
}

function parseFraming(
  lines: readonly string[],
  expected: string,
  emptySource: boolean,
): { end: number } {
  let index = 0;
  if (lines[index]?.startsWith('diff --git ')) {
    const match = /^diff --git (\S+) (\S+)$/.exec(lines[index] ?? '');
    if (
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      normalizePath(match[1]) !== expected ||
      normalizePath(match[2]) !== expected
    ) {
      throw patchError(
        'Patch diff header does not identify the expected file.',
      );
    }
    index += 1;
  }
  const oldPath = parseFileHeader(lines[index], '---');
  const newPath = parseFileHeader(lines[index + 1], '+++');
  const oldNull = oldPath === '/dev/null';
  const newNull = newPath === '/dev/null';
  if (
    (oldNull && newNull) ||
    (!oldNull && normalizePath(oldPath) !== expected) ||
    (!newNull && normalizePath(newPath) !== expected)
  ) {
    throw patchError(
      'Patch file paths do not match the expected effective path.',
    );
  }
  if (oldNull !== emptySource)
    throw patchError('Patch /dev/null framing does not match the source.');
  return { end: index + 2 };
}

function parseFileHeader(
  line: string | undefined,
  prefix: '---' | '+++',
): string {
  if (line === undefined || !line.startsWith(`${prefix} `))
    throw patchError('Patch must contain exactly one file header pair.');
  const value = line.slice(4);
  if (value.length === 0 || value.includes('\t') || value.includes(' '))
    throw patchError('Malformed patch file header.');
  return value;
}

function parseHunks(lines: readonly string[], start: number): Hunk[] {
  const hunks: Hunk[] = [];
  let index = start;
  while (index < lines.length) {
    const header = lines[index];
    const match =
      header === undefined
        ? null
        : /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header);
    if (match === null)
      throw patchError('Malformed patch trailing content or hunk header.');
    const hunkLines: PatchLine[] = [];
    let oldSeen = 0;
    let newSeen = 0;
    index += 1;
    while (index < lines.length && !lines[index]?.startsWith('@@ ')) {
      const value = lines[index];
      if (value === '\\ No newline at end of file') {
        const previous = hunkLines.at(-1);
        if (previous === undefined || previous.noNewline)
          throw patchError('Invalid no-newline marker.');
        hunkLines[hunkLines.length - 1] = { ...previous, noNewline: true };
        index += 1;
        continue;
      }
      const prefix = value?.[0];
      if (prefix !== ' ' && prefix !== '+' && prefix !== '-')
        throw patchError('Malformed patch hunk content.');
      if (value === undefined)
        throw patchError('Malformed patch hunk content.');
      hunkLines.push({
        type: prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'remove',
        text: value.slice(1),
        noNewline: false,
      });
      if (prefix !== '+') oldSeen += 1;
      if (prefix !== '-') newSeen += 1;
      index += 1;
    }
    const oldCount = Number(match[2] ?? '1');
    const newCount = Number(match[4] ?? '1');
    if (oldSeen !== oldCount || newSeen !== newCount)
      throw patchError('Patch hunk line counts are invalid.');
    hunks.push({
      oldStart: Number(match[1]),
      oldCount,
      newStart: Number(match[3]),
      newCount,
      lines: hunkLines,
    });
  }
  return hunks;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    const cr = index > start && text[index - 1] === '\r';
    lines.push({
      text: text.slice(start, cr ? index - 1 : index),
      ending: cr ? '\r\n' : '\n',
    });
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: '' });
  return lines;
}

function additionEnding(lines: readonly Line[], index: number): Ending {
  return (
    lines[index - 1]?.ending ||
    lines[index]?.ending ||
    lines.find((line) => line.ending !== '')?.ending ||
    '\n'
  );
}

function stripPatchEnding(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function normalizePath(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function patchError(message: string, cause?: unknown): LayerdotsError {
  return new LayerdotsError(
    message,
    'patch-apply-failed',
    cause === undefined ? undefined : { cause },
  );
}
