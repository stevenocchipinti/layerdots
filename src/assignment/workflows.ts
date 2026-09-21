import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import type {
  LayerSnapshot,
  ManagedObject,
  ManagedPath,
} from '../domain/objects.js';
import { equalManagedObjects } from '../domain/objects.js';
import { validateManagedPath } from '../repositories/path-validation.js';
import { createUnifiedPatch } from './patch-generation.js';
import { isTextFile } from '../provenance/lines.js';

export interface AddRequest {
  readonly layers: readonly LayerSnapshot[];
  readonly composed: {
    readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  };
  readonly path: ManagedPath;
  readonly object: ManagedObject;
  readonly destinationLayerId: string;
}

export interface AddResult {
  readonly layers: readonly LayerSnapshot[];
  readonly invalidatedParentPins: readonly string[];
}

export interface DeleteRequest {
  readonly layers: readonly LayerSnapshot[];
  readonly composed: {
    readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  };
  readonly path: ManagedPath;
}

export interface DeleteResult {
  readonly layers: readonly LayerSnapshot[];
  readonly invalidatedParentPins: readonly string[];
}

export interface UnmanageRequest {
  readonly layers: readonly LayerSnapshot[];
  readonly composed: {
    readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  };
  readonly path: ManagedPath;
}

export interface UnmanageResult {
  readonly layers: readonly LayerSnapshot[];
  readonly invalidatedParentPins: readonly string[];
}

export interface MoveRequest {
  readonly layers: readonly LayerSnapshot[];
  readonly composed: {
    readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  };
  readonly path: ManagedPath;
  readonly sourceLayerId: string;
  readonly destinationLayerId: string;
}

/** Move a stored representation by deleting it, then re-adding its effective value. */
export function moveManagedObject(request: MoveRequest): AddResult {
  const path = validateManagedPath(request.path);
  const sourceIndex = request.layers.findIndex(
    (layer) => layer.id === request.sourceLayerId,
  );
  const destinationIndex = request.layers.findIndex(
    (layer) => layer.id === request.destinationLayerId,
  );
  if (
    sourceIndex < 0 ||
    destinationIndex < 0 ||
    sourceIndex === destinationIndex
  )
    invalid('Move requires distinct source and destination layers.');
  const source = at(request.layers, sourceIndex);
  if (!representsPath(source, path))
    throw new LayerdotsError(
      `Source layer does not represent ${path}.`,
      'operation-conflict',
    );
  const effective = request.composed.objects.get(path);
  if (!effective)
    throw new LayerdotsError(
      `Cannot move deleted path: ${path}.`,
      'operation-conflict',
    );
  const candidates = request.layers.map(cloneSnapshot);
  const sourceObjects = mutableObjects(at(candidates, sourceIndex));
  sourceObjects.delete(path);
  sourceObjects.delete(`${path}.patch`);
  sourceObjects.delete(`${path}.delete`);
  const destination = at(candidates, destinationIndex);
  if (destinationIndex === 0) {
    mutableObjects(destination).set(
      path,
      requireObject(cloneObjectSingle(effective)),
    );
  } else {
    const lower = composeLayers(
      firstLayer(candidates),
      candidates.slice(1, destinationIndex),
    ).objects.get(path);
    replaceRepresentation(mutableObjects(destination), path, lower, effective);
  }
  regenerateOverlaysAbove(candidates, destinationIndex, path, effective);
  const after = composeLayers(firstLayer(candidates), candidates.slice(1));
  const actual = after.objects.get(path);
  if (!actual || !equalManagedObjects(actual, effective))
    throw new LayerdotsError(
      'Move did not preserve effective content.',
      'workflow-invariant-broken',
    );
  verifyAddInvariant(request.composed, after, path);
  return {
    layers: candidates,
    invalidatedParentPins: candidates
      .slice(Math.min(sourceIndex, destinationIndex) + 1)
      .map((layer) => layer.id),
  };
}

