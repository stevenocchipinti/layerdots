import type { ComposedSnapshot } from '../composition/compose.js';
import { equalManagedObjects } from '../domain/objects.js';
import type { ManagedObject, ManagedPath } from '../domain/objects.js';
import {
  alignLines,
  splitTextLines,
  type TextLine,
} from '../provenance/lines.js';

export type ObjectSnapshot = Pick<ComposedSnapshot, 'objects'>;

export interface MergeConflict {
  readonly path: ManagedPath;
  readonly base?: ManagedObject;
  readonly ours?: ManagedObject;
  readonly theirs?: ManagedObject;
  readonly text?: Uint8Array;
}

export interface MergeResult {
  readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  readonly conflicts: readonly MergeConflict[];
}

export function mergeThreeWay(
  base: ObjectSnapshot,
  ours: ObjectSnapshot,
  theirs: ObjectSnapshot,
): MergeResult {
  const paths = new Set([
    ...base.objects.keys(),
    ...ours.objects.keys(),
    ...theirs.objects.keys(),
  ]);
  const objects = new Map<ManagedPath, ManagedObject>();
  const conflicts: MergeConflict[] = [];
  for (const path of [...paths].sort()) {
    const b = base.objects.get(path);
    const o = ours.objects.get(path);
    const t = theirs.objects.get(path);
    const merged = mergeObject(path, b, o, t);
    if (merged.conflict) conflicts.push(merged.conflict);
    else if (merged.object !== undefined)
      objects.set(path, clone(merged.object));
  }
  return { objects, conflicts };
}

function mergeObject(
  path: string,
  base: ManagedObject | undefined,
  ours: ManagedObject | undefined,
  theirs: ManagedObject | undefined,
): { object?: ManagedObject; conflict?: MergeConflict } {
  if (same(base, ours)) return theirs === undefined ? {} : { object: theirs };
  if (same(base, theirs)) return ours === undefined ? {} : { object: ours };
  if (same(ours, theirs)) return ours === undefined ? {} : { object: ours };
  if (
    ours?.kind === 'file' &&
    theirs?.kind === 'file' &&
    base?.kind === 'file' &&
    ours.executable === theirs.executable &&
    ours.executable === base.executable
  ) {
    const merged = mergeText(base.content, ours.content, theirs.content);
    if (merged !== undefined)
      return {
        object: { kind: 'file', content: merged, executable: ours.executable },
      };
    const text =
      validUtf8(base.content) &&
      validUtf8(ours.content) &&
      validUtf8(theirs.content)
        ? conflictText(base.content, ours.content, theirs.content)
        : undefined;
    return { conflict: conflictRecord(path, base, ours, theirs, text) };
  }
  return { conflict: conflictRecord(path, base, ours, theirs) };
}

function validUtf8(value: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(value);
    return true;
  } catch {
    return false;
  }
}

function conflictRecord(
  path: string,
  base: ManagedObject | undefined,
  ours: ManagedObject | undefined,
  theirs: ManagedObject | undefined,
  text?: Uint8Array,
): MergeConflict {
  const result: MergeConflict = { path };
  return {
    ...result,
    ...(base === undefined ? {} : { base: clone(base) }),
    ...(ours === undefined ? {} : { ours: clone(ours) }),
    ...(theirs === undefined ? {} : { theirs: clone(theirs) }),
    ...(text === undefined ? {} : { text: new Uint8Array(text) }),
  };
}

function same(
  a: ManagedObject | undefined,
  b: ManagedObject | undefined,
): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined && equalManagedObjects(a, b);
}

interface Edit {
  start: number;
  end: number;
  lines: TextLine[];
}

