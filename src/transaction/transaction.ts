import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  assignUnassignedChange,
  type AssignmentHunkSelection,
} from '../assignment/assign.js';
import { moveManagedObject } from '../assignment/workflows.js';
import { composeLayers } from '../composition/compose.js';
import { LayerdotsError } from '../domain/errors.js';
import type { LayerManifestV1 } from '../domain/manifest.js';
import type { LayerSnapshot, ManagedObject } from '../domain/objects.js';
import { detectUnassignedChanges } from '../provenance/unassigned.js';
import { readManagedPaths } from '../repositories/tree-reader.js';
import { validateManagedPath } from '../repositories/path-validation.js';
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
  readonly assignments?: readonly StagedAssignment[];
}

export interface StagedAssignment {
  readonly path: string;
  readonly destination: 'base' | 'overlay';
  readonly selections: readonly AssignmentHunkSelection[];
  readonly operation?: 'assign' | 'move';
  readonly source?: 'base' | 'overlay';
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
  return stageAssignment(options);
}

export async function stageAssignment(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
  readonly path: string;
  readonly destination: 'base' | 'overlay';
  readonly selections?: readonly AssignmentHunkSelection[];
}): Promise<StagedTransaction> {
  const existing = await readTransaction(options.paths, options.stack.target);
  const layers = existing
    ? [...transactionSnapshots(existing)]
    : await loadActiveLayers(options.stack);
  const base = required(layers[0]);
  const composed = composeLayers(base, layers.slice(1));
  const targetPaths = new Set([...composed.objects.keys(), options.path]);
  const target = await readManagedPaths(options.stack.target, targetPaths);
  const change = detectUnassignedChanges(layers, composed, target, [
    ...targetPaths,
  ]).find((candidate) => candidate.path === options.path);
  if (change === undefined) {
    throw new LayerdotsError(
      `No unassigned change exists at ${options.path}.`,
      'ASSIGNMENT_NOT_FOUND',
    );
  }
  const destinationLayerId =
    options.destination === 'base'
      ? 'base'
      : `overlay-${String(layers.length - 1)}`;
  const selections =
    options.selections ??
    change.hunks.map((_hunk, index) => ({ hunkIndex: index }));
  const result = assignUnassignedChange({
    layers,
    composed,
    change,
    selections:
      change.kind === 'whole-object' ? [{ hunkIndex: 0 }] : selections,
    destinationLayerId,
  });
  const transaction: StagedTransaction = {
    version: 1,
    target: options.stack.target,
    layers: result.layers.map((layer, index) =>
      storeLayer(layer, required(options.stack.layers[index])),
    ),
    assignments: [
      ...(existing?.assignments ?? []),
      {
        path: options.path,
        destination: options.destination,
        selections:
          change.kind === 'whole-object' ? [{ hunkIndex: 0 }] : selections,
      },
    ],
  };
  await writeTransaction(options.paths, transaction);
  return transaction;
}

export function transactionSnapshots(
  transaction: StagedTransaction,
): readonly LayerSnapshot[] {
  return transaction.layers.map(snapshotFromLayer);
}

export async function stageLayerSnapshots(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
  readonly layers: readonly LayerSnapshot[];
}): Promise<StagedTransaction> {
  if (
    (await readTransaction(options.paths, options.stack.target)) !== undefined
  ) {
    throw new LayerdotsError(
      'A staged transaction already exists. Commit it, or discard it with layerdots discard, before synchronizing.',
      'TRANSACTION_EXISTS',
    );
  }
  if (options.layers.length !== options.stack.layers.length) {
    throw new LayerdotsError(
      'Staged layers do not match the active stack.',
      'TRANSACTION_INVALID',
    );
  }
  const transaction: StagedTransaction = {
    version: 1,
    target: options.stack.target,
    layers: options.layers.map((layer, index) =>
      storeLayer(layer, required(options.stack.layers[index])),
    ),
  };
  await writeTransaction(options.paths, transaction);
  return transaction;
}

