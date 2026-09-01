import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import type { LayerSnapshot } from '../domain/objects.js';
import { readRepositoryTree } from './tree-reader.js';
import { validateRepository } from './repository-validator.js';

interface StatFingerprint {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

async function fingerprintPath(
  root: string,
  path: string,
): Promise<StatFingerprint[]> {
  const stats = await lstat(path);
  const fingerprints: StatFingerprint[] = [
    {
      path: relative(root, path).split(sep).join('/'),
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    },
  ];
  if (!stats.isDirectory()) return fingerprints;

  const entries = (await readdir(path)).sort();
  for (const entry of entries) {
    fingerprints.push(...(await fingerprintPath(root, join(path, entry))));
  }
  return fingerprints;
}

async function fingerprintRepository(root: string): Promise<string> {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new LayerdotsError(
      `Repository root is not a real directory: ${root}.`,
      'REPOSITORY_ROOT_INVALID',
    );
  }
  const manifest = await fingerprintPath(root, join(root, 'layerdots.json'));
  const home = await fingerprintPath(root, join(root, 'home'));
  return JSON.stringify(
    [...manifest, ...home].map((fingerprint) => ({
      ...fingerprint,
      mtimeMs: fingerprint.mtimeMs,
      ctimeMs: fingerprint.ctimeMs,
    })),
  );
}

export async function loadLayerSnapshot(
  repoRoot: string,
  id?: string,
): Promise<LayerSnapshot> {
  const root = resolve(repoRoot);
  let before: string;
  try {
    before = await fingerprintRepository(root);
  } catch (error) {
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      `Cannot fingerprint repository ${root} before loading.`,
      'REPOSITORY_UNREADABLE',
      { cause: error },
    );
  }

  const validation = await validateRepository(root);
  const objects = await readRepositoryTree(root);

  let after: string;
  try {
    after = await fingerprintRepository(root);
  } catch (error) {
    throw new LayerdotsError(
      `Cannot fingerprint repository ${root} after loading.`,
      'REPOSITORY_CHANGED',
      { cause: error },
    );
  }
  if (before !== after) {
    throw new LayerdotsError(
      `Repository changed while loading: ${root}.`,
      'REPOSITORY_CHANGED',
    );
  }

  return {
    id: id ?? root,
    root,
    manifest: validation.manifest,
    objects,
  };
}
