import type { ComposedSnapshot } from '../composition/compose.js';
import type {
  LayerSnapshot,
  ManagedObject,
  ManagedPath,
} from '../domain/objects.js';
import { equalManagedObjects } from '../domain/objects.js';
import {
  isTextFile,
  splitTextLines,
  alignLines,
  type TextLine,
} from './lines.js';

export interface UnassignedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly edits: readonly UnassignedEdit[];
  readonly contextBefore: readonly UnassignedEdit[];
  readonly contextAfter: readonly UnassignedEdit[];
}
export interface UnassignedEdit {
  readonly kind: 'same' | 'add' | 'remove';
  readonly oldIndex?: number;
  readonly newIndex?: number;
  readonly line: TextLine;
}
export interface UnassignedChange {
  readonly path: ManagedPath;
  readonly owner: 'unassigned';
  readonly expected?: ManagedObject;
  readonly actual?: ManagedObject;
  readonly kind: 'text-hunks' | 'whole-object';
  readonly status: 'added' | 'deleted' | 'modified' | 'type-changed';
  readonly hunks: readonly UnassignedHunk[];
}

export function detectUnassignedChanges(
  _layers: readonly LayerSnapshot[],
  composed: ComposedSnapshot,
  target: ReadonlyMap<ManagedPath, ManagedObject> = new Map(),
  candidatePaths: readonly ManagedPath[] = [],
): readonly UnassignedChange[] {
  const paths = new Set([...composed.objects.keys(), ...candidatePaths]);
  const changes: UnassignedChange[] = [];
  for (const path of [...paths].sort()) {
    const expected = composed.objects.get(path);
    const actual = target.get(path);
    if (expected === undefined && actual === undefined) continue;
    if (expected && actual && equalManagedObjects(expected, actual)) continue;
    const textChange =
      expected &&
      actual &&
      isTextFile(expected) &&
      isTextFile(actual) &&
      expected.executable === actual.executable;
    const hunks = textChange
      ? makeHunks(
          splitTextLines(expected.content),
          splitTextLines(actual.content),
        )
      : [];
    changes.push({
      path,
      owner: 'unassigned',
      kind: textChange ? 'text-hunks' : 'whole-object',
      status:
        expected === undefined
          ? 'added'
          : actual === undefined
            ? 'deleted'
            : expected.kind !== actual.kind
              ? 'type-changed'
              : 'modified',
      ...(expected ? { expected } : {}),
      ...(actual ? { actual } : {}),
      hunks,
    });
  }
  return changes;
}

function makeHunks(
  oldLines: readonly TextLine[],
  newLines: readonly TextLine[],
): UnassignedHunk[] {
  const edits = alignLines(oldLines, newLines).edits;
  const hunks: UnassignedHunk[] = [];
  const all: UnassignedEdit[] = edits.map((edit) => {
    const line =
      edit.kind === 'add' ? newLines[edit.newIndex] : oldLines[edit.oldIndex];
    if (!line) throw new Error('Invalid hunk alignment');
    return edit.kind === 'same'
      ? { kind: 'same', oldIndex: edit.oldIndex, newIndex: edit.newIndex, line }
      : edit.kind === 'remove'
        ? { kind: 'remove', oldIndex: edit.oldIndex, line }
        : { kind: 'add', newIndex: edit.newIndex, line };
  });
  const changed = all.flatMap((edit, index) =>
    edit.kind === 'same' ? [] : [index],
  );
  let groupStart = 0;
  while (groupStart < changed.length) {
    let groupEnd = groupStart;
    while (groupEnd + 1 < changed.length) {
      const next = changed[groupEnd + 1];
      const current = changed[groupEnd];
      if (next === undefined || current === undefined || next - current > 7)
        break;
      groupEnd += 1;
    }
    const firstChanged = changed[groupStart];
    const lastChanged = changed[groupEnd];
    if (firstChanged === undefined || lastChanged === undefined) break;
    const start = firstChanged;
    const end = lastChanged + 1;
    const span = all.slice(start, end);
    const oldPositions = span.flatMap((edit) =>
      edit.oldIndex === undefined ? [] : [edit.oldIndex],
    );
    const newPositions = span.flatMap((edit) =>
      edit.newIndex === undefined ? [] : [edit.newIndex],
    );
    const oldStartIndex =
      oldPositions[0] ??
      all.slice(0, start).filter((edit) => edit.oldIndex !== undefined).length;
    const newStartIndex =
      newPositions[0] ??
      all.slice(0, start).filter((edit) => edit.newIndex !== undefined).length;
    const oldCount = oldPositions.length;
    const newCount = newPositions.length;
    hunks.push({
      oldStart: oldCount === 0 ? oldStartIndex : oldStartIndex + 1,
      oldCount,
      newStart: newCount === 0 ? newStartIndex : newStartIndex + 1,
      newCount,
      edits: span,
      contextBefore: all
        .slice(Math.max(0, start - 3), start)
        .filter((edit) => edit.kind === 'same'),
      contextAfter: all
        .slice(end, Math.min(all.length, end + 3))
        .filter((edit) => edit.kind === 'same'),
    });
    groupStart = groupEnd + 1;
  }
  return hunks;
}
