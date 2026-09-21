import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import type { LayerSnapshot } from '../domain/objects.js';
import { runGit } from '../repositories/git.js';
import { loadLayerSnapshot } from '../repositories/snapshot-loader.js';
import type { LayerdotsPaths } from '../lifecycle/paths.js';
import type { ActiveStack } from '../lifecycle/stack.js';
import { stageLayerSnapshots } from '../transaction/transaction.js';
import { writeConflictWorkspace } from './conflict-workspace.js';
import { rebaseOverlay } from './rebase.js';

interface RemoteState {
  readonly head: string;
  readonly remote: string;
  readonly advance: boolean;
}

export type SyncResult =
  | { readonly kind: 'clean' }
  | { readonly kind: 'staged' }
  | { readonly kind: 'conflict'; readonly workspace: string };

export async function synchronizeStack(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
  readonly env: NodeJS.ProcessEnv;
}): Promise<SyncResult> {
  await recoverSynchronization(options.paths, options.stack, options.env);
  const remote = await preflight(options.stack, options.env);
  if (!remote.some((state) => state.advance)) return { kind: 'clean' };
  const old = await loadLayers(options.stack);
  const changed: number[] = [];
  try {
    await writeRecovery(options.paths, options.stack);
    const next: LayerSnapshot[] = [];
    for (const [index, layer] of options.stack.layers.entries()) {
      const oldLayer = required(old[index]);
      const state = required(remote[index]);
      if (index === 0) {
        if (state.advance) {
          await checkout(layer.root, state.remote, options.env);
          changed.push(index);
          next.push(await loadLayerSnapshot(layer.root, 'base'));
        } else next.push(oldLayer);
        continue;
      }
      const oldParent = composition(old, index - 1);
      const newParent = composition(next, index - 1);
      const parentChanged = !sameObjects(oldParent.objects, newParent.objects);
      if (state.advance && parentChanged) {
        throw new LayerdotsError(
          `Remote overlay ${layer.url} advanced while its parent changed.`,
          'REMOTE_OVERLAY_PARENT_UNEXPECTED',
        );
      }
      if (state.advance) {
        await checkout(layer.root, state.remote, options.env);
        changed.push(index);
        next.push(
          await loadLayerSnapshot(layer.root, `overlay-${String(index)}`),
        );
        continue;
      }
      if (!parentChanged) {
        next.push(oldLayer);
        continue;
      }
      const parentLayer = required(options.stack.layers[index - 1]);
      const plan = rebaseOverlay(oldParent, oldLayer, newParent, {
        url: parentLayer.url,
        branch: parentLayer.branch,
        commit: parentLayer.commit,
      });
      if (plan.conflicts.length > 0) {
        const workspace = await conflictWorkspace(
          options.paths,
          plan.conflicts,
        );
        await restore(options.stack, remote, changed, options.env);
        await clearRecovery(options.paths);
        return { kind: 'conflict', workspace };
      }
      next.push(required(plan.candidate));
    }
    await stageLayerSnapshots({
      paths: options.paths,
      stack: options.stack,
      layers: next,
    });
    await clearRecovery(options.paths);
    return { kind: 'staged' };
  } catch (error) {
    await restore(options.stack, remote, changed, options.env);
    await clearRecovery(options.paths);
    throw error;
  }
}

export async function recoverSynchronization(
  paths: LayerdotsPaths,
  stack: ActiveStack,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  let checkpoint: ActiveStack;
  try {
    checkpoint = JSON.parse(
      await readFile(recoveryPath(paths), 'utf8'),
    ) as ActiveStack;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new LayerdotsError(
      'Synchronization recovery checkpoint is invalid.',
      'SYNCHRONIZATION_RECOVERY_INVALID',
      { cause: error },
    );
  }
  if (
    checkpoint.target !== stack.target ||
    checkpoint.layers.length !== stack.layers.length
  ) {
    throw new LayerdotsError(
      'Synchronization recovery checkpoint does not match the active stack.',
      'SYNCHRONIZATION_RECOVERY_INVALID',
    );
  }
  for (const layer of checkpoint.layers)
    await checkout(layer.root, layer.commit, env);
  await clearRecovery(paths);
  return true;
}

