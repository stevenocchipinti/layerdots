import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { LayerdotsError } from '../domain/errors.js';
import type { ManagedObject, ManagedPath } from '../domain/objects.js';
import { equalManagedObjects } from '../domain/objects.js';
import { validateManagedPath } from '../repositories/path-validation.js';
import { readManagedPaths } from '../repositories/tree-reader.js';
import { writeConflictWorkspace } from '../synchronization/conflict-workspace.js';
import {
  mergeThreeWay,
  type ObjectSnapshot,
} from '../synchronization/merge.js';
import { captureJournal, rollbackJournal, type Journal } from './journal.js';
import {
  emptyAppliedState,
  readAppliedState,
  writeAppliedState,
} from './state.js';
import type {
  ApplyConflict,
  ApplyResult,
  ExistingObjectKind,
  TargetObjectKind,
} from './types.js';

export interface ApplyInput {
  readonly targetRoot: string;
  readonly stateDir: string;
  readonly targetId: string;
  readonly composed: ObjectSnapshot;
  readonly approvals: ReadonlySet<ManagedPath>;
  readonly workspaceRoot: string;
  readonly allowedSandboxRoot: string;
}

export interface CompositionPreview {
  readonly state: ReturnType<typeof emptyAppliedState>;
  readonly conflicts: readonly ApplyConflict[];
}

interface ChangePlan {
  readonly existing: ExistingObjectKind;
  readonly target: TargetObjectKind;
}

/**
 * Apply a newly composed stack to a target while merging any local edits,
 * journaling the writes, and rolling back on failure.
 *
 * The three-way merge base is the last applied state. Its `objects` map is
 * forwarded directly as the merge-base snapshot because paths recorded in its
 * `deleted` set are already absent from that map, so the merge represents them
 * as absent, which is exactly the intent: a previously deleted path offers no
 * content for the merge to preserve.
 */
