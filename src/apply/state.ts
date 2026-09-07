import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedObject, ManagedPath } from '../domain/objects.js';
import { LayerdotsError } from '../domain/errors.js';

import type { AppliedState } from './types.js';

const STATE_VERSION = 1;

/** Return a new empty applied state (no objects and nothing deleted). */
export function emptyAppliedState(): AppliedState {
  return { objects: new Map(), deleted: new Set() };
}

/**
 * Produce a deterministic JSON string describing an applied state. Objects and
 * deleted paths are emitted in sorted order so equivalent states always
 * serialize identically and file writes are byte-stable.
 */
export function serializeAppliedState(state: AppliedState): string {
  const objects: Array<Record<string, unknown>> = [];
  for (const path of [...state.objects.keys()].sort()) {
    const object = state.objects.get(path);
    if (object === undefined) continue;
    const entry: Record<string, unknown> = { path, kind: object.kind };
    if (object.kind === 'file') {
      entry.content = Buffer.from(object.content).toString('base64');
      entry.executable = object.executable;
    } else {
      entry.target = object.target;
    }
    objects.push(entry);
  }
  return JSON.stringify(
    {
      version: STATE_VERSION,
      objects,
      deleted: [...state.deleted].sort(),
    },
    null,
    2,
  );
}

/**
 * Parse the JSON produced by `serializeAppliedState`. Throws
 * `LayerdotsError` with code `invalid-applied-state` on any malformed or
 * unknown shape rather than returning a partial state.
 */
export function parseAppliedState(json: string): AppliedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw invalidState('Applied state is not valid JSON.', error);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidState('Applied state must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== STATE_VERSION) {
    throw invalidState(
      `Unsupported applied state version: ${String(record.version)}`,
    );
  }
  const knownKeys = new Set(['version', 'objects', 'deleted']);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      throw invalidState(`Unknown applied state key: ${key}`);
    }
  }

  const objects = new Map<ManagedPath, ManagedObject>();
  if (!Array.isArray(record.objects)) {
    throw invalidState('Applied state objects must be an array.');
  }
  for (const rawEntry of record.objects) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw invalidState('Applied state object entry must be an object.');
    }
    const entry = rawEntry as Record<string, unknown>;
    const fileKeys = new Set(['path', 'kind', 'content', 'executable']);
    const symlinkKeys = new Set(['path', 'kind', 'target']);
    const entryKeys = new Set([...fileKeys, ...symlinkKeys]);
    for (const key of Object.keys(entry)) {
      if (!entryKeys.has(key)) {
        throw invalidState(`Unknown applied state object key: ${key}`);
      }
    }
    const { path, kind } = entry;
    if (typeof path !== 'string') {
      throw invalidState('Applied state object path must be a string.');
    }
    if (path.length === 0) {
      throw invalidState('Applied state object path must not be empty.');
    }
    let object: ManagedObject;
    if (kind === 'file') {
      for (const key of Object.keys(entry)) {
        if (!fileKeys.has(key)) {
          throw invalidState(`Invalid key for file object: ${key}`);
        }
      }
      const { content, executable } = entry;
      if (typeof content !== 'string') {
        throw invalidState('Applied state file content must be a string.');
      }
      if (typeof executable !== 'boolean') {
        throw invalidState('Applied state file executable must be a boolean.');
      }
      const bytes = decodeBase64(content, 'Applied state file content');
      object = { kind: 'file', content: bytes, executable };
    } else if (kind === 'symlink') {
      for (const key of Object.keys(entry)) {
        if (!symlinkKeys.has(key)) {
          throw invalidState(`Invalid key for symlink object: ${key}`);
        }
      }
      if (typeof entry.target !== 'string') {
        throw invalidState('Applied state symlink target must be a string.');
      }
      object = { kind: 'symlink', target: entry.target };
    } else {
      throw invalidState(`Unknown applied state object kind: ${String(kind)}`);
    }
    objects.set(path, object);
  }

  const deleted = new Set<ManagedPath>();
  if (!Array.isArray(record.deleted)) {
    throw invalidState('Applied state deleted must be an array.');
  }
  for (const path of record.deleted) {
    if (typeof path !== 'string') {
      throw invalidState('Applied state deleted path must be a string.');
    }
    deleted.add(path);
  }

  return { objects, deleted };
}

