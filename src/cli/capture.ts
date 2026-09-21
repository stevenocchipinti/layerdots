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
import {
  readTransaction,
  stageAllHunks,
  stageAssignment,
  transactionSnapshots,
} from '../transaction/transaction.js';
import { composeStack, readStackSwitch } from '../lifecycle/switch.js';
import type { AssignmentHunkSelection } from '../assignment/assign.js';

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
  const stackSwitch = await readStackSwitch(
    options.paths,
    options.stack.target,
  );
  const lines = changes.map(
    (change) =>
      `UNASSIGNED ${change.path} STATUS ${change.status} KIND ${change.kind}`,
  );
  if (transaction !== undefined) {
    lines.push('STAGED TRANSACTION');
    for (const assignment of transaction.assignments ?? [])
      lines.push(
        `STAGED ${assignment.path} LAYER ${assignment.destination} SELECTIONS ${String(assignment.selections.length)}`,
      );
  }
  if (stackSwitch !== undefined)
    lines.push(
      `STAGED STACK SWITCH LAYERS ${String(stackSwitch.from.layers.length)} -> ${String(stackSwitch.to.layers.length)}`,
    );
  return `${(lines.length === 0 ? ['CLEAN'] : lines).join('\n')}\n`;
}

export async function captureDiff(options: {
  readonly stack: ActiveStack;
  readonly paths: LayerdotsPaths;
  readonly color: DiffColor;
}): Promise<string> {
  const { composed } = await loaded(options.stack);
  const transaction = await readTransaction(
    options.paths,
    options.stack.target,
  );
  const stackSwitch = await readStackSwitch(
    options.paths,
    options.stack.target,
  );
  const snapshots = transaction && transactionSnapshots(transaction);
  const base = snapshots?.[0];
  if (snapshots && !base)
    throw new LayerdotsError(
      'Staged transaction has no layers.',
      'TRANSACTION_INVALID',
    );
  const staged = base && composeLayers(base, snapshots.slice(1));
  const target = await readManagedPaths(
    options.stack.target,
    new Set([...composed.objects.keys(), ...(staged?.objects.keys() ?? [])]),
  );
  const changes = compareManagedState(composed.objects, target).filter(
    (change) => change.status !== 'unchanged',
  );
  const current =
    changes.length === 0
      ? 'CLEAN\n'
      : `${renderManagedDiff(changes, { color: options.color }).trimEnd()}\n`;
  if (transaction === undefined && stackSwitch === undefined) return current;
  if (stackSwitch !== undefined) {
    const staged = await composeStack(stackSwitch.to);
    const review = renderManagedDiff(
      compareManagedState(composed.objects, staged.objects).filter(
        (change) => change.status !== 'unchanged',
      ),
      { color: options.color },
    ).trimEnd();
    return [
      'TARGET DIFF',
      current.trimEnd(),
      'STAGED STACK SWITCH',
      review || 'CLEAN',
      '',
    ].join('\n');
  }
  if (transaction === undefined)
    throw new LayerdotsError(
      'Staged transaction is invalid.',
      'TRANSACTION_INVALID',
    );
  if (!staged)
    throw new LayerdotsError(
      'Staged transaction has no layers.',
      'TRANSACTION_INVALID',
    );
  const stagedChanges = compareManagedState(staged.objects, target).filter(
    (change) => change.status !== 'unchanged',
  );
  const review = renderManagedDiff(
    compareManagedState(composed.objects, staged.objects).filter(
      (change) => change.status !== 'unchanged',
    ),
    { color: options.color },
  ).trimEnd();
  return [
    'TARGET DIFF',
    current.trimEnd(),
    'STAGED DIFF',
    review || 'CLEAN',
    'REMAINING TARGET DIFF',
    stagedChanges.length === 0
      ? 'CLEAN'
      : renderManagedDiff(stagedChanges, { color: options.color }).trimEnd(),
    '',
  ].join('\n');
}

export async function assignCommand(options: {
  readonly stack: ActiveStack;
  readonly paths: LayerdotsPaths;
  readonly path: string;
  readonly layer: 'base' | 'overlay';
  readonly selections?: readonly AssignmentHunkSelection[];
}): Promise<string> {
  if (options.selections === undefined)
    await stageAllHunks({
      paths: options.paths,
      stack: options.stack,
      path: options.path,
      destination: options.layer,
    });
  else
    await stageAssignment({
      paths: options.paths,
      stack: options.stack,
      path: options.path,
      destination: options.layer,
      selections: options.selections,
    });
  return `STAGED ${options.path} LAYER ${options.layer}\n`;
}

export async function selectAssignment(options: {
  readonly stack: ActiveStack;
  readonly path: string;
  readonly write: (value: string) => void;
  readonly read: () => Promise<string | undefined>;
}): Promise<readonly AssignmentHunkSelection[] | undefined> {
  const { layers, composed } = await loaded(options.stack);
  const target = await readManagedPaths(
    options.stack.target,
    new Set([...composed.objects.keys(), options.path]),
  );
  const change = detectUnassignedChanges(layers, composed, target, [
    ...composed.objects.keys(),
    options.path,
  ]).find((candidate) => candidate.path === options.path);
  if (change === undefined)
    throw new LayerdotsError(
      `No unassigned change exists at ${options.path}.`,
      'ASSIGNMENT_NOT_FOUND',
    );
  if (change.kind === 'whole-object') {
    options.write(`${change.status.toUpperCase()} ${change.path} [y/n/q] `);
    const answer = (await options.read())?.trim().toLowerCase();
    return answer === 'y' ? [{ hunkIndex: 0 }] : undefined;
  }
  const selections: AssignmentHunkSelection[] = [];
  for (const [hunkIndex, hunk] of change.hunks.entries()) {
    options.write(
      `HUNK ${String(hunkIndex + 1)}/${String(change.hunks.length)} ${String(hunk.oldStart)},${String(hunk.oldCount)} -> ${String(hunk.newStart)},${String(hunk.newCount)}\n${hunk.edits.map((edit) => `${edit.kind === 'add' ? '+' : edit.kind === 'remove' ? '-' : ' '}${edit.line.text}`).join('\n')}\nStage this hunk? [y/n/l/q] `,
    );
    const answer = (await options.read())?.trim().toLowerCase();
    if (answer === 'q' || answer === undefined) return undefined;
    if (answer === 'y') {
      selections.push({ hunkIndex });
      continue;
    }
    if (answer !== 'l') continue;
    const editIndexes: number[] = [];
    for (const [editIndex, edit] of hunk.edits.entries()) {
      if (edit.kind === 'same') continue;
      options.write(
        `  ${String(editIndex + 1)} ${edit.kind === 'add' ? '+' : '-'}${edit.line.text} [y/n] `,
      );
      if ((await options.read())?.trim().toLowerCase() === 'y')
        editIndexes.push(editIndex);
    }
    if (editIndexes.length > 0) selections.push({ hunkIndex, editIndexes });
  }
  return selections.length > 0 ? selections : undefined;
}

export function absoluteTarget(cwd: string, target: string): string {
  return resolvePath(cwd, target);
}
