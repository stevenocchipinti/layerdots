import { resolve as resolvePath } from 'node:path';

import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import { detectUnassignedChanges } from '../provenance/unassigned.js';
import { loadLayerSnapshot } from '../repositories/snapshot-loader.js';
import { readManagedPaths } from '../repositories/tree-reader.js';
import { renderManagedDiff, type DiffColor } from '../status/diff.js';
import { compareManagedState } from '../status/status.js';
import type { LayerdotsPaths } from '../lifecycle/paths.js';
import type { ActiveStack } from '../lifecycle/stack.js';
import { readTransaction, stageAllHunks } from '../transaction/transaction.js';

async function loaded(stack: ActiveStack) {
  const layers = [];
  for (const [index, layer] of stack.layers.entries()) {
    layers.push(
      await loadLayerSnapshot(
        layer.root,
        index === 0 ? 'base' : `overlay-${String(index)}`,
      ),
    );
  }
  const base = layers[0];
  if (base === undefined)
    throw new LayerdotsError('Active stack has no layers.', 'STACK_INVALID');
  return { layers, composed: composeLayers(base, layers.slice(1)) };
}

export async function captureStatus(options: {
  readonly stack: ActiveStack;
  readonly paths: LayerdotsPaths;
}): Promise<string> {
  const { layers, composed } = await loaded(options.stack);
  const target = await readManagedPaths(
    options.stack.target,
    composed.objects.keys(),
  );
  const changes = detectUnassignedChanges(layers, composed, target, [
    ...composed.objects.keys(),
  ]);
  const transaction = await readTransaction(
    options.paths,
    options.stack.target,
  );
  const lines = changes.map(
    (change) =>
      `UNASSIGNED ${change.path} STATUS ${change.status} KIND ${change.kind}`,
  );
  if (transaction !== undefined) lines.push('STAGED TRANSACTION');
  return `${(lines.length === 0 ? ['CLEAN'] : lines).join('\n')}\n`;
}

export async function captureDiff(options: {
  readonly stack: ActiveStack;
  readonly color: DiffColor;
}): Promise<string> {
  const { composed } = await loaded(options.stack);
  const target = await readManagedPaths(
    options.stack.target,
    composed.objects.keys(),
  );
  const changes = compareManagedState(composed.objects, target).filter(
    (change) => change.status !== 'unchanged',
  );
  return changes.length === 0
    ? 'CLEAN\n'
    : `${renderManagedDiff(changes, { color: options.color }).trimEnd()}\n`;
}

export async function assignCommand(options: {
  readonly stack: ActiveStack;
  readonly paths: LayerdotsPaths;
  readonly path: string;
  readonly layer: 'base' | 'overlay';
}): Promise<string> {
  await stageAllHunks({
    paths: options.paths,
    stack: options.stack,
    path: options.path,
    destination: options.layer,
  });
  return `STAGED ${options.path} LAYER ${options.layer}\n`;
}

export function absoluteTarget(cwd: string, target: string): string {
  return resolvePath(cwd, target);
}