function mergeText(
  baseBytes: Uint8Array,
  oursBytes: Uint8Array,
  theirsBytes: Uint8Array,
): Uint8Array | undefined {
  let base: TextLine[], ours: TextLine[], theirs: TextLine[];
  try {
    base = splitTextLines(baseBytes);
    ours = splitTextLines(oursBytes);
    theirs = splitTextLines(theirsBytes);
  } catch {
    return undefined;
  }
  if (
    hasRepeatedLines(base) &&
    (alignLines(base, ours).ambiguousNew.size > 0 ||
      alignLines(base, theirs).ambiguousNew.size > 0)
  )
    return undefined;
  const a = edits(base, ours),
    b = edits(base, theirs);
  const boundary = mergeSharedBoundary(base, ours, theirs);
  if (boundary !== undefined) return boundary;
  const boundaryMerge = mergeBoundaryResults(ours, theirs, a, b);
  if (boundaryMerge !== undefined) return boundaryMerge;
  const all = [
    ...a.map((edit) => ({ side: 'ours' as const, edit })),
    ...b.map((edit) => ({ side: 'theirs' as const, edit })),
  ].sort((x, y) => x.edit.start - y.edit.start || x.edit.end - y.edit.end);
  const output: TextLine[] = [];
  let cursor = 0;
  for (let i = 0; i < all.length;) {
    const first = all[i];
    if (first === undefined) break;
    if (first.edit.start < cursor) return undefined;
    output.push(...base.slice(cursor, first.edit.start));
    const group = [first];
    let end = first.edit.end;
    i += 1;
    while (i < all.length) {
      const next = all[i];
      const previous = group[group.length - 1];
      if (
        next === undefined ||
        previous === undefined ||
        !overlaps(previous.edit, next.edit)
      )
        break;
      group.push(next);
      end = Math.max(end, next.edit.end);
      i += 1;
    }
    const left = group.find((x) => x.side === 'ours')?.edit;
    const right = group.find((x) => x.side === 'theirs')?.edit;
    if (left && right) {
      const combined = combineBoundaryEdits(
        left,
        right,
        base.slice(first.edit.start, end),
      );
      if (combined === undefined) return undefined;
      output.push(...combined);
    } else {
      const only = left ?? right;
      if (only === undefined) return undefined;
      output.push(...only.lines);
    }
    cursor = end;
  }
  output.push(...base.slice(cursor));
  return new TextEncoder().encode(
    output.map((line) => line.text + line.ending).join(''),
  );
}

function mergeSharedBoundary(
  base: readonly TextLine[],
  ours: readonly TextLine[],
  theirs: readonly TextLine[],
): Uint8Array | undefined {
  let prefix = 0;
  while (prefix < ours.length && prefix < theirs.length) {
    const oursLine = ours[prefix],
      theirsLine = theirs[prefix];
    if (!oursLine || !theirsLine || !lineEqual(oursLine, theirsLine)) break;
    prefix++;
  }
  let suffix = 0;
  while (suffix < ours.length - prefix && suffix < theirs.length - prefix) {
    const oursLine = ours[ours.length - suffix - 1];
    const theirsLine = theirs[theirs.length - suffix - 1];
    if (!oursLine || !theirsLine || !lineEqual(oursLine, theirsLine)) break;
    suffix++;
  }
  const left = ours.slice(prefix, ours.length - suffix),
    right = theirs.slice(prefix, theirs.length - suffix);
  const baseSuffix =
    suffix <= base.length &&
    equalLines(
      base.slice(base.length - suffix),
      ours.slice(ours.length - suffix),
    )
      ? suffix
      : 0;
  const baseSegment = base.slice(prefix, base.length - baseSuffix);
  if (
    equalLines(right.slice(0, baseSegment.length), baseSegment) &&
    left.length >= baseSegment.length
  )
    return encodeLines([...ours]);
  if (
    equalLines(left.slice(0, baseSegment.length), baseSegment) &&
    right.length >= baseSegment.length
  )
    return encodeLines([...theirs]);
  return undefined;
}

function encodeLines(lines: readonly TextLine[]): Uint8Array {
  return new TextEncoder().encode(
    lines.map((line) => line.text + line.ending).join(''),
  );
}

function mergeBoundaryResults(
  ours: readonly TextLine[],
  theirs: readonly TextLine[],
  oursEdits: readonly Edit[],
  theirsEdits: readonly Edit[],
): Uint8Array | undefined {
  if (oursEdits.length !== 1 || theirsEdits.length !== 1) return undefined;
  const left = oursEdits[0],
    right = theirsEdits[0];
  if (!left || !right) return undefined;
  const replacement =
    left.start !== left.end
      ? left
      : right.start !== right.end
        ? right
        : undefined;
  const insertion =
    replacement === left ? right : replacement === right ? left : undefined;
  if (!replacement || !insertion || insertion.start !== replacement.end)
    return undefined;
  if (
    !equalLines(
      insertion.lines,
      (replacement === left ? theirs : ours).slice(
        insertion.start,
        insertion.start + insertion.lines.length,
      ),
    )
  )
    return undefined;
  const selected = replacement === left ? ours : theirs;
  return new TextEncoder().encode(
    selected.map((line) => line.text + line.ending).join(''),
  );
}

