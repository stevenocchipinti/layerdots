import type {
  ComposedSnapshot,
  CompositionOperation,
} from '../composition/compose.js';
import { applyUnifiedPatch } from '../composition/patch.js';
import type {
  LayerSnapshot,
  ManagedObject,
  ManagedPath,
} from '../domain/objects.js';
import {
  alignLines,
  isTextFile,
  splitTextLines,
  type TextLine,
} from './lines.js';

export interface FileProvenance {
  readonly path: ManagedPath;
  readonly owner?: string;
  readonly operation: CompositionOperation;
  readonly overridesLower: boolean;
  readonly deleted: boolean;
}

export interface LineProvenance {
  readonly line: TextLine;
  readonly owner: string;
  readonly operation: 'base' | 'addition' | 'replacement' | 'unchanged';
  readonly overridesLower: boolean;
}

export interface ProvenanceResult {
  readonly files: ReadonlyMap<ManagedPath, FileProvenance>;
  readonly lines: ReadonlyMap<ManagedPath, readonly LineProvenance[]>;
}

export function calculateProvenance(
  layers: readonly LayerSnapshot[],
  composed: ComposedSnapshot,
): ProvenanceResult {
  const files = new Map<ManagedPath, FileProvenance>();
  for (const [path, metadata] of composed.metadata)
    files.set(path, {
      path,
      owner: metadata.layerId,
      operation: metadata.operation,
      overridesLower: metadata.lower !== undefined,
      deleted: metadata.operation === 'delete',
    });
  const lines = new Map<ManagedPath, readonly LineProvenance[]>();
  const current = new Map<
    ManagedPath,
    { object: ManagedObject; lines: readonly LineProvenance[] | undefined }
  >();
  const base = layers[0];
  if (base)
    for (const [path, object] of base.objects) {
      current.set(path, {
        object,
        lines: isTextFile(object)
          ? splitTextLines(object.content).map((line) => ({
              line,
              owner: base.id,
              operation: 'base',
              overridesLower: false,
            }))
          : undefined,
      });
    }
  for (const layer of layers.slice(1)) {
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
      const stored = layer.objects.get(source);
      if (!stored) continue;
      const lower = current.get(path);
      if (operation === 'delete') {
        current.delete(path);
        continue;
      }
      let object: ManagedObject = stored;
      if (
        operation === 'patch' &&
        lower?.object.kind === 'file' &&
        stored.kind === 'file'
      ) {
        const result = applyUnifiedPatch(
          lower.object.content,
          stored.content,
          path,
          lower.object.executable,
        );
        object = { kind: 'file', ...result };
      }
      let resultLines: LineProvenance[] | undefined;
      if (isTextFile(object)) {
        const next = splitTextLines(object.content);
        const previous = lower?.lines;
        if (previous && operation === 'patch') {
          const old = previous.map((entry) => entry.line);
          const alignment = alignLines(old, next);
          resultLines = next.map((line, index) => {
            const match = alignment.edits.find(
              (edit) => edit.kind !== 'remove' && edit.newIndex === index,
            );
            if (match?.kind === 'same') {
              const prior = previous[match.oldIndex];
              if (!prior) throw new Error('Invalid line provenance alignment');
              return {
                line,
                owner: alignment.ambiguousNew.has(index)
                  ? 'ambiguous'
                  : prior.owner,
                operation: prior.operation,
                overridesLower: prior.overridesLower,
              };
            }
            return {
              line,
              owner: layer.id,
              operation: 'addition',
              overridesLower: true,
            };
          });
        } else
          resultLines = next.map((line) => ({
            line,
            owner: layer.id,
            operation: 'replacement',
            overridesLower: lower !== undefined,
          }));
      }
      current.set(path, { object, lines: resultLines });
    }
  }
  for (const [path, value] of current)
    if (value.lines) lines.set(path, value.lines);
  return { files, lines };
}

export const getProvenance = calculateProvenance;
