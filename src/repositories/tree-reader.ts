import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import type { ManagedObject, ManagedPath } from '../domain/objects.js';
import { validateManagedPath } from './path-validation.js';

export type FileContentKind = 'text' | 'binary';

/** Classify bytes without decoding or changing their representation. */
export function classifyFileContent(content: Uint8Array): FileContentKind {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(content);
    return 'text';
  } catch {
    return 'binary';
  }
}

/** Read the literal managed objects below a repository's home directory. */
export async function readRepositoryTree(
  repositoryRoot: string,
): Promise<ReadonlyMap<ManagedPath, ManagedObject>> {
  const home = join(repositoryRoot, 'home');
  const homeStats = await lstat(home).catch((error: unknown) => {
    throw repositoryError(`Cannot read repository home tree: ${home}`, error);
  });
  if (!homeStats.isDirectory()) {
    throw new LayerdotsError(
      `Repository home is not a directory: ${home}`,
      'invalid-home-tree',
    );
  }

  const objects = new Map<ManagedPath, ManagedObject>();
  const foldedPaths = new Map<string, ManagedPath>();

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        throw repositoryError(
          `Cannot read repository directory: ${directory}`,
          error,
        );
      },
    );
    if (entries.length === 0 && prefix.length !== 0) {
      throw new LayerdotsError(
        `Empty directories are unsupported: ${prefix}`,
        'unsupported-object',
      );
    }

    for (const entry of entries) {
      const path = validateManagedPath(
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`,
      );
      const folded = path.toLowerCase();
      const existing = foldedPaths.get(folded);
      if (existing !== undefined && existing !== path) {
        throw new LayerdotsError(
          `Managed paths collide by case: ${existing} and ${path}`,
          'path-collision',
        );
      }
      foldedPaths.set(folded, path);

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, path);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const target = await readlink(absolutePath, 'utf8').catch(
          (error: unknown) => {
            throw repositoryError(
              `Cannot read symbolic link: ${absolutePath}`,
              error,
            );
          },
        );
        objects.set(path, { kind: 'symlink', target });
        continue;
      }

      if (!entry.isFile()) {
        throw new LayerdotsError(
          `Unsupported filesystem object: ${path}`,
          'unsupported-object',
        );
      }

      const handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((error: unknown) => {
        throw repositoryError(`Cannot open file: ${absolutePath}`, error);
      });
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.nlink > 1) {
          throw new LayerdotsError(
            `Unsupported filesystem object: ${path}`,
            'unsupported-object',
          );
        }
        const content = await handle.readFile();
        objects.set(path, {
          kind: 'file',
          content,
          executable: (stats.mode & 0o111) !== 0,
        });
      } finally {
        await handle.close();
      }
    }
  }

  await visit(home, '');
  return objects;
}

/** Read only explicitly managed paths from a target-shaped home tree. */
export async function readManagedPaths(
  targetRoot: string,
  paths: Iterable<ManagedPath>,
): Promise<ReadonlyMap<ManagedPath, ManagedObject>> {
  const home = join(targetRoot, 'home');
  const homeStats = await lstat(home).catch((error: unknown) => {
    throw repositoryError(`Cannot read target home tree: ${home}`, error);
  });
  if (!homeStats.isDirectory() || homeStats.isSymbolicLink()) {
    throw new LayerdotsError(
      `Target home is not a real directory: ${home}`,
      'invalid-home-tree',
    );
  }

  const objects = new Map<ManagedPath, ManagedObject>();
  for (const candidate of [...paths].sort()) {
    const path = validateManagedPath(candidate);
    const components = path.split('/');
    let current = home;
    let missing = false;
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          missing = true;
          break;
        }
        throw repositoryError(
          `Cannot inspect managed target path: ${current}`,
          error,
        );
      }
      const leaf = index === components.length - 1;
      if (!leaf) {
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new LayerdotsError(
            `Managed target parent is not a real directory: ${current}`,
            'target-symlink-parent',
          );
        }
        continue;
      }
      if (stats.isSymbolicLink()) {
        objects.set(path, {
          kind: 'symlink',
          target: await readlink(current, 'utf8'),
        });
      } else if (stats.isFile()) {
        const handle = await open(
          current,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink > 1) {
            throw new LayerdotsError(
              `Unsupported managed target object: ${path}`,
              'unsupported-object',
            );
          }
          objects.set(path, {
            kind: 'file',
            content: await handle.readFile(),
            executable: (opened.mode & 0o111) !== 0,
          });
        } finally {
          await handle.close();
        }
      } else {
        throw new LayerdotsError(
          `Unsupported managed target object: ${path}`,
          'unsupported-object',
        );
      }
    }
    if (missing) continue;
  }
  return objects;
}

function repositoryError(message: string, cause: unknown): LayerdotsError {
  return new LayerdotsError(message, 'repository-read-failed', {
    cause: cause instanceof Error ? cause : undefined,
  });
}

export { validateManagedPath } from './path-validation.js';