export function addManagedObject(request: AddRequest): AddResult {
  const { layers, path, object } = request;
  if (!Array.isArray(layers) || layers.length === 0)
    invalid('addManagedObject requires at least one layer.');
  const validatedPath = validateManagedPath(path);
  const candidates = layers.map(cloneSnapshot);
  const base = firstLayer(candidates);
  const overlays = candidates.slice(1);
  const destinationIndex = candidates.findIndex(
    (layer) => layer.id === request.destinationLayerId,
  );
  if (destinationIndex < 0) invalid('Unknown destination layer.');
  const destination = at(candidates, destinationIndex);

  if (destinationIndex === 0) {
    const composedAtPath = request.composed.objects.get(validatedPath);
    if (composedAtPath !== undefined) {
      if (equalManagedObjects(composedAtPath, object)) {
        return { layers: candidates, invalidatedParentPins: [] };
      }
      const hasOverlayAbove = overlays.some((layer) =>
        representsPath(layer, validatedPath),
      );
      if (!hasOverlayAbove)
        throw new LayerdotsError(
          `Cannot add over a different value at ${path}.`,
          'operation-conflict',
        );
    }
    mutableObjects(base).set(
      validatedPath,
      requireObject(cloneObjectSingle(object)),
    );
    const firstOverlayWithPatch = overlays.findIndex((layer) =>
      representsPath(layer, validatedPath),
    );
    if (firstOverlayWithPatch >= 0) {
      const originalEffective = composeLayers(
        firstLayer(layers),
        layers.slice(1),
      ).objects.get(validatedPath);
      regenerateOverlaysAbove(candidates, 0, validatedPath, originalEffective);
    }
  } else {
    const lowerComposition = composeLayers(
      firstLayer(candidates),
      candidates.slice(1, destinationIndex),
    );
    const lower = lowerComposition.objects.get(validatedPath);
    replaceRepresentation(
      mutableObjects(destination),
      validatedPath,
      lower,
      object,
    );
    for (
      let index = destinationIndex + 1;
      index < candidates.length;
      index += 1
    ) {
      const originalEffective = composeLayers(
        firstLayer(layers),
        layers.slice(1, index + 1),
      ).objects.get(validatedPath);
      const lowerComp = composeLayers(
        firstLayer(candidates),
        candidates.slice(1, index),
      );
      const lowerForOverlay = lowerComp.objects.get(validatedPath);
      const desired = cloneObjectSingle(originalEffective);
      replaceRepresentation(
        mutableObjects(at(candidates, index)),
        validatedPath,
        lowerForOverlay,
        desired,
      );
    }
  }

  const composedAfter = composeLayers(
    firstLayer(candidates),
    candidates.slice(1),
  );
  verifyAddInvariant(request.composed, composedAfter, validatedPath);
  const invalidatedParentPins = candidates
    .slice(destinationIndex + 1)
    .map((layer) => layer.id);
  return { layers: candidates, invalidatedParentPins };
}

export function deleteManagedObject(request: DeleteRequest): DeleteResult {
  const { layers, path } = request;
  if (!Array.isArray(layers) || layers.length === 0)
    invalid('deleteManagedObject requires at least one layer.');
  const validatedPath = validateManagedPath(path);
  const candidates = layers.map(cloneSnapshot);
  const composedObjects = composeLayers(
    firstLayer(candidates),
    candidates.slice(1),
  ).objects;
  if (!composedObjects.has(validatedPath))
    throw new LayerdotsError(
      `Cannot delete unmanaged path: ${path}.`,
      'operation-conflict',
    );
  const topOverlay = at(candidates, candidates.length - 1);
  const tombstoneKey = `${validatedPath}.delete`;
  mutableObjects(topOverlay).set(tombstoneKey, {
    kind: 'file',
    content: new Uint8Array(),
    executable: false,
  });
  const composedAfter = composeLayers(
    firstLayer(candidates),
    candidates.slice(1),
  );
  verifyDeleteUnmanageInvariant(request.composed, composedAfter, validatedPath);
  return { layers: candidates, invalidatedParentPins: [] };
}

export function unmanageManagedObject(
  request: UnmanageRequest,
): UnmanageResult {
  const { layers, path } = request;
  if (!Array.isArray(layers) || layers.length === 0)
    invalid('unmanageManagedObject requires at least one layer.');
  const validatedPath = validateManagedPath(path);
  const candidates = layers.map(cloneSnapshot);
  const isInLayers = candidates.some(
    (layer) =>
      layer.objects.has(validatedPath) ||
      layer.objects.has(`${validatedPath}.patch`) ||
      layer.objects.has(`${validatedPath}.delete`),
  );
  if (!isInLayers)
    throw new LayerdotsError(
      `Cannot unmanage path not in any layer: ${path}.`,
      'operation-conflict',
    );
  mutableObjects(firstLayer(candidates)).delete(validatedPath);
  for (const overlay of candidates.slice(1)) {
    mutableObjects(overlay).delete(validatedPath);
    mutableObjects(overlay).delete(`${validatedPath}.patch`);
    mutableObjects(overlay).delete(`${validatedPath}.delete`);
  }
  const composedAfter = composeLayers(
    firstLayer(candidates),
    candidates.slice(1),
  );
  verifyDeleteUnmanageInvariant(request.composed, composedAfter, validatedPath);
  const invalidatedParentPins = candidates.slice(1).map((layer) => layer.id);
  return { layers: candidates, invalidatedParentPins };
}

