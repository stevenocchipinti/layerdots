import { LayerdotsError } from '../domain/errors.js';
import { layerRole } from '../domain/manifest.js';
import type {
  LayerSnapshot,
  ManagedObject,
  ManagedPath,
} from '../domain/objects.js';
import { classifyFileContent } from '../repositories/tree-reader.js';
import { applyUnifiedPatch } from './patch.js';

export type CompositionOperation = 'add' | 'replace' | 'patch' | 'delete';

export interface CompositionMetadata {
  readonly layerId: string;
  readonly operation: CompositionOperation;
  readonly lower?: ManagedObject;
}

export interface ComposedSnapshot {
  readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  readonly metadata: ReadonlyMap<ManagedPath, CompositionMetadata>;
}

export function composeLayers(
  base: LayerSnapshot,
  overlays: readonly LayerSnapshot[] = [],
): ComposedSnapshot {
  assertRole(base, 'base');
  for (const overlay of overlays) assertRole(overlay, 'overlay');
  const objects = new Map<ManagedPath, ManagedObject>();
  const metadata = new Map<ManagedPath, CompositionMetadata>();
  for (const [path, object] of base.objects) {
    objects.set(path, cloneObject(object));
    metadata.set(path, { layerId: base.id, operation: 'add' });
  }
  for (const layer of overlays) applyLayer(layer, objects, metadata);
  return { objects, metadata };
}

function applyLayer(
  layer: LayerSnapshot,
  objects: Map<string, ManagedObject>,
  metadata: Map<string, CompositionMetadata>,
): void {
  const representations = new Map<
    string,
    { source: string; operation: CompositionOperation }
  >();
  for (const source of layer.objects.keys()) {
    const operation = source.endsWith('.patch')
      ? 'patch'
      : source.endsWith('.delete')
        ? 'delete'
        : 'replace';
    const path =
      operation === 'patch'
        ? source.slice(0, -6)
        : operation === 'delete'
          ? source.slice(0, -7)
          : source;
    if (path.length === 0 || representations.has(path)) {
      throw new LayerdotsError(
        `Contradictory overlay representations for ${path || source}.`,
        'composition-contradiction',
      );
    }
    representations.set(path, { source, operation });
  }
  const paths = [...representations.keys()].sort();
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1] as string;
    const current = paths[index] as string;
    if (current.startsWith(`${previous}/`)) {
      throw new LayerdotsError(
        `Nested overlay representations collide: ${previous} and ${current}.`,
        'composition-contradiction',
      );
    }
  }
  for (const [path, representation] of representations) {
    const stored = layer.objects.get(representation.source);
    if (stored === undefined)
      throw new LayerdotsError(
        `Missing overlay object ${representation.source}.`,
        'composition-invalid-layer',
      );
    const lower = objects.get(path);
    if (representation.operation === 'delete') {
      if (
        stored.kind !== 'file' ||
        stored.content.length !== 0 ||
        lower === undefined
      ) {
        throw new LayerdotsError(
          `Invalid tombstone for ${path}.`,
          'composition-delete-failed',
        );
      }
      objects.delete(path);
      metadata.set(path, {
        layerId: layer.id,
        operation: 'delete',
        lower: cloneObject(lower),
      });
    } else if (representation.operation === 'patch') {
      if (
        stored.kind !== 'file' ||
        classifyFileContent(stored.content) !== 'text' ||
        lower?.kind !== 'file' ||
        classifyFileContent(lower.content) !== 'text'
      ) {
        throw new LayerdotsError(
          `Patch requires an existing UTF-8 regular file: ${path}.`,
          'composition-patch-invalid-target',
        );
      }
      const result = applyUnifiedPatch(
        lower.content,
        stored.content,
        path,
        lower.executable,
      );
      objects.set(path, { kind: 'file', ...result });
      metadata.set(path, {
        layerId: layer.id,
        operation: 'patch',
        lower: cloneObject(lower),
      });
    } else {
      objects.set(path, cloneObject(stored));
      metadata.set(path, {
        layerId: layer.id,
        operation: lower === undefined ? 'add' : 'replace',
        ...(lower === undefined ? {} : { lower: cloneObject(lower) }),
      });
    }
  }
}

function assertRole(
  snapshot: LayerSnapshot,
  expected: 'base' | 'overlay',
): void {
  if (layerRole(snapshot.manifest) !== expected)
    throw new LayerdotsError(
      `Expected ${expected} layer snapshot: ${snapshot.id}.`,
      'composition-invalid-layer',
    );
}

function cloneObject(object: ManagedObject): ManagedObject {
  return object.kind === 'file'
    ? { ...object, content: new Uint8Array(object.content) }
    : { ...object };
}
