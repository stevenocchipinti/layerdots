import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import {
  MANIFEST_VERSION,
  type LayerManifestV1,
  type ParentReference,
} from '../domain/manifest.js';

const MANIFEST_NAME = 'layerdots.json';

function fail(code: string, message: string, cause?: unknown): never {
  throw new LayerdotsError(
    message,
    code,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(
        'MANIFEST_UNKNOWN_KEY',
        `${label} contains unsupported key ${JSON.stringify(key)}; version 1 allows only ${allowed.join(', ')}.`,
      );
    }
  }
}

function parseManifest(value: unknown): LayerManifestV1 {
  if (!isRecord(value)) {
    fail('MANIFEST_INVALID', 'layerdots.json must contain a JSON object.');
  }
  requireKeys(value, ['version', 'parent'], 'layerdots.json');
  if (value.version !== MANIFEST_VERSION) {
    fail(
      'MANIFEST_VERSION_UNSUPPORTED',
      `layerdots.json must declare version ${String(MANIFEST_VERSION)}.`,
    );
  }

  if (value.parent === undefined) {
    return { version: MANIFEST_VERSION };
  }
  if (!isRecord(value.parent)) {
    fail(
      'MANIFEST_PARENT_INVALID',
      'layerdots.json parent must be an object when present.',
    );
  }
  requireKeys(
    value.parent,
    ['url', 'branch', 'commit'],
    'layerdots.json parent',
  );
  const { url, branch, commit } = value.parent;
  if (typeof url !== 'string' || url.trim() === '') {
    fail(
      'MANIFEST_PARENT_URL_INVALID',
      'layerdots.json parent.url must be a nonempty string.',
    );
  }
  if (typeof branch !== 'string' || branch.trim() === '') {
    fail(
      'MANIFEST_PARENT_BRANCH_INVALID',
      'layerdots.json parent.branch must be a nonempty string.',
    );
  }
  if (
    typeof commit !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)
  ) {
    fail(
      'MANIFEST_PARENT_COMMIT_INVALID',
      'layerdots.json parent.commit must be a full 40-character SHA-1 or 64-character SHA-256 Git object ID.',
    );
  }

  const parent: ParentReference = { url, branch, commit };
  return { version: MANIFEST_VERSION, parent };
}

export async function readManifest(repoRoot: string): Promise<LayerManifestV1> {
  const root = resolve(repoRoot);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    fail(
      'REPOSITORY_ROOT_UNREADABLE',
      `Cannot inspect repository root ${root}.`,
      error,
    );
  }
  if (!rootStat.isDirectory()) {
    fail(
      'REPOSITORY_ROOT_INVALID',
      `Repository root ${root} is not a directory.`,
    );
  }

  const manifestPath = resolve(root, MANIFEST_NAME);
  let manifestStat;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (error) {
    fail(
      'MANIFEST_UNREADABLE',
      `Cannot read ${MANIFEST_NAME} in repository root ${root}.`,
      error,
    );
  }
  if (manifestStat.isSymbolicLink()) {
    fail('MANIFEST_SYMLINK', `${MANIFEST_NAME} must not be a symbolic link.`);
  }
  if (!manifestStat.isFile()) {
    fail('MANIFEST_INVALID', `${MANIFEST_NAME} must be a regular file.`);
  }

  let text: string;
  try {
    const handle = await open(
      manifestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        fail('MANIFEST_INVALID', `${MANIFEST_NAME} must be a regular file.`);
      }
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof LayerdotsError) throw error;
    fail('MANIFEST_UNREADABLE', `Cannot read ${manifestPath}.`, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    fail('MANIFEST_INVALID_JSON', `${manifestPath} is not valid JSON.`, error);
  }
  return parseManifest(parsed);
}