async function preflight(
  stack: ActiveStack,
  env: NodeJS.ProcessEnv,
): Promise<RemoteState[]> {
  const states: RemoteState[] = [];
  for (const layer of stack.layers) {
    await requireClean(layer.root, env);
    const origin = (
      await runGit(['remote', 'get-url', 'origin'], { cwd: layer.root, env })
    ).stdout.trim();
    if (origin !== layer.url) {
      throw new LayerdotsError(
        `Managed clone identity changed: ${layer.root}.`,
        'REPOSITORY_IDENTITY_MISMATCH',
      );
    }
    await runGit(['fetch', '--quiet', 'origin', layer.branch], {
      cwd: layer.root,
      env,
    });
    const head = (
      await runGit(['rev-parse', 'HEAD'], { cwd: layer.root, env })
    ).stdout.trim();
    const remote = (
      await runGit(['rev-parse', `refs/remotes/origin/${layer.branch}`], {
        cwd: layer.root,
        env,
      })
    ).stdout.trim();
    if (head === remote) {
      states.push({ head, remote, advance: false });
      continue;
    }
    if (await ancestor(layer.root, head, remote, env)) {
      states.push({ head, remote, advance: true });
      continue;
    }
    if (await ancestor(layer.root, remote, head, env)) {
      states.push({ head, remote, advance: false });
      continue;
    }
    throw new LayerdotsError(
      `Remote branch diverged for ${layer.url}.`,
      'REMOTE_DIVERGED',
    );
  }
  return states;
}

async function ancestor(
  root: string,
  older: string,
  newer: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', older, newer], {
      cwd: root,
      env,
    });
    return true;
  } catch (error) {
    if (error instanceof LayerdotsError && error.code === 'git_command_failed')
      return false;
    throw error;
  }
}

async function loadLayers(stack: ActiveStack): Promise<LayerSnapshot[]> {
  const layers: LayerSnapshot[] = [];
  for (const [index, layer] of stack.layers.entries()) {
    layers.push(
      await loadLayerSnapshot(
        layer.root,
        index === 0 ? 'base' : `overlay-${String(index)}`,
      ),
    );
  }
  return layers;
}

function composition(layers: readonly LayerSnapshot[], index: number) {
  const base = required(layers[0]);
  return composeLayers(base, layers.slice(1, index + 1));
}

function sameObjects(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): boolean {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}

async function checkout(
  root: string,
  commit: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runGit(['checkout', '--quiet', '--detach', commit], { cwd: root, env });
}

async function restore(
  stack: ActiveStack,
  remote: readonly RemoteState[],
  changed: readonly number[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const index of changed) {
    const layer = required(stack.layers[index]);
    await checkout(layer.root, required(remote[index]).head, env);
  }
}

async function conflictWorkspace(
  paths: LayerdotsPaths,
  conflicts: Parameters<typeof writeConflictWorkspace>[0]['conflicts'],
): Promise<string> {
  const root = join(paths.state, 'conflicts');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return writeConflictWorkspace({
    workspaceRoot: root,
    allowedSandboxRoot: paths.state,
    transactionId: `sync-${String(Date.now())}`,
    conflicts,
  });
}

function recoveryPath(paths: LayerdotsPaths): string {
  return join(paths.state, 'sync-recovery.json');
}

async function writeRecovery(
  paths: LayerdotsPaths,
  stack: ActiveStack,
): Promise<void> {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  await writeFile(recoveryPath(paths), `${JSON.stringify(stack)}\n`, {
    mode: 0o600,
  });
}

async function clearRecovery(paths: LayerdotsPaths): Promise<void> {
  await rm(recoveryPath(paths), { force: true });
}

async function requireClean(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const status = await runGit(['status', '--porcelain'], { cwd: root, env });
  if (status.stdout !== '')
    throw new LayerdotsError(
      `Managed layer repository has uncommitted changes: ${root}.`,
      'REPOSITORY_DIRTY',
    );
}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new LayerdotsError(
      'Synchronization data is invalid.',
      'SYNCHRONIZATION_INVALID',
    );
  return value;
}