export async function applyComposition(
  input: ApplyInput,
): Promise<ApplyResult> {
  const {
    targetRoot,
    stateDir,
    targetId,
    composed,
    approvals,
    workspaceRoot,
    allowedSandboxRoot,
  } = input;

  for (const path of composed.objects.keys()) validateManagedPath(path);
  const state =
    (await readAppliedState(stateDir, targetId)) ?? emptyAppliedState();
  const affectedPaths = [
    ...new Set([...state.objects.keys(), ...composed.objects.keys()]),
  ].sort();
  assertNoCaseCollisions(affectedPaths);

  const ours = await readManagedPaths(targetRoot, affectedPaths);
  const merged = mergeThreeWay(
    { objects: state.objects },
    { objects: ours },
    { objects: composed.objects },
  );

  if (merged.conflicts.length > 0) {
    const transactionId = `${targetId}-${String(Date.now())}`;
    const workspace = await writeConflictWorkspace({
      workspaceRoot,
      transactionId,
      conflicts: merged.conflicts,
      allowedSandboxRoot,
    });
    const conflicts: ApplyConflict[] = merged.conflicts.map((conflict) => ({
      path: conflict.path,
      workspace,
    }));
    return { applied: false, written: [], state, conflicts };
  }

  const writes = new Map<ManagedPath, ManagedObject>();
  const deletes = new Set<ManagedPath>();
  for (const path of affectedPaths) {
    const target = merged.objects.get(path);
    const existing = ours.get(path);
    if (target === undefined) {
      deletes.add(path);
    } else if (
      existing === undefined ||
      !equalManagedObjects(target, existing)
    ) {
      writes.set(path, target);
    }
  }

  const home = join(targetRoot, 'home');
  const plan = new Map<ManagedPath, ChangePlan>();
  for (const path of [...new Set([...writes.keys(), ...deletes])].sort()) {
    const existing = await existingKind(home, path);
    if (writes.has(path)) {
      const object = writes.get(path);
      if (object === undefined) continue;
      const target: TargetObjectKind =
        object.kind === 'symlink' ? 'symlink' : 'file';
      await validateTypeReplacement(home, path, existing, target, approvals);
      plan.set(path, { existing, target });
    } else {
      plan.set(path, { existing, target: 'delete' });
    }
  }

  let journal: Journal;
  try {
    journal = await captureJournal(targetRoot, affectedPaths);
  } catch (error) {
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError('Apply journal capture failed.', 'apply-failed', {
      cause: error instanceof Error ? error : undefined,
    });
  }

  const changed: ManagedPath[] = [];
  try {
    for (const path of writes.keys()) {
      const object = writes.get(path);
      const change = plan.get(path);
      if (object === undefined || change === undefined) continue;
      await writeTarget(home, path, object, change.existing);
      changed.push(path);
    }
    for (const path of deletes) {
      const change = plan.get(path);
      if (change === undefined) continue;
      await deleteTarget(home, path, change.existing);
      await pruneEmptyParents(home, path, journal.existingDirs);
      changed.push(path);
    }

    const newState = {
      objects: new Map(merged.objects),
      deleted: computeDeleted(
        state.objects,
        ours,
        merged.objects,
        affectedPaths,
      ),
    };
    await writeAppliedState(stateDir, targetId, newState);

    return {
      applied: true,
      written: [...changed].sort(),
      state: newState,
      conflicts: [],
    };
  } catch (error) {
    await rollbackJournal(targetRoot, journal).catch(() => undefined);
    throw new LayerdotsError(
      `Apply failed: ${error instanceof Error ? error.message : String(error)}`,
      'apply-failed',
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

/** Validate the same three-way target transition used by apply without writing live files. */
export async function previewComposition(
  input: ApplyInput,
): Promise<CompositionPreview> {
  const {
    stateDir,
    targetId,
    targetRoot,
    composed,
    workspaceRoot,
    allowedSandboxRoot,
  } = input;
  for (const path of composed.objects.keys()) validateManagedPath(path);
  const state =
    (await readAppliedState(stateDir, targetId)) ?? emptyAppliedState();
  const affectedPaths = [
    ...new Set([...state.objects.keys(), ...composed.objects.keys()]),
  ].sort();
  assertNoCaseCollisions(affectedPaths);
  const ours = await readManagedPaths(targetRoot, affectedPaths);
  const merged = mergeThreeWay(
    { objects: state.objects },
    { objects: ours },
    { objects: composed.objects },
  );
  if (merged.conflicts.length === 0) return { state, conflicts: [] };
  const workspace = await writeConflictWorkspace({
    workspaceRoot,
    transactionId: `${targetId}-switch-${String(Date.now())}`,
    conflicts: merged.conflicts,
    allowedSandboxRoot,
  });
  return {
    state,
    conflicts: merged.conflicts.map((conflict) => ({
      path: conflict.path,
      workspace,
    })),
  };
}

function assertNoCaseCollisions(paths: readonly ManagedPath[]): void {
  const folded = new Map<string, ManagedPath>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const existing = folded.get(key);
    if (existing !== undefined && existing !== path) {
      throw new LayerdotsError(
        `Managed paths collide by case: ${existing} and ${path}`,
        'path-collision',
      );
    }
    folded.set(key, path);
  }
}

function computeDeleted(
  baseObjects: ReadonlyMap<ManagedPath, ManagedObject>,
  ours: ReadonlyMap<ManagedPath, ManagedObject>,
  mergedObjects: ReadonlyMap<ManagedPath, ManagedObject>,
  affectedPaths: readonly ManagedPath[],
): ReadonlySet<ManagedPath> {
  const deleted = new Set<ManagedPath>();
  for (const path of affectedPaths) {
    if (mergedObjects.has(path)) continue;
    if (baseObjects.has(path) || ours.has(path)) deleted.add(path);
  }
  return new Set([...deleted].sort());
}

async function existingKind(
  home: string,
  path: ManagedPath,
): Promise<ExistingObjectKind> {
  const absolute = join(home, ...path.split('/'));
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw new LayerdotsError(
      'Cannot inspect managed target path.',
      'apply-validation-failed',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'dir';
  throw new LayerdotsError(
    `Unsupported managed target object: ${path}`,
    'unsupported-object',
  );
}

async function validateTypeReplacement(
  home: string,
  path: ManagedPath,
  existing: ExistingObjectKind,
  target: TargetObjectKind,
  approvals: ReadonlySet<ManagedPath>,
): Promise<void> {
  if (existing === 'absent') return;
  const sameKind =
    (existing === 'file' && target === 'file') ||
    (existing === 'symlink' && target === 'symlink');
  if (sameKind) return;
  if (existing === 'dir' && (await directoryEmpty(home, path))) return;
  if (approvals.has(path)) return;
  throw new LayerdotsError(
    `Filesystem type replacement requires explicit approval: ${path}`,
    'type-replacement-requires-approval',
  );
}

async function directoryEmpty(
  home: string,
  path: ManagedPath,
): Promise<boolean> {
  const entries = await readdir(join(home, ...path.split('/')));
  return entries.length === 0;
}

async function writeTarget(
  home: string,
  path: ManagedPath,
  object: ManagedObject,
  existing: ExistingObjectKind,
): Promise<void> {
  const components = path.split('/');
  const absolute = join(home, ...components);
  if (existing === 'dir') {
    await rm(absolute, { recursive: true, force: true });
  } else if (existing === 'file' || existing === 'symlink') {
    await unlink(absolute);
  }
  const parentDir = join(home, ...components.slice(0, -1));
  await mkdir(parentDir, { recursive: true });
  if (object.kind === 'symlink') {
    await symlink(object.target, absolute);
    return;
  }
  const handle = await open(
    absolute,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.write(object.content, 0, object.content.length, 0);
  } finally {
    await handle.close();
  }
  if (object.executable) await chmod(absolute, 0o755);
  else await chmod(absolute, 0o644);
}

async function deleteTarget(
  home: string,
  path: ManagedPath,
  existing: ExistingObjectKind,
): Promise<void> {
  const absolute = join(home, ...path.split('/'));
  if (existing === 'file' || existing === 'symlink') {
    await unlink(absolute);
  } else if (existing === 'dir') {
    await rm(absolute, { recursive: true, force: true });
  }
}

async function pruneEmptyParents(
  home: string,
  path: ManagedPath,
  existingDirs: ReadonlySet<string>,
): Promise<void> {
  const components = path.split('/');
  for (let i = components.length - 2; i >= 0; i -= 1) {
    const dirPath = components.slice(0, i + 1).join('/');
    if (existingDirs.has(dirPath)) break;
    const dir = join(home, ...components.slice(0, i + 1));
    let stats;
    try {
      stats = await lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) break;
    const entries = await readdir(dir);
    if (entries.length > 0) break;
    await rm(dir, { recursive: true, force: true });
  }
}
