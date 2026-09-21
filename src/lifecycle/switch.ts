import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { applyComposition, previewComposition } from '../apply/apply.js';
import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import { loadLayerSnapshot } from '../repositories/snapshot-loader.js';
import { runGit } from '../repositories/git.js';
import { readTransaction } from '../transaction/transaction.js';
import { discoverStack } from './initialize.js';
import type { LayerdotsPaths } from './paths.js';
import type { ActiveStack } from './stack.js';
import { targetStateId, writeActiveStack } from './stack.js';

export interface StagedStackSwitch {
  readonly version: 1;
  readonly target: string;
  readonly from: ActiveStack;
  readonly to: ActiveStack;
}

function switchPath(paths: LayerdotsPaths, target: string): string {
  return join(paths.state, `stack-switch-${targetStateId(target)}.json`);
}

export async function stageStackSwitch(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
  readonly overlayUrl: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{
  readonly switch: StagedStackSwitch;
  readonly conflicts: readonly string[];
}> {
  if (
    (await readTransaction(options.paths, options.stack.target)) !== undefined
  )
    throw new LayerdotsError(
      'A staged transaction already exists. Commit it before switching stacks.',
      'TRANSACTION_EXISTS',
    );
  if (
    (await readStackSwitch(options.paths, options.stack.target)) !== undefined
  )
    throw new LayerdotsError(
      'A stack switch is already staged. Apply it before staging another switch.',
      'TRANSACTION_EXISTS',
    );
  const candidate = await discoverStack({
    overlayUrl: options.overlayUrl,
    target: options.stack.target,
    paths: options.paths,
    env: options.env,
  });
  await rejectSharedCloneTransition(options.stack, candidate, options.env);
  const composed = await composeStack(candidate);
  const preview = await previewComposition({
    targetRoot: options.stack.target,
    stateDir: options.paths.state,
    targetId: targetStateId(options.stack.target),
    composed,
    approvals: new Set(),
    workspaceRoot: options.paths.state,
    allowedSandboxRoot: resolve(options.paths.state, '..'),
  });
  const staged = {
    version: 1,
    target: options.stack.target,
    from: options.stack,
    to: candidate,
  } as const;
  if (preview.conflicts.length > 0)
    return {
      switch: staged,
      conflicts: preview.conflicts.map((conflict) => conflict.workspace),
    };
  await writeStackSwitch(options.paths, staged);
  return { switch: staged, conflicts: [] };
}

export async function applyStackSwitch(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
}): Promise<readonly string[]> {
  const staged = await readStackSwitch(options.paths, options.stack.target);
  if (staged === undefined)
    throw new LayerdotsError(
      'No stack switch is staged.',
      'TRANSACTION_NOT_FOUND',
    );
  if (!sameStack(staged.from, options.stack))
    throw new LayerdotsError(
      'Staged stack switch does not match the active stack.',
      'TRANSACTION_INVALID',
    );
  const composed = await composeStack(staged.to);
  const result = await applyComposition({
    targetRoot: staged.target,
    stateDir: options.paths.state,
    targetId: targetStateId(staged.target),
    composed,
    approvals: new Set(),
    workspaceRoot: options.paths.state,
    allowedSandboxRoot: resolve(options.paths.state, '..'),
  });
  if (!result.applied)
    throw new LayerdotsError(
      `Stack switch conflicts are in ${result.conflicts[0]?.workspace ?? 'the conflict workspace'}.`,
      'STACK_SWITCH_CONFLICT',
    );
  await writeActiveStack(options.paths, staged.to);
  // The staged candidate composition may contain private content; the new applied
  // state is retained as the next merge base, while this transient snapshot is removed.
  await rm(switchPath(options.paths, staged.target), { force: true });
  return result.written;
}

export async function readStackSwitch(
  paths: LayerdotsPaths,
  target: string,
): Promise<StagedStackSwitch | undefined> {
  try {
    const value = JSON.parse(
      await readFile(switchPath(paths, target), 'utf8'),
    ) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Record<string, unknown>).version !== 1 ||
      (value as Record<string, unknown>).target !== resolve(target) ||
      !('from' in value) ||
      !('to' in value)
    )
      throw new LayerdotsError(
        'Staged stack switch is invalid.',
        'TRANSACTION_INVALID',
      );
    return value as StagedStackSwitch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      'Staged stack switch is invalid.',
      'TRANSACTION_INVALID',
      { cause: error },
    );
  }
}

export async function composeStack(stack: ActiveStack) {
  const layers = await Promise.all(
    stack.layers.map((layer, index) =>
      loadLayerSnapshot(
        layer.root,
        index === 0 ? 'base' : `overlay-${String(index)}`,
      ),
    ),
  );
  const base = layers[0];
  if (base === undefined)
    throw new LayerdotsError('Active stack has no layers.', 'STACK_INVALID');
  return composeLayers(base, layers.slice(1));
}

function sameStack(left: ActiveStack, right: ActiveStack): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writeStackSwitch(
  paths: LayerdotsPaths,
  staged: StagedStackSwitch,
): Promise<void> {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const destination = switchPath(paths, staged.target);
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(staged, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function rejectSharedCloneTransition(
  active: ActiveStack,
  candidate: ActiveStack,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const activeByRoot = new Map(
    active.layers.map((layer) => [layer.root, layer]),
  );
  const changed = candidate.layers.filter((layer) => {
    const current = activeByRoot.get(layer.root);
    return current !== undefined && current.commit !== layer.commit;
  });
  if (changed.length === 0) return;
  for (const layer of changed) {
    const current = activeByRoot.get(layer.root);
    if (current !== undefined)
      await runGit(['checkout', '--quiet', '--detach', current.commit], {
        cwd: layer.root,
        env,
      });
  }
  throw new LayerdotsError(
    'Switching a shared clone at a different commit requires a separate checkout.',
    'STACK_SHARED_CLONE_TRANSITION',
  );
}
