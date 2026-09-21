import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { assignUnassignedChange } from '../assignment/assign.js';
import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import type { LayerManifestV1 } from '../domain/manifest.js';
import type { LayerSnapshot, ManagedObject } from '../domain/objects.js';
import { detectUnassignedChanges } from '../provenance/unassigned.js';
import { readManagedPaths } from '../repositories/tree-reader.js';
import { loadLayerSnapshot } from '../repositories/snapshot-loader.js';
import { runGit } from '../repositories/git.js';
import type { LayerdotsPaths } from '../lifecycle/paths.js';
import type { ActiveStack } from '../lifecycle/stack.js';

interface StoredObject {
  readonly path: string;
  readonly kind: 'file' | 'symlink';
  readonly content?: string;
  readonly executable?: boolean;
  readonly target?: string;
}

interface StoredLayer {
  readonly id: string;
  readonly url: string;
  readonly root: string;
  readonly branch: string;
  readonly commit: string;
  readonly manifest: LayerManifestV1;
  readonly objects: readonly StoredObject[];
}

export interface StagedTransaction {
  readonly version: 1;
  readonly target: string;
  readonly layers: readonly StoredLayer[];
}

function transactionPath(paths: LayerdotsPaths): string {
  return join(paths.state, 'transaction.json');
}

function snapshotFromLayer(layer: StoredLayer): LayerSnapshot {
  return {
    id: layer.id,
    root: layer.root,
    manifest: layer.manifest,
    objects: new Map(
      layer.objects.map((object) => [
        object.path,
        object.kind === 'file'
          ? {
              kind: 'file' as const,
              content: new Uint8Array(
                Buffer.from(object.content ?? '', 'base64'),
              ),
              executable: object.executable === true,
            }
          : { kind: 'symlink' as const, target: object.target ?? '' },
      ]),
    ),
  };
}

function storeLayer(
  snapshot: LayerSnapshot,
  active: ActiveStack['layers'][number],
): StoredLayer {
  return {
    id: snapshot.id,
    url: active.url,
    root: active.root,
    branch: active.branch,
    commit: active.commit,
    manifest: snapshot.manifest,
    objects: [...snapshot.objects.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, object]) =>
        object.kind === 'file'
          ? {
              path,
              kind: 'file' as const,
              content: Buffer.from(object.content).toString('base64'),
              executable: object.executable,
            }
          : { path, kind: 'symlink' as const, target: object.target },
      ),
  };
}

export async function stageAllHunks(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
  readonly path: string;
  readonly destination: 'base' | 'overlay';
}): Promise<StagedTransaction> {
  const layers = await loadActiveLayers(options.stack);
  const base = required(layers[0]);
  const composed = composeLayers(base, layers.slice(1));
  const target = await readManagedPaths(options.stack.target, [options.path]);
  const change = detectUnassignedChanges(layers, composed, target, [
    options.path,
  ])[0];
  if (change === undefined || change.path !== options.path) {
    throw new LayerdotsError(
      `No unassigned change exists at ${options.path}.`,
      'ASSIGNMENT_NOT_FOUND',
    );
  }
  const destinationLayerId =
    options.destination === 'base'
      ? 'base'
      : `overlay-${String(layers.length - 1)}`;
  const result = assignUnassignedChange({
    layers,
    composed,
    change,
    hunkIndexes:
      change.kind === 'whole-object'
        ? [0]
        : change.hunks.map((_hunk, index) => index),
    destinationLayerId,
  });
  const transaction: StagedTransaction = {
    version: 1,
    target: options.stack.target,
    layers: result.layers.map((layer, index) =>
      storeLayer(layer, required(options.stack.layers[index])),
    ),
  };
  await writeTransaction(options.paths, transaction);
  return transaction;
}

