import type { ManagedObject } from '../domain/objects.js';

export interface TextLine {
  readonly text: string;
  readonly ending: '' | '\n' | '\r\n';
}

export type LineMatch =
  | {
      readonly kind: 'same';
      readonly oldIndex: number;
      readonly newIndex: number;
    }
  | { readonly kind: 'add'; readonly newIndex: number }
  | { readonly kind: 'remove'; readonly oldIndex: number };

export interface LineAlignment {
  readonly edits: readonly LineMatch[];
  readonly possibleOldIndices: ReadonlyMap<number, ReadonlySet<number>>;
  readonly ambiguousNew: ReadonlySet<number>;
}

export function splitTextLines(content: Uint8Array): TextLine[] {
  return splitText(new TextDecoder('utf-8', { fatal: true }).decode(content));
}

export function splitText(text: string): TextLine[] {
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

export function equalTextLines(left: TextLine, right: TextLine): boolean {
  return left.text === right.text && left.ending === right.ending;
}

/** LCS alignment. A line is ambiguous if its ancestry is not uniquely determined. */
export function alignLines(
  oldLines: readonly TextLine[],
  newLines: readonly TextLine[],
): LineAlignment {
  const score = Array.from(
    { length: oldLines.length + 1 },
    () => Array(newLines.length + 1).fill(0) as number[],
  );
  for (let i = oldLines.length - 1; i >= 0; i -= 1)
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const match = equalTextLines(
        oldLines[i] as TextLine,
        newLines[j] as TextLine,
      )
        ? (score[i + 1]?.[j + 1] ?? 0) + 1
        : -1;
      const skipOld = score[i + 1]?.[j] ?? 0;
      const skipNew = score[i]?.[j + 1] ?? 0;
      const scoreRow = score[i];
      if (!scoreRow) throw new Error('Invalid line alignment state');
      scoreRow[j] = Math.max(match, skipOld, skipNew);
    }
  const possibleOldIndices = new Map<number, Set<number>>();
  const skippableNew = new Set<number>();
  const edits: LineMatch[] = [];
  const ambiguousNew = new Set<number>();
  const visited = new Set<string>();
  const queue: Array<[number, number]> = [[0, 0]];
  while (queue.length > 0) {
    const state = queue.shift();
    if (!state) continue;
    const [i, j] = state;
    const key = String(i) + ':' + String(j);
    if (visited.has(key)) continue;
    visited.add(key);
    const value = score[i]?.[j] ?? 0;
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (
      oldLine &&
      newLine &&
      equalTextLines(oldLine, newLine) &&
      value === 1 + (score[i + 1]?.[j + 1] ?? 0)
    ) {
      const indices = possibleOldIndices.get(j) ?? new Set<number>();
      indices.add(i);
      possibleOldIndices.set(j, indices);
      queue.push([i + 1, j + 1]);
    }
    if (i < oldLines.length && value === (score[i + 1]?.[j] ?? 0))
      queue.push([i + 1, j]);
    if (j < newLines.length && value === (score[i]?.[j + 1] ?? 0)) {
      skippableNew.add(j);
      queue.push([i, j + 1]);
    }
  }
  for (const [index, candidates] of possibleOldIndices) {
    if (candidates.size > 1 || skippableNew.has(index)) ambiguousNew.add(index);
  }
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (
      oldLine &&
      newLine &&
      equalTextLines(oldLine, newLine) &&
      (score[i]?.[j] ?? 0) === (score[i + 1]?.[j + 1] ?? 0) + 1
    ) {
      if ((possibleOldIndices.get(j)?.size ?? 0) > 1) ambiguousNew.add(j);
      edits.push({ kind: 'same', oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
    } else if (
      newLine &&
      (oldLine === undefined ||
        (score[i]?.[j + 1] ?? 0) >= (score[i + 1]?.[j] ?? 0))
    ) {
      edits.push({ kind: 'add', newIndex: j });
      j += 1;
    } else {
      edits.push({ kind: 'remove', oldIndex: i });
      i += 1;
    }
  }
  return { edits, possibleOldIndices, ambiguousNew };
}

export function isTextFile(
  object: ManagedObject | undefined,
): object is Extract<ManagedObject, { kind: 'file' }> {
  if (object?.kind !== 'file') return false;
  try {
    splitTextLines(object.content);
    return true;
  } catch {
    return false;
  }
}
