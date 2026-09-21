import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import type { LayerdotsPaths } from './paths.js';

export interface ActiveLayer {
  readonly url: string;
  readonly root: string;
  readonly commit: string;
}

export interface ActiveStack {
  readonly version: 1;
  readonly target: string;
  readonly layers: readonly ActiveLayer[];
}

const STACK_FILE = 'active-stack.json';

function stackPath(paths: LayerdotsPaths): string {
  return resolve(paths.config, STACK_FILE);
}

function parseStack(value: unknown): ActiveStack {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).target !== 'string' ||
    !Array.isArray((value as Record<string, unknown>).layers)
  ) {
    throw new LayerdotsError(
      'Active stack configuration is invalid.',
      'STACK_INVALID',
    );
  }
  const layers = (value as { layers: unknown[] }).layers;
  if (layers.length === 0) {
    throw new LayerdotsError('Active stack has no layers.', 'STACK_INVALID');
  }
  for (const layer of layers) {
    if (
      typeof layer !== 'object' ||
      layer === null ||
      typeof (layer as Record<string, unknown>).url !== 'string' ||
      typeof (layer as Record<string, unknown>).root !== 'string' ||
      typeof (layer as Record<string, unknown>).commit !== 'string'
    ) {
      throw new LayerdotsError(
        'Active stack layer is invalid.',
        'STACK_INVALID',
      );
    }
  }
  return value as ActiveStack;
}

export async function writeActiveStack(
  paths: LayerdotsPaths,
  stack: ActiveStack,
): Promise<void> {
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  const destination = stackPath(paths);
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stack, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, destination);
}

export async function readActiveStack(
  paths: LayerdotsPaths,
  target: string,
): Promise<ActiveStack> {
  let text: string;
  try {
    text = await readFile(stackPath(paths), 'utf8');
  } catch (error) {
    throw new LayerdotsError(
      'No active stack is configured. Run layerdots init <overlay-url> --target <directory>.',
      'STACK_NOT_CONFIGURED',
      { cause: error },
    );
  }
  let stack: ActiveStack;
  try {
    stack = parseStack(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(
      'Active stack configuration is invalid.',
      'STACK_INVALID',
      {
        cause: error,
      },
    );
  }
  if (stack.target !== resolve(target)) {
    throw new LayerdotsError(
      `No active stack is configured for target ${resolve(target)}.`,
      'STACK_TARGET_NOT_CONFIGURED',
    );
  }
  return stack;
}
