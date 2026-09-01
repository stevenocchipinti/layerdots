import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import type {
  LayerSnapshot,
  ManagedObject,
  ManagedPath,
} from '../domain/objects.js';
import { equalManagedObjects } from '../domain/objects.js';
import { layerRole } from '../domain/manifest.js';
import {
  alignLines,
  isTextFile,
  splitTextLines,
  type TextLine,
} from '../provenance/lines.js';
import type {
  UnassignedChange,
  UnassignedEdit,
  UnassignedHunk,
} from '../provenance/unassigned.js';
import { createUnifiedPatch } from './patch-generation.js';

export interface AssignmentResult {
  readonly layers: readonly LayerSnapshot[];
  readonly selected: ManagedObject | undefined;
  readonly selectedObject: ManagedObject | undefined;
  readonly invalidatedParentPins: readonly string[];
}

export interface AssignmentRequest {
  readonly layers: readonly LayerSnapshot[];
  readonly composed: {
    readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  };
  readonly change: UnassignedChange;
  readonly hunkIndexes: readonly number[];
  readonly destinationLayerId: string;
}

export function assignUnassignedChange(
  request: AssignmentRequest,
): AssignmentResult {
  const { layers, change } = validateRequest(request);
  const indexes = normalizeIndexes(request.hunkIndexes, change);
  const selected = selectObject(change, indexes);
  const candidates = layers.map(cloneSnapshot);
  const destinationIndex = candidates.findIndex(
    (layer) => layer.id === request.destinationLayerId,
  );
  if (destinationIndex < 0) invalid('Unknown assignment destination layer.');
  const destination = layerAt(candidates, destinationIndex);
  if (layerRole(destination.manifest) === 'base') {
    projectToBase(
      candidates,
      destinationIndex,
      request.composed.objects.get(change.path),
      selected,
      change,
      indexes,
    );
  } else {
    const lower = composeLayers(
      firstLayer(candidates),
      candidates.slice(1, destinationIndex),
    ).objects.get(change.path);
    replaceRepresentation(
      mutableObjects(destination),
      change.path,
      lower,
      selected,
    );
  }
  for (
    let index = destinationIndex + 1;
    index < candidates.length;
    index += 1
  ) {
    const originalEffective = composeLayers(
      firstLayer(layers),
      layers.slice(1, index + 1),
    ).objects.get(change.path);
    const lower = composeLayers(
      firstLayer(candidates),
      candidates.slice(1, index),
    ).objects.get(change.path);
    const desired = projectDelta(originalEffective, selected, change, indexes);
    replaceRepresentation(
      mutableObjects(at(candidates, index)),
      change.path,
      lower,
      desired,
    );
  }
  return {
    layers: candidates,
    selected,
    selectedObject: selected,
    invalidatedParentPins: candidates
      .slice(destinationIndex + 1)
      .map((layer) => layer.id),
  };
}

export const assign = assignUnassignedChange;

function validateRequest(request: AssignmentRequest): {
  layers: readonly LayerSnapshot[];
  change: UnassignedChange;
} {
  if (!isAssignmentRequest(request) || request.layers.length === 0)
    invalid('Assignment requires at least one layer.');
  const layers = request.layers;
  if (
    layerRole(firstLayer(layers).manifest) !== 'base' ||
    layers.slice(1).some((layer) => layerRole(layer.manifest) !== 'overlay')
  )
    invalid('Assignment layers must be a base followed by overlays.');
  if (new Set(layers.map((layer) => layer.id)).size !== layers.length)
    invalid('Assignment layer ids must be unique.');
  const actualComposed = composeLayers(firstLayer(layers), layers.slice(1));
  const path = request.change.path;
  if (typeof path !== 'string') invalid('Assignment change is malformed.');
  if (
    !sameOptional(
      actualComposed.objects.get(path),
      request.composed.objects.get(path),
    )
  )
    stale('Supplied composition is stale.');
  if (!sameOptional(request.change.expected, actualComposed.objects.get(path)))
    stale('Assignment expected object is stale.');
  validateChange(request.change, actualComposed.objects.get(path));
  if (
    typeof request.destinationLayerId !== 'string' ||
    !layers.some((layer) => layer.id === request.destinationLayerId)
  )
    invalid('Unknown assignment destination layer.');
  return { layers, change: request.change };
}

