import { resolve as resolvePath } from 'node:path';
import { composeLayers } from '../composition/compose.js';
import { calculateProvenance } from '../provenance/provenance.js';
import { detectUnassignedChanges } from '../provenance/unassigned.js';
import { loadLayerSnapshot } from '../repositories/snapshot-loader.js';
import { readManagedPaths } from '../repositories/tree-reader.js';
import { compareManagedState } from '../status/status.js';
import { renderManagedDiff, type DiffColor } from '../status/diff.js';
import type { LayerSnapshot } from '../domain/objects.js';

export interface InspectOptions {
  readonly base: string;
  readonly overlays: readonly string[];
  readonly target?: string;
  readonly color: DiffColor;
  readonly cwd?: string;
}

export async function inspect(options: InspectOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const base = await loadLayerSnapshot(resolvePath(cwd, options.base), 'base');
  const overlays: LayerSnapshot[] = [];
  for (const [index, path] of options.overlays.entries()) {
    overlays.push(
      await loadLayerSnapshot(
        resolvePath(cwd, path),
        `overlay-${String(index + 1)}`,
      ),
    );
  }
  const layers = [base, ...overlays];
  const composed = composeLayers(base, overlays);
  const provenance = calculateProvenance(layers, composed);
  const output: string[] = ['COMPOSED'];

  for (const path of [...provenance.files.keys()].sort()) {
    const file = provenance.files.get(path);
    if (!file) continue;
    output.push(
      `PATH ${path} STATUS ${file.deleted ? 'deleted' : 'managed'} OWNER ${file.owner ?? 'unassigned'} OPERATION ${file.operation} OVERRIDE ${file.overridesLower ? 'yes' : 'no'} DELETED ${file.deleted ? 'yes' : 'no'}`,
    );
    for (const [lineNumber, line] of (
      provenance.lines.get(path) ?? []
    ).entries()) {
      output.push(
        `LINE ${String(lineNumber + 1)} OWNER ${line.owner} OPERATION ${line.operation} OVERRIDE ${line.overridesLower ? 'yes' : 'no'} ${line.line.text}`,
      );
    }
  }

  if (options.target !== undefined) {
    const managedPaths = new Set([
      ...composed.objects.keys(),
      ...composed.metadata.keys(),
    ]);
    const target = await readManagedPaths(
      resolvePath(cwd, options.target),
      managedPaths,
    );
    const statuses = compareManagedState(composed.objects, target);
    const changes = detectUnassignedChanges(layers, composed, target, [
      ...managedPaths,
    ]);
    const changed = statuses.filter((entry) => entry.status !== 'unchanged');
    output.push('TARGET');
    if (changed.length > 0)
      output.push(
        renderManagedDiff(changed, { color: options.color }).trimEnd(),
      );
    for (const change of changes) {
      output.push(
        `UNASSIGNED ${change.path} STATUS ${change.status} KIND ${change.kind}`,
      );
      for (const hunk of change.hunks) {
        output.push(
          `HUNK ${String(hunk.oldStart)},${String(hunk.oldCount)} -> ${String(hunk.newStart)},${String(hunk.newCount)}`,
        );
        for (const edit of hunk.edits) {
          const prefix =
            edit.kind === 'same' ? ' ' : edit.kind === 'add' ? '+' : '-';
          output.push(`LINE OWNER unassigned ${prefix}${edit.line.text}`);
        }
      }
    }
  }
  return `${output.filter((line) => line.length > 0).join('\n')}\n`;
}
