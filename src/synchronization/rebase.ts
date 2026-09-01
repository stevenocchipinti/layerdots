import { createUnifiedPatch } from '../assignment/patch-generation.js';
import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import type { LayerManifestV1, ParentReference } from '../domain/manifest.js';
import type { LayerSnapshot, ManagedObject } from '../domain/objects.js';
import {
  mergeThreeWay,
  type MergeConflict,
  type ObjectSnapshot,
} from './merge.js';

export interface RebasePlan {
  readonly candidate?: LayerSnapshot;
  readonly conflicts: readonly MergeConflict[];
}

export function rebaseOverlay(
  oldParent: ObjectSnapshot,
  oldOverlay: LayerSnapshot,
  newParent: ObjectSnapshot,
  newParentRef: ParentReference,
): RebasePlan {
  validateParentReference(newParentRef);
  const ours = oldOverlayResult(oldParent, oldOverlay);
  const merged = mergeThreeWay(oldParent, ours, newParent);
  if (merged.conflicts.length > 0) return { conflicts: merged.conflicts };
  const objects = new Map<string, ManagedObject>();
  const paths = new Set([
    ...newParent.objects.keys(),
    ...merged.objects.keys(),
  ]);
  for (const path of paths) {
    const lower = newParent.objects.get(path),
      result = merged.objects.get(path);
    if (lower === undefined && result !== undefined)
      objects.set(path, clone(result));
    else if (lower !== undefined && result === undefined)
      objects.set(`${path}.delete`, emptyFile());
    else if (
      lower !== undefined &&
      result !== undefined &&
      !equal(lower, result)
    ) {
      if (
        lower.kind === 'file' &&
        result.kind === 'file' &&
        lower.executable === result.executable
      ) {
        try {
          objects.set(`${path}.patch`, {
            kind: 'file',
            content: createUnifiedPatch(path, lower.content, result.content),
            executable: false,
          });
          continue;
        } catch (error) {
          if (
            !(error instanceof LayerdotsError) ||
            error.code !== 'assignment-patch-unrepresentable'
          )
            throw error;
        }
      }
      objects.set(path, clone(result));
    }
  }
  const manifest: LayerManifestV1 = {
    ...oldOverlay.manifest,
    parent: { ...newParentRef },
  };
  return { candidate: { ...oldOverlay, manifest, objects }, conflicts: [] };
}

function validateParentReference(ref: ParentReference): void {
  if (
    typeof ref.url !== 'string' ||
    typeof ref.branch !== 'string' ||
    typeof ref.commit !== 'string' ||
    ref.url.trim() === '' ||
    ref.branch.trim() === '' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref.commit)
  )
    throw new LayerdotsError(
      'Invalid parent reference.',
      'invalid-parent-reference',
    );
}

function oldOverlayResult(
  parent: ObjectSnapshot,
  overlay: LayerSnapshot,
): ObjectSnapshot {
  const base: LayerSnapshot = {
    id: '__rebase-parent__',
    root: '',
    manifest: { version: 1 },
    objects: parent.objects,
  };
  return { objects: composeLayers(base, [overlay]).objects };
}
function emptyFile(): ManagedObject {
  return { kind: 'file', content: new Uint8Array(), executable: false };
}
function equal(a: ManagedObject, b: ManagedObject): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === 'symlink'
      ? b.kind === 'symlink' && a.target === b.target
      : b.kind === 'file' &&
        a.executable === b.executable &&
        Buffer.from(a.content).equals(b.content))
  );
}
function clone(object: ManagedObject): ManagedObject {
  return object.kind === 'file'
    ? { ...object, content: new Uint8Array(object.content) }
    : { ...object };
}