function validateChange(
  change: UnassignedChange,
  current: ManagedObject | undefined,
): void {
  /* eslint-disable @typescript-eslint/no-unsafe-argument */
  if (
    !['text-hunks', 'whole-object'].includes(change.kind) ||
    !['added', 'deleted', 'modified', 'type-changed'].includes(change.status) ||
    !Array.isArray(change.hunks)
  )
    invalid('Assignment change is malformed.');
  const expected = change.expected;
  const actual = change.actual;
  const expectedKind =
    expected === undefined
      ? 'added'
      : actual === undefined
        ? 'deleted'
        : expected.kind !== actual.kind
          ? 'type-changed'
          : 'modified';
  if (
    change.status !== expectedKind ||
    (change.kind === 'text-hunks') !==
      Boolean(
        expected &&
        actual &&
        isTextFile(expected) &&
        isTextFile(actual) &&
        expected.executable === actual.executable,
      ) ||
    (change.kind === 'whole-object' && change.hunks.length !== 0)
  )
    invalid('Assignment change kind or status is malformed.');
  if (!sameOptional(expected, current))
    stale('Assignment expected object is stale.');
  if (change.kind === 'text-hunks')
    for (const hunk of change.hunks) validateHunk(hunk, expected, actual);
  /* eslint-enable @typescript-eslint/no-unsafe-argument */
}

function validateHunk(
  hunk: UnassignedHunk,
  expected: ManagedObject | undefined,
  actual: ManagedObject | undefined,
): void {
  /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
  if (
    !expected ||
    expected.kind !== 'file' ||
    !actual ||
    actual.kind !== 'file'
  )
    invalid('Assignment hunk requires files.');
  const oldLines = splitTextLines(expected.content);
  const newLines = splitTextLines(actual.content);
  const edits = hunk.edits;
  if (!Array.isArray(edits) || edits.length === 0)
    invalid('Assignment hunk edits are malformed.');
  let lastOld = -1;
  let lastNew = -1;
  let hasChange = false;
  for (const edit of edits) {
    if (!['same', 'add', 'remove'].includes(edit.kind))
      invalid('Assignment hunk edit is malformed.');
    if (
      edit.kind === 'same' &&
      (edit.oldIndex === undefined || edit.newIndex === undefined)
    )
      invalid('Assignment same edit is malformed.');
    if (
      edit.kind === 'add' &&
      (edit.oldIndex !== undefined || edit.newIndex === undefined)
    )
      invalid('Assignment add edit is malformed.');
    if (
      edit.kind === 'remove' &&
      (edit.oldIndex === undefined || edit.newIndex !== undefined)
    )
      invalid('Assignment remove edit is malformed.');
    if (
      edit.oldIndex !== undefined &&
      (edit.oldIndex <= lastOld ||
        !sameLine(edit.line, oldLines[edit.oldIndex]))
    )
      invalid('Assignment hunk old edit is malformed.');
    if (
      edit.newIndex !== undefined &&
      (edit.newIndex <= lastNew ||
        !sameLine(edit.line, newLines[edit.newIndex]))
    )
      invalid('Assignment hunk new edit is malformed.');
    if (edit.oldIndex !== undefined) lastOld = edit.oldIndex;
    if (edit.newIndex !== undefined) lastNew = edit.newIndex;
    if (edit.kind !== 'same') hasChange = true;
  }
  if (!hasChange) invalid('Assignment hunk has no changed core.');
  const oldIndices: number[] = [];
  const newIndices: number[] = [];
  for (const edit of edits) {
    if (edit.oldIndex !== undefined) oldIndices.push(edit.oldIndex);
    if (edit.newIndex !== undefined) newIndices.push(edit.newIndex);
  }
  if (
    oldIndices.length !== hunk.oldCount ||
    newIndices.length !== hunk.newCount
  )
    invalid('Assignment hunk counts are malformed.');
  const firstOld = oldIndices[0];
  const firstNew = newIndices[0];
  if (
    hunk.oldCount > 0 &&
    firstOld !== undefined &&
    hunk.oldStart !== firstOld + 1
  )
    invalid('Assignment hunk old range is malformed.');
  if (
    hunk.newCount > 0 &&
    firstNew !== undefined &&
    hunk.newStart !== firstNew + 1
  )
    invalid('Assignment hunk new range is malformed.');
  const alignment = alignLines(oldLines, newLines).edits;
  const firstEdit = edits[0];
  const start = alignment.findIndex((edit) => sameEdit(edit, firstEdit));
  if (
    start < 0 ||
    alignment
      .slice(start, start + edits.length)
      .some((edit, index) => !sameEdit(edit, edits[index]))
  )
    invalid('Assignment hunk edit order or completeness is malformed.');
  validateContext(
    hunk.contextBefore,
    oldLines,
    newLines,
    true,
    oldIndices,
    newIndices,
  );
  validateContext(
    hunk.contextAfter,
    oldLines,
    newLines,
    false,
    oldIndices,
    newIndices,
  );
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
}

