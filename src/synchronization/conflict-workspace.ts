import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { LayerdotsError } from '../domain/errors.js';
import { validateManagedPath } from '../repositories/path-validation.js';
import type { MergeConflict } from './merge.js';

export interface ConflictWorkspaceInput {
  readonly workspaceRoot: string;
  readonly transactionId: string;
  readonly conflicts: readonly MergeConflict[];
  readonly allowedSandboxRoot: string;
}

export async function writeConflictWorkspace(
  input: ConflictWorkspaceInput,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(input.transactionId))
    throw new LayerdotsError(
      'Invalid transaction id.',
      'invalid-transaction-id',
    );
  const sandbox = await existingDirectory(
    input.allowedSandboxRoot,
    'invalid-sandbox-root',
  );
  const root = resolve(input.workspaceRoot);
  await existingDirectory(root, 'invalid-workspace-root');
  const fromSandbox = relative(sandbox, root);
  if (
    !fromSandbox ||
    fromSandbox === '..' ||
    fromSandbox.startsWith(`..${sep}`) ||
    fromSandbox.startsWith(sep)
  )
    throw new LayerdotsError(
      'Workspace is outside the allowed sandbox.',
      'workspace-outside-sandbox',
    );
  await ensureNoSymlinkParents(sandbox, root);
  validateConflicts(input.conflicts);
  const workspace = join(root, input.transactionId);
  const staging = join(root, `.${input.transactionId}.staging`);
  let created = false;
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    created = true;
    await ensureDirectory(staging);
    for (const conflict of input.conflicts) {
      const directory = await createPath(staging, conflict.path);
      await writeObject(join(directory, 'base'), conflict.base);
      await writeObject(join(directory, 'ours'), conflict.ours);
      await writeObject(join(directory, 'theirs'), conflict.theirs);
      if (conflict.text)
        await writeFile(join(directory, 'conflict'), conflict.text, {
          flag:
            constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          mode: 0o600,
        });
    }
    await rename(staging, workspace);
  } catch (error) {
    if (created) await rm(staging, { recursive: true, force: true });
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      'Conflict workspace creation failed.',
      'conflict-workspace-create-failed',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  return workspace;
}

function validateConflicts(conflicts: readonly MergeConflict[]): void {
  const paths = conflicts.map((conflict) => validateManagedPath(conflict.path));
  const folded = new Set<string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (
      folded.has(key) ||
      paths.some(
        (other) => other !== path && other.toLowerCase().startsWith(`${key}/`),
      )
    )
      throw new LayerdotsError(
        `Conflict paths collide: ${path}`,
        'conflict-path-collision',
      );
    folded.add(key);
  }
}

async function ensureNoSymlinkParents(
  root: string,
  target: string,
): Promise<void> {
  let current = root;
  try {
    if ((await lstat(current)).isSymbolicLink())
      throw new LayerdotsError(
        'Workspace parent is a symlink.',
        'workspace-symlink-parent',
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const rest = relative(root, target).split(sep).filter(Boolean);
  for (const part of rest) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new LayerdotsError(
          'Workspace parent is a symlink.',
          'workspace-symlink-parent',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
async function existingDirectory(path: string, code: string): Promise<string> {
  try {
    const direct = await lstat(path);
    if (direct.isSymbolicLink())
      throw new LayerdotsError('Required directory is a symlink.', code);
    const canonical = await realpath(path);
    const stats = await lstat(canonical);
    if (!stats.isDirectory())
      throw new LayerdotsError('Required path is not a directory.', code);
    return canonical;
  } catch (error) {
    throw new LayerdotsError(`Required directory is invalid: ${path}`, code, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
async function ensureDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new LayerdotsError(
      'Workspace is not a real directory.',
      'conflict-workspace-create-failed',
    );
}
async function createPath(root: string, managedPath: string): Promise<string> {
  let current = root;
  for (const component of managedPath.split('/')) {
    current = join(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new LayerdotsError(
          'Cannot create conflict path.',
          'conflict-path-create-failed',
          { cause: error instanceof Error ? error : undefined },
        );
    }
    try {
      await ensureDirectory(current);
    } catch (error) {
      if (error instanceof LayerdotsError)
        throw new LayerdotsError(error.message, 'conflict-path-create-failed', {
          cause: error,
        });
      throw error;
    }
  }
  return current;
}
async function writeObject(
  path: string,
  object: MergeConflict['base'],
): Promise<void> {
  if (object === undefined) {
    await writeFile(path, 'absent', {
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode: 0o600,
    });
    return;
  }
  if (object.kind === 'symlink')
    await writeFile(path, `symlink\n${object.target}`, {
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode: 0o600,
    });
  else
    await writeFile(path, object.content, {
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode: 0o600,
    });
}