/**
 * Read a previously written applied state for a target id. Returns
 * `undefined` when no state file exists, and throws a `LayerdotsError` if the
 * file cannot be read (code `applied-state-read-failed`) or parsed (code
 * `invalid-applied-state`).
 */
export async function readAppliedState(
  stateDir: string,
  targetId: string,
): Promise<AppliedState | undefined> {
  validateTargetId(targetId);
  const dir = await stateDirectoryForRead(stateDir);
  if (dir === undefined) return undefined;
  const filePath = join(dir, `${targetId}.json`);
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new LayerdotsError(
      `Cannot inspect applied state file: ${filePath}`,
      'applied-state-read-failed',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (stats.isSymbolicLink()) {
    throw new LayerdotsError(
      `Applied state file is a symlink: ${filePath}`,
      'applied-state-symlink',
    );
  }
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    throw new LayerdotsError(
      `Cannot open applied state file: ${filePath}`,
      'applied-state-read-failed',
      { cause: error instanceof Error ? error : undefined },
    );
  });
  let raw: Buffer;
  try {
    raw = await handle.readFile();
  } finally {
    await handle.close();
  }
  const text = raw.toString('utf8');
  try {
    return parseAppliedState(text);
  } catch (error) {
    if (error instanceof LayerdotsError) throw error;
    throw invalidState('Applied state file is malformed.');
  }
}

/**
 * Atomically write an applied state for a target id. The parent directory is
 * created if missing. The data is written to a staging file and renamed over
 * the target. The initial open uses O_EXCL and O_NOFOLLOW so no symlink at the
 * target path or its parent can be followed. On failure the staging file is
 * removed.
 */
export async function writeAppliedState(
  stateDir: string,
  targetId: string,
  state: AppliedState,
): Promise<void> {
  validateTargetId(targetId);
  const dir = await ensuredStateDirectory(
    stateDir,
    'applied-state-write-failed',
  );
  const finalPath = join(dir, `${targetId}.json`);
  const stagingPath = join(dir, `.${targetId}.tmp`);
  let created = false;
  try {
    await writeFile(stagingPath, serializeAppliedState(state), {
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode: 0o600,
    });
    created = true;
    await rename(stagingPath, finalPath);
  } catch (error) {
    if (created) await rm(stagingPath, { force: true }).catch(() => undefined);
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      `Cannot write applied state: ${finalPath}`,
      'applied-state-write-failed',
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

async function stateDirectoryForRead(
  stateDir: string,
): Promise<string | undefined> {
  try {
    const stats = await lstat(stateDir);
    if (stats.isSymbolicLink()) {
      throw new LayerdotsError(
        `Applied state directory is a symlink: ${stateDir}`,
        'applied-state-symlink',
      );
    }
    if (!stats.isDirectory()) {
      throw new LayerdotsError(
        `Applied state directory is not a real directory: ${stateDir}`,
        'applied-state-read-failed',
      );
    }
    return stateDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      `Cannot access applied state directory: ${stateDir}`,
      'applied-state-read-failed',
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

async function ensuredStateDirectory(
  stateDir: string,
  code: string,
): Promise<string> {
  try {
    const stats = await lstat(stateDir);
    if (stats.isSymbolicLink()) {
      throw new LayerdotsError(
        `Applied state directory is a symlink: ${stateDir}`,
        'applied-state-symlink',
      );
    }
    if (!stats.isDirectory()) {
      throw new LayerdotsError(
        `Applied state directory is not a real directory: ${stateDir}`,
        code,
      );
    }
    return stateDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      return ensuredStateDirectory(stateDir, code);
    }
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      `Cannot access applied state directory: ${stateDir}`,
      code,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function validateTargetId(targetId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(targetId)) {
    throw new LayerdotsError(
      `Invalid target id: ${targetId}`,
      'invalid-target-id',
    );
  }
}

function invalidState(message: string, cause?: unknown): LayerdotsError {
  return new LayerdotsError(message, 'invalid-applied-state', {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function decodeBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw invalidState(`${label} is not valid base64.`);
  }
  return bytes;
}

export type { AppliedState };