function sameEdit(
  left: { kind: string; oldIndex?: number; newIndex?: number },
  right: UnassignedEdit | undefined,
): boolean {
  return (
    right !== undefined &&
    left.kind === right.kind &&
    left.oldIndex === right.oldIndex &&
    left.newIndex === right.newIndex
  );
}

function validateContext(
  context: readonly UnassignedEdit[],
  lines: readonly TextLine[],
  targetLines: readonly TextLine[],
  before: boolean,
  oldIndices: readonly number[],
  newIndices: readonly number[],
): void {
  /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
  if (!Array.isArray(context)) invalid('Assignment hunk context is malformed.');
  for (const edit of context)
    if (
      edit.kind !== 'same' ||
      edit.oldIndex === undefined ||
      edit.newIndex === undefined ||
      !sameLine(edit.line, lines[edit.oldIndex]) ||
      !sameLine(edit.line, targetLines[edit.newIndex])
    )
      invalid('Assignment hunk context is malformed.');
  /* eslint-disable @typescript-eslint/no-unsafe-assignment */
  const edge: UnassignedEdit | undefined = before
    ? context.length > 0
      ? context[context.length - 1]
      : undefined
    : context.length > 0
      ? context[0]
      : undefined;
  /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  const core = before ? oldIndices[0] : oldIndices.at(-1);
  const coreNew = before ? newIndices[0] : newIndices.at(-1);
  if (
    edge &&
    core !== undefined &&
    coreNew !== undefined &&
    (before
      ? edge.oldIndex !== core - 1 || edge.newIndex !== coreNew - 1
      : edge.oldIndex !== core + 1 || edge.newIndex !== coreNew + 1)
  )
    invalid('Assignment hunk context is not adjacent.');
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
}

function normalizeIndexes(
  indexes: readonly number[],
  change: UnassignedChange,
): number[] {
  /* eslint-disable @typescript-eslint/no-unsafe-return */
  if (
    !Array.isArray(indexes) ||
    (indexes.length === 0 && change.kind !== 'whole-object') ||
    indexes.some(
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        (change.kind === 'text-hunks' && index >= change.hunks.length),
    )
  )
    invalid('Assignment contains an invalid hunk index.');
  const result = [...new Set(indexes)].sort((a, b) => a - b);
  if (
    change.kind === 'whole-object' &&
    (result.length !== 1 || result[0] !== 0)
  )
    invalid('Whole-object changes require selection index 0.');
  return result;
  /* eslint-enable @typescript-eslint/no-unsafe-return */
}

function selectObject(
  change: UnassignedChange,
  indexes: readonly number[],
): ManagedObject | undefined {
  if (change.kind === 'whole-object') return cloneObject(change.actual);
  const expected = requireFile(change.expected);
  const actual = requireFile(change.actual);
  const lines = splitTextLines(expected.content);
  applyOperations(
    lines,
    indexes.flatMap((index) => operation(at(change.hunks, index))),
    splitTextLines(actual.content),
  );
  return {
    kind: 'file',
    content: encodeLines(lines),
    executable: actual.executable,
  };
}

interface Operation {
  readonly oldIndices: readonly number[];
  readonly newLines: readonly TextLine[];
  readonly boundary: number;
}
function operation(hunk: UnassignedHunk): Operation {
  const oldIndices = hunk.edits
    .filter((edit) => edit.kind !== 'add')
    .flatMap((edit) => (edit.oldIndex === undefined ? [] : [edit.oldIndex]));
  const newLines = hunk.edits
    .filter((edit) => edit.kind !== 'remove')
    .map((edit) => edit.line);
  const boundary = oldIndices[0] ?? insertionBoundary(hunk);
  return { oldIndices, newLines, boundary };
}

