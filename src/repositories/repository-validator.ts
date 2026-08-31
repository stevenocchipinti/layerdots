import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import {
  layerRole,
  type LayerManifestV1,
  type LayerRole,
} from '../domain/manifest.js';
import { readManifest } from './manifest-reader.js';
import { readRepositoryTree } from './tree-reader.js';

export interface RepositoryValidation {
  readonly root: string;
  readonly manifest: LayerManifestV1;
  readonly role: LayerRole;
  readonly representations: readonly string[];
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new LayerdotsError(
    message,
    code,
    cause === undefined ? undefined : { cause },
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
  );
}

async function collectEntries(home: string, current = home): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current);
  } catch (error) {
    fail(
      'HOME_UNREADABLE',
      `Cannot read repository home tree ${current}.`,
      error,
    );
  }
  const paths: string[] = [];
  for (const name of entries) {
    const path = join(current, name);
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      fail(
        'HOME_ENTRY_UNREADABLE',
        `Cannot inspect home entry ${path}.`,
        error,
      );
    }
    if (stats.isDirectory()) {
      paths.push(...(await collectEntries(home, path)));
    } else if (stats.isSymbolicLink() || stats.isFile()) {
      paths.push(relative(home, path).split(sep).join('/'));
    } else {
      fail(
        'HOME_ENTRY_UNSUPPORTED',
        `Home entry ${path} is not a regular file, directory, or symbolic link.`,
      );
    }
  }
  return paths;
}

function effectivePath(
  path: string,
  role: LayerRole,
): {
  path: string;
  kind: 'plain' | 'patch' | 'delete';
} {
  if (role === 'base') return { path, kind: 'plain' };
  if (path.endsWith('.patch'))
    return { path: path.slice(0, -6), kind: 'patch' };
  if (path.endsWith('.delete'))
    return { path: path.slice(0, -7), kind: 'delete' };
  return { path, kind: 'plain' };
}

export async function validateRepository(
  repoRoot: string,
): Promise<RepositoryValidation> {
  const root = resolve(repoRoot);
  const manifest = await readManifest(root);
  const role = layerRole(manifest);
  const home = resolve(root, 'home');
  if (!isWithin(root, home))
    fail(
      'HOME_PATH_INVALID',
      'Repository home path escapes the repository root.',
    );

  let homeStats;
  try {
    homeStats = await lstat(home);
  } catch (error) {
    fail(
      'HOME_MISSING',
      `Repository must contain a home directory at ${home}.`,
      error,
    );
  }
  if (homeStats.isSymbolicLink())
    fail('HOME_SYMLINK', 'Repository home must not be a symbolic link.');
  if (!homeStats.isDirectory())
    fail('HOME_INVALID', 'Repository home must be a directory.');

  await readRepositoryTree(root);
  const entries = await collectEntries(home);
  const representations = entries.map((path) => effectivePath(path, role));
  for (const [index, representation] of representations.entries()) {
    const source = entries[index] as string;
    if (representation.path === '')
      fail('HOME_PATH_INVALID', `${source} does not name an effective path.`);
    if (
      role === 'overlay' &&
      (representation.path.endsWith('.patch') ||
        representation.path.endsWith('.delete'))
    ) {
      fail(
        'OVERLAY_RESERVED_PATH',
        `${source} represents a literal path ending in a reserved .patch or .delete suffix.`,
      );
    }
    if (representation.kind === 'delete') {
      let stats;
      try {
        stats = await lstat(join(home, source));
      } catch (error) {
        fail(
          'HOME_ENTRY_UNREADABLE',
          `Cannot inspect tombstone ${source}.`,
          error,
        );
      }
      if (!stats.isFile() || stats.size !== 0)
        fail('TOMBSTONE_INVALID', `${source} must be an empty regular file.`);
    }
  }

  const sorted = representations.map((item) => item.path).sort();
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as string;
    const current = sorted[index] as string;
    if (current === previous) {
      fail(
        'HOME_PATH_CONFLICT',
        `Multiple representations define the effective path ${current}.`,
      );
    }
    if (current.startsWith(`${previous}/`)) {
      fail(
        'HOME_PATH_COLLISION',
        `Home representations ${previous} and ${current} collide as nested paths.`,
      );
    }
  }
  return { root, manifest, role, representations: sorted };
}

export const validateRepositoryFormat = validateRepository;