function regenerateOverlaysAbove(
  candidates: LayerSnapshot[],
  belowIndex: number,
  path: string,
  originalEffective: ManagedObject | undefined,
): void {
  for (let index = belowIndex + 1; index < candidates.length; index += 1) {
    const layer = at(candidates, index);
    if (!representsPath(layer, path)) continue;
    const lowerComp = composeLayers(
      firstLayer(candidates),
      candidates.slice(1, index),
    );
    const lower = lowerComp.objects.get(path);
    replaceRepresentation(
      mutableObjects(layer),
      path,
      lower,
      cloneObjectSingle(originalEffective),
    );
  }
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
    const clone = cloneObjectSingle(desired);
    if (clone) objects.set(path, clone);
  }
}

function verifyAddInvariant(
  before: { objects: ReadonlyMap<ManagedPath, ManagedObject> },
  after: { objects: ReadonlyMap<ManagedPath, ManagedObject> },
  changedPath: string,
): void {
  for (const path of before.objects.keys()) {
    if (path === changedPath) continue;
    const beforeObj = before.objects.get(path);
    const afterObj = after.objects.get(path);
    if (
      beforeObj === undefined ||
      afterObj === undefined ||
      !equalManagedObjects(beforeObj, afterObj)
    )
      throw new LayerdotsError(
        `Composition invariant broken at ${path}.`,
        'workflow-invariant-broken',
      );
  }
  for (const path of after.objects.keys()) {
    if (path === changedPath) continue;
    if (!before.objects.has(path))
      throw new LayerdotsError(
        `Composition invariant broken: unexpected path ${path}.`,
        'workflow-invariant-broken',
      );
  }
}

function verifyDeleteUnmanageInvariant(
  before: { objects: ReadonlyMap<ManagedPath, ManagedObject> },
  after: { objects: ReadonlyMap<ManagedPath, ManagedObject> },
  removedPath: string,
): void {
  if (after.objects.has(removedPath))
    throw new LayerdotsError(
      `Composition invariant broken: ${removedPath} should be absent.`,
      'workflow-invariant-broken',
    );
  for (const path of before.objects.keys()) {
    if (path === removedPath) continue;
    const beforeObj = before.objects.get(path);
    const afterObj = after.objects.get(path);
    if (
      beforeObj === undefined ||
      afterObj === undefined ||
      !equalManagedObjects(beforeObj, afterObj)
    )
      throw new LayerdotsError(
        `Composition invariant broken at ${path}.`,
        'workflow-invariant-broken',
      );
  }
  for (const path of after.objects.keys()) {
    if (!before.objects.has(path))
      throw new LayerdotsError(
        `Composition invariant broken: unexpected path ${path}.`,
        'workflow-invariant-broken',
      );
  }
}

function representsPath(layer: LayerSnapshot, path: string): boolean {
  return (
    layer.objects.has(path) ||
    layer.objects.has(`${path}.patch`) ||
    layer.objects.has(`${path}.delete`)
  );
}

function mutableObjects(layer: LayerSnapshot): Map<string, ManagedObject> {
  return layer.objects as Map<string, ManagedObject>;
}

function firstLayer(layers: readonly LayerSnapshot[]): LayerSnapshot {
  const layer = layers[0];
  if (!layer) invalid('Layer list must not be empty.');
  return layer;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined)
    throw new LayerdotsError('Index out of range.', 'operation-invalid');
  return value;
}

function requireObject(value: ManagedObject | undefined): ManagedObject {
  if (value === undefined)
    throw new LayerdotsError('Expected a managed object.', 'operation-invalid');
  return value;
}

function cloneSnapshot(layer: LayerSnapshot): LayerSnapshot {
  const objects = new Map<string, ManagedObject>();
  for (const [path, object] of layer.objects) {
    const clone = cloneObjectSingle(object);
    if (clone) objects.set(path, clone);
  }
  return { ...layer, objects };
}

function cloneObjectSingle(
  object: ManagedObject | undefined,
): ManagedObject | undefined {
  return object?.kind === 'file'
    ? { ...object, content: new Uint8Array(object.content) }
    : object
      ? { ...object }
      : undefined;
}

function invalid(message: string): never {
  throw new LayerdotsError(message, 'operation-invalid');
}