function insertionBoundary(hunk: UnassignedHunk): number {
  const before = hunk.contextBefore.at(-1)?.oldIndex;
  if (before !== undefined) return before + 1;
  const after = hunk.contextAfter[0]?.oldIndex;
  if (after !== undefined) return after;
  const next = hunk.edits.find((edit) => edit.newIndex !== undefined)?.newIndex;
  return next ?? 0;
}
function applyOperations(
  lines: TextLine[],
  operations: readonly Operation[],
  actual: readonly TextLine[],
): void {
  for (const op of [...operations].sort((a, b) => b.boundary - a.boundary)) {
    const firstOld = op.oldIndices[0];
    if (
      firstOld !== undefined &&
      op.oldIndices.some((value, index) => value !== firstOld + index)
    )
      invalid('Assignment hunk edits are non-contiguous.');
    const newLines = op.newLines.map(
      (line) =>
        actual.find(
          (candidate) =>
            candidate.text === line.text && candidate.ending === line.ending,
        ) ?? line,
    );
    lines.splice(op.boundary, op.oldIndices.length, ...newLines);
  }
}

function projectToBase(
  candidates: LayerSnapshot[],
  index: number,
  composed: ManagedObject | undefined,
  selected: ManagedObject | undefined,
  change: UnassignedChange,
  indexes: readonly number[],
): void {
  const base = at(candidates, index).objects.get(change.path);
  if (change.kind === 'whole-object') {
    if (candidates.slice(1).some((layer) => representsPath(layer, change.path)))
      throw new LayerdotsError(
        'A whole-object change cannot be projected below an upper representation.',
        'assignment-ambiguous',
      );
    update(mutableObjects(at(candidates, index)), change.path, selected);
    return;
  }
  const baseFile = requireFile(base);
  const composedFile = requireFile(composed);
  const selectedFile = requireFile(selected);
  const result = splitTextLines(baseFile.content);
  const alignment = alignLines(result, splitTextLines(composedFile.content));
  applyProjected(
    result,
    alignment,
    indexes.map((item) => operation(at(change.hunks, item))),
    splitTextLines(selectedFile.content),
  );
  update(mutableObjects(at(candidates, index)), change.path, {
    kind: 'file',
    content: encodeLines(result),
    executable: baseFile.executable,
  });
}

function projectDelta(
  effective: ManagedObject | undefined,
  selected: ManagedObject | undefined,
  change: UnassignedChange,
  indexes: readonly number[],
): ManagedObject | undefined {
  if (change.kind === 'whole-object') return selected;
  const effectiveFile = requireFile(effective);
  const expectedFile = requireFile(change.expected);
  const selectedFile = requireFile(selected);
  const result = splitTextLines(effectiveFile.content);
  const alignment = alignLines(result, splitTextLines(expectedFile.content));
  applyProjected(
    result,
    alignment,
    indexes.map((item) => operation(at(change.hunks, item))),
    splitTextLines(selectedFile.content),
  );
  return {
    kind: 'file',
    content: encodeLines(result),
    executable: effectiveFile.executable,
  };
}

function applyProjected(
  result: TextLine[],
  alignment: ReturnType<typeof alignLines>,
  operations: readonly Operation[],
  selected: readonly TextLine[],
): void {
  for (const op of [...operations].sort((a, b) => b.boundary - a.boundary)) {
    const mapped = op.oldIndices.map((old) =>
      unique(alignment.possibleOldIndices.get(old)),
    );
    const boundary =
      op.oldIndices.length > 0
        ? mapped[0]
        : mapBoundary(alignment, op.boundary);
    if (boundary === undefined)
      invalid('Assignment projection has ambiguous ancestry.');
    if (mapped.some((value, index) => value !== boundary + index))
      invalid('Assignment projection has ambiguous ancestry.');
    const replacement = op.newLines.map(
      (line) =>
        selected.find(
          (candidate) =>
            candidate.text === line.text && candidate.ending === line.ending,
        ) ?? line,
    );
    result.splice(boundary, op.oldIndices.length, ...replacement);
  }
}
function mapBoundary(
  alignment: ReturnType<typeof alignLines>,
  boundary: number,
): number {
  const before = optionalUnique(alignment.possibleOldIndices.get(boundary - 1));
  const after = optionalUnique(alignment.possibleOldIndices.get(boundary));
  if (before !== undefined) return before + 1;
  if (after !== undefined) return after;
  invalid('Assignment insertion has ambiguous ancestry.');
}
function unique(values: ReadonlySet<number> | undefined): number {
  if (!values || values.size !== 1)
    invalid('Assignment projection has ambiguous ancestry.');
  const value = values.values().next().value;
  if (typeof value !== 'number')
    invalid('Assignment projection has ambiguous ancestry.');
  return value;
}
function optionalUnique(
  values: ReadonlySet<number> | undefined,
): number | undefined {
  if (!values) return undefined;
  if (values.size !== 1)
    invalid('Assignment projection has ambiguous ancestry.');
  const value = values.values().next().value;
  return typeof value === 'number' ? value : undefined;
}