export async function stageMove(options: {
  readonly paths: LayerdotsPaths;
  readonly stack: ActiveStack;
  readonly path: string;
  readonly source: 'base' | 'overlay';
  readonly destination: 'base' | 'overlay';
}): Promise<StagedTransaction> {
  if (options.source === options.destination)
    throw new LayerdotsError(
      'Move requires distinct layers.',
      'TRANSACTION_INVALID',
    );
  const existing = await readTransaction(options.paths, options.stack.target);
  const layers = existing
    ? [...transactionSnapshots(existing)]
    : await loadActiveLayers(options.stack);
  const base = required(layers[0]);
  const composed = composeLayers(base, layers.slice(1));
  const idFor = (role: 'base' | 'overlay') =>
    role === 'base' ? 'base' : `overlay-${String(layers.length - 1)}`;
  const result = moveManagedObject({
    layers,
    composed,
    path: options.path,
    sourceLayerId: idFor(options.source),
    destinationLayerId: idFor(options.destination),
  });
  const transaction: StagedTransaction = {
    version: 1,
    target: options.stack.target,
    layers: result.layers.map((layer, index) =>
      storeLayer(layer, required(options.stack.layers[index])),
    ),
    assignments: [
      ...(existing?.assignments ?? []),
      {
        path: options.path,
        source: options.source,
        destination: options.destination,
        operation: 'move',
        selections: [],
      },
    ],
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
    return validateTransaction(transaction, target);
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

/**
 * Discard a staged transaction without touching any managed clone or the
 * live target. Returns false when nothing was staged.
 */
export async function discardTransaction(
  paths: LayerdotsPaths,
  target: string,
): Promise<boolean> {
  const existing = await readTransaction(paths, target);
  if (existing === undefined) return false;
  await rm(transactionPath(paths), { force: true });
  return true;
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
  for (const [index, layer] of layers.entries()) {
    const active = required(options.stack.layers[index]);
    if (
      layer.root !== active.root ||
      layer.url !== active.url ||
      layer.branch !== active.branch ||
      layer.commit !== active.commit
    )
      throw new LayerdotsError(
        'Staged transaction does not match the active stack.',
        'TRANSACTION_INVALID',
      );
  }
  const next: ActiveStack['layers'][number][] = [];
  let parentCommit: string | undefined;
  try {
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
        await runGit(['rev-parse', 'HEAD'], {
          cwd: layer.root,
          env: options.env,
        })
      ).stdout.trim();
      parentCommit = commit;
      next.push({
        url: layer.url,
        root: layer.root,
        branch: layer.branch,
        commit,
      });
    }
  } catch (error) {
    // A layer that failed to commit (for example, due to unconfigured Git
    // identity) can be left with staged or materialized changes from
    // `materializeLayer`/`git add`. Restore every layer to its last commit so
    // a retry after fixing the underlying cause does not fail with
    // `REPOSITORY_DIRTY`. The staged transaction itself is left intact so the
    // same commit can be retried without re-staging.
    await rollbackLayers(layers, options.env);
    throw error;
  }
  await rm(transactionPath(options.paths), { force: true });
  return { version: 1, target: options.stack.target, layers: next };
}

async function rollbackLayers(
  layers: readonly StoredLayer[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const layer of layers) {
    try {
      await runGit(['reset', '--hard', 'HEAD'], { cwd: layer.root, env });
    } catch {
      // Best-effort recovery. The original commit failure is what surfaces
      // to the caller; a layer that cannot even be reset is reported the
      // next time a command touches it.
    }
  }
}

export async function pushStack(options: {
  readonly stack: ActiveStack;
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  for (const layer of options.stack.layers) {
    await requireClean(layer.root, options.env);
    await requirePushable(layer.root, layer.branch, options.env);
    await runGit(['push', 'origin', `HEAD:refs/heads/${layer.branch}`], {
      cwd: layer.root,
      env: options.env,
    });
  }
}

async function requirePushable(
  root: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runGit(['fetch', '--quiet', 'origin', branch], { cwd: root, env });
  const head = (
    await runGit(['rev-parse', 'HEAD'], { cwd: root, env })
  ).stdout.trim();
  const remote = (
    await runGit(['rev-parse', `refs/remotes/origin/${branch}`], {
      cwd: root,
      env,
    })
  ).stdout.trim();
  if (head === remote || (await isAncestor(root, remote, head, env))) return;
  throw new LayerdotsError(
    `Remote branch diverged for ${root}. Run layerdots sync first.`,
    'REMOTE_DIVERGED',
  );
}

async function isAncestor(
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

function validateTransaction(
  value: unknown,
  target: string,
): StagedTransaction {
  if (typeof value !== 'object' || value === null) invalidTransaction();
  const transaction = value as Record<string, unknown>;
  if (
    transaction.version !== 1 ||
    transaction.target !== resolve(target) ||
    !Array.isArray(transaction.layers)
  )
    invalidTransaction();
  for (const layer of transaction.layers) validateStoredLayer(layer);
  return transaction as unknown as StagedTransaction;
}

function validateStoredLayer(value: unknown): void {
  if (typeof value !== 'object' || value === null) invalidTransaction();
  const layer = value as Record<string, unknown>;
  for (const field of ['id', 'url', 'root', 'branch', 'commit'])
    if (typeof layer[field] !== 'string') invalidTransaction();
  const manifest = layer.manifest;
  if (typeof manifest !== 'object' || manifest === null) invalidTransaction();
  const record = manifest as Record<string, unknown>;
  if (record.version !== 1) invalidTransaction();
  if (record.parent !== undefined) {
    if (typeof record.parent !== 'object' || record.parent === null)
      invalidTransaction();
    const parent = record.parent as Record<string, unknown>;
    for (const field of ['url', 'branch', 'commit'])
      if (typeof parent[field] !== 'string') invalidTransaction();
  }
  if (!Array.isArray(layer.objects)) invalidTransaction();
  for (const object of layer.objects) {
    if (typeof object !== 'object' || object === null) invalidTransaction();
    const stored = object as Record<string, unknown>;
    if (typeof stored.path !== 'string') invalidTransaction();
    try {
      validateManagedPath(stored.path);
    } catch {
      invalidTransaction();
    }
    if (stored.kind === 'file') {
      if (
        typeof stored.content !== 'string' ||
        typeof stored.executable !== 'boolean'
      )
        invalidTransaction();
    } else if (stored.kind !== 'symlink' || typeof stored.target !== 'string') {
      invalidTransaction();
    }
  }
}

function invalidTransaction(): never {
  throw new LayerdotsError(
    'Staged transaction is invalid.',
    'TRANSACTION_INVALID',
  );
}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new LayerdotsError(
      'Staged transaction is invalid.',
      'TRANSACTION_INVALID',
    );
  return value;
}