function hasRepeatedLines(lines: readonly TextLine[]): boolean {
  const seen = new Set<string>();
  for (const line of lines) {
    const value = `${line.text}\0${line.ending}`;
    if (seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}

function overlaps(a: Edit, b: Edit): boolean {
  return (
    (a.start < b.end && b.start < a.end) ||
    (a.start === b.start && a.end === b.end) ||
    (a.start === b.end && a.start === a.end) ||
    (b.start === a.end && b.start === b.end)
  );
}

function combineBoundaryEdits(
  left: Edit,
  right: Edit,
  baseSegment: readonly TextLine[],
): TextLine[] | undefined {
  if (equalLines(left.lines, right.lines)) return left.lines;
  const insertion =
    left.start === left.end
      ? left
      : right.start === right.end
        ? right
        : undefined;
  const replacement =
    insertion === left ? right : insertion === right ? left : undefined;
  if (insertion === undefined || replacement === undefined) {
    if (equalLines(left.lines.slice(-baseSegment.length), baseSegment))
      return right.lines;
    if (equalLines(right.lines.slice(-baseSegment.length), baseSegment))
      return left.lines;
    if (equalLines(left.lines.slice(0, baseSegment.length), baseSegment))
      return right.lines;
    if (equalLines(right.lines.slice(0, baseSegment.length), baseSegment))
      return left.lines;
    return undefined;
  }
  const prefix = insertion.start === replacement.start;
  const suffix = insertion.start === replacement.end;
  if (!prefix && !suffix) return undefined;
  const count = insertion.lines.length;
  const comparable = prefix
    ? replacement.lines.slice(0, count)
    : replacement.lines.slice(replacement.lines.length - count);
  if (equalLines(comparable, insertion.lines)) return replacement.lines;
  return prefix
    ? [...insertion.lines, ...replacement.lines]
    : [...replacement.lines, ...insertion.lines];
}

function edits(base: readonly TextLine[], next: readonly TextLine[]): Edit[] {
  const n = base.length,
    m = next.length;
  const table = Array.from({ length: n + 1 }, () =>
    Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i],
        below = table[i + 1];
      const baseLine = base[i],
        nextLine = next[j];
      if (!row || !below || !baseLine || !nextLine) continue;
      row[j] = lineEqual(baseLine, nextLine)
        ? (below[j + 1] ?? 0) + 1
        : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  const result: Edit[] = [];
  let i = 0,
    j = 0,
    start = -1;
  const replacement: TextLine[] = [];
  const flush = (): void => {
    if (start >= 0) {
      result.push({ start, end: i, lines: replacement.splice(0) });
      start = -1;
    }
  };
  while (i < n || j < m) {
    const baseLine = base[i],
      nextLine = next[j];
    if (
      baseLine !== undefined &&
      nextLine !== undefined &&
      lineEqual(baseLine, nextLine)
    ) {
      flush();
      i++;
      j++;
    } else {
      if (start < 0) start = i;
      const row = table[i],
        below = table[i + 1],
        line = next[j];
      if (
        j < m &&
        line !== undefined &&
        (i === n || (row && below && (row[j + 1] ?? 0) >= (below[j] ?? 0)))
      ) {
        replacement.push(line);
        j++;
      } else i++;
    }
  }
  flush();
  return result;
}

function lineEqual(a: TextLine, b: TextLine): boolean {
  return a.text === b.text && a.ending === b.ending;
}
function equalLines(a: readonly TextLine[], b: readonly TextLine[]): boolean {
  return (
    a.length === b.length &&
    a.every((line, i) => {
      const other = b[i];
      return other !== undefined && lineEqual(line, other);
    })
  );
}
function clone(object: ManagedObject): ManagedObject {
  return object.kind === 'file'
    ? { ...object, content: new Uint8Array(object.content) }
    : { ...object };
}

export function conflictText(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
): Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: string[];
  try {
    parts = [ours, base, theirs].map((value) =>
      renderPreviewPart(decoder.decode(value)),
    );
  } catch {
    return new Uint8Array();
  }
  const oursPart = parts[0] ?? '';
  const basePart = parts[1] ?? '';
  const theirsPart = parts[2] ?? '';
  return new TextEncoder().encode(
    `<<<<<<< ours\n${oursPart}||||||| base\n${basePart}=======\n${theirsPart}>>>>>>> theirs\n`,
  );
}

function renderPreviewPart(value: string): string {
  const lines = splitTextLines(new TextEncoder().encode(value));
  return (
    lines.map((line) => `${line.text}${line.ending}`).join('') +
    (lines.at(-1)?.ending === '' ? '\n\\ No newline at end of file\n' : '')
  );
}