export async function readTransaction(
  paths: LayerdotsPaths,
  target: string,
): Promise<StagedTransaction | undefined> {
  try {
    const raw = await readFile(transactionPath(paths), 'utf8');
    const transaction = JSON.parse(raw) as unknown;
    if (
      typeof transaction !== 'object' ||
      transaction === null ||
      (transaction as Record<string, unknown>).version !== 1 ||
      (transaction as Record<string, unknown>).target !== resolve(target) ||
      !Array.isArray((transaction as Record<string, unknown>).layers)
    ) {
      throw new LayerdotsError(
        'Staged transaction does not match this target.',
        'TRANSACTION_INVALID',
      );
    }
    return transaction as StagedTransaction;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      'Staged transaction is invalid.',
      'TRANSACTION_INVALID',
      { cause: error },
    );
  }
}

export async function commitTransaction(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
  readonly env: NodeJS.ProcessEnv;
  readonly message: string;
}): Promise<ActiveStack> {
  const transaction = await readTransaction(
    options.paths,
    options.stack.target,
  );
  if (transaction === undefined)
    throw new LayerdotsError(
      'No staged transaction exists.',
      'TRANSACTION_NOT_FOUND',
    );
  const layers = transaction.layers;
  if (layers.length !== options.stack.layers.length)
    throw new LayerdotsError(
      'Staged transaction is invalid.',
      'TRANSACTION_INVALID',
    );
  const next: ActiveStack['layers'][number][] = [];
  let parentCommit: string | undefined;
  for (const [index, layer] of layers.entries()) {
    await requireClean(layer.root, options.env);
    const manifest: LayerManifestV1 =
      index === 0
        ? layer.manifest
        : {
            ...layer.manifest,
            parent: {
              ...required(layer.manifest.parent),
              commit: required(parentCommit),
            },
          };
    await materializeLayer(
      layer.root,
      index === 0 || manifest.parent?.commit === layer.manifest.parent?.commit
        ? undefined
        : manifest,
      snapshotFromLayer(layer).objects,
    );
    await runGit(['add', '--all'], { cwd: layer.root, env: options.env });
    const changed = await hasStagedChanges(layer.root, options.env);
    if (changed)
      await runGit(['commit', '--message', options.message], {
        cwd: layer.root,
        env: options.env,
      });
    const commit = (
      await runGit(['rev-parse', 'HEAD'], { cwd: layer.root, env: options.env })
    ).stdout.trim();
    parentCommit = commit;
    next.push({
      url: layer.url,
      root: layer.root,
      branch: layer.branch,
      commit,
    });
  }
  await rm(transactionPath(options.paths), { force: true });
  return { version: 1, target: options.stack.target, layers: next };
}

export async function pushStack(options: {
  readonly stack: ActiveStack;
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  for (const layer of options.stack.layers) {
    await requireClean(layer.root, options.env);
    await runGit(['push', 'origin', `HEAD:refs/heads/${layer.branch}`], {
      cwd: layer.root,
      env: options.env,
    });
  }
}

async function loadActiveLayers(stack: ActiveStack): Promise<LayerSnapshot[]> {
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

async function writeTransaction(
  paths: LayerdotsPaths,
  transaction: StagedTransaction,
): Promise<void> {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const destination = transactionPath(paths);
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(transaction, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function requireClean(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await runGit(['status', '--porcelain'], { cwd: root, env });
  if (result.stdout !== '')
    throw new LayerdotsError(
      `Managed layer repository has uncommitted changes: ${root}.`,
      'REPOSITORY_DIRTY',
    );
}

async function hasStagedChanges(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await runGit(['diff', '--cached', '--name-only'], {
    cwd: root,
    env,
  });
  return result.stdout !== '';
}

async function materializeLayer(
  root: string,
  manifest: LayerManifestV1 | undefined,
  objects: ReadonlyMap<string, ManagedObject>,
): Promise<void> {
  await rm(join(root, 'home'), { recursive: true, force: true });
  await mkdir(join(root, 'home'), { recursive: true, mode: 0o700 });
  if (manifest !== undefined)
    await writeFile(
      join(root, 'layerdots.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  for (const [path, object] of objects) {
    const destination = join(root, 'home', path);
    await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
    if (object.kind === 'file') {
      await writeFile(destination, object.content, {
        mode: object.executable ? 0o755 : 0o644,
      });
    } else await symlink(object.target, destination);
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new LayerdotsError(
      'Staged transaction is invalid.',
      'TRANSACTION_INVALID',
    );
  return value;
}