function replaceRepresentation(
  objects: Map<string, ManagedObject>,
  path: string,
  lower: ManagedObject | undefined,
  desired: ManagedObject | undefined,
): void {
  objects.delete(path);
  objects.delete(`${path}.patch`);
  objects.delete(`${path}.delete`);
  if (!desired) {
    if (lower)
      objects.set(`${path}.delete`, {
        kind: 'file',
        content: new Uint8Array(),
        executable: false,
      });
    return;
  }
  if (
    lower?.kind === 'file' &&
    desired.kind === 'file' &&
    lower.executable === desired.executable &&
    isTextFile(lower) &&
    isTextFile(desired)
  ) {
    try {
      objects.set(`${path}.patch`, {
        kind: 'file',
        content: createUnifiedPatch(path, lower.content, desired.content),
        executable: false,
      });
      return;
    } catch (error) {
      if (
        !(error instanceof LayerdotsError) ||
        error.code !== 'assignment-patch-unrepresentable'
      )
        throw error;
    }
  }
  if (!lower || !equalManagedObjects(lower, desired)) {
    const clone = cloneObject(desired);
    if (clone) objects.set(path, clone);
  }
}

function requireFile(
  object: ManagedObject | undefined,
): Extract<ManagedObject, { kind: 'file' }> {
  if (!object || object.kind !== 'file')
    invalid('Assignment requires a regular file.');
  return object;
}
function sameLine(left: TextLine, right: TextLine | undefined): boolean {
  return (
    right !== undefined &&
    left.text === right.text &&
    left.ending === right.ending
  );
}
function sameOptional(
  left: ManagedObject | undefined,
  right: ManagedObject | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && equalManagedObjects(left, right);
}
function mutableObjects(layer: LayerSnapshot): Map<string, ManagedObject> {
  return layer.objects as Map<string, ManagedObject>;
}
function firstLayer(layers: readonly LayerSnapshot[]): LayerSnapshot {
  const layer = layers[0];
  if (!layer) invalid('Assignment requires at least one layer.');
  return layer;
}
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) invalid('Assignment data is malformed.');
  return value;
}
function layerAt(
  layers: readonly LayerSnapshot[],
  index: number,
): LayerSnapshot {
  const layer = layers[index];
  if (!layer) invalid('Unknown assignment destination layer.');
  return layer;
}
function isAssignmentRequest(value: unknown): value is AssignmentRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.layers) &&
    typeof record.composed === 'object' &&
    record.composed !== null &&
    typeof record.change === 'object' &&
    record.change !== null &&
    Array.isArray(record.hunkIndexes) &&
    typeof record.destinationLayerId === 'string'
  );
}
function representsPath(layer: LayerSnapshot, path: string): boolean {
  return (
    layer.objects.has(path) ||
    layer.objects.has(`${path}.patch`) ||
    layer.objects.has(`${path}.delete`)
  );
}
function update(
  objects: Map<string, ManagedObject>,
  path: string,
  object: ManagedObject | undefined,
): void {
  if (object) {
    const clone = cloneObject(object);
    if (clone) objects.set(path, clone);
  } else objects.delete(path);
}
function cloneSnapshot(layer: LayerSnapshot): LayerSnapshot {
  const objects = new Map<string, ManagedObject>();
  for (const [path, object] of layer.objects) {
    const clone = cloneObject(object);
    if (clone) objects.set(path, clone);
  }
  return { ...layer, objects };
}
function cloneObject(
  object: ManagedObject | undefined,
): ManagedObject | undefined {
  return object?.kind === 'file'
    ? { ...object, content: new Uint8Array(object.content) }
    : object
      ? { ...object }
      : undefined;
}
function encodeLines(lines: readonly TextLine[]): Uint8Array {
  return new TextEncoder().encode(
    lines.map((line) => line.text + line.ending).join(''),
  );
}
function invalid(message: string): never {
  throw new LayerdotsError(message, 'assignment-invalid');
}
function stale(message: string): never {
  throw new LayerdotsError(message, 'assignment-stale');
}
