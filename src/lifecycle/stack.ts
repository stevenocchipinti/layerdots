import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import type { LayerdotsPaths } from './paths.js';

export interface ActiveLayer {
  readonly url: string;
  readonly root: string;
  readonly branch: string;
  readonly commit: string;
}

export interface ActiveStack {
  readonly version: 1;
  readonly target: string;
  readonly layers: readonly ActiveLayer[];
}

export function targetStateId(target: string): string {
  return createHash('sha256')
    .update(resolve(target))
    .digest('hex')
    .slice(0, 24);
}

const STACK_FILE = 'active-stack.json';
const STACKS_FILE = 'active-stacks.json';

function stackPath(paths: LayerdotsPaths): string {
  return resolve(paths.config, STACK_FILE);
}

function stacksPath(paths: LayerdotsPaths): string {
  return resolve(paths.config, STACKS_FILE);
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
      typeof (layer as Record<string, unknown>).branch !== 'string' ||
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
  const stacks = await readStacks(paths);
  stacks.set(stack.target, stack);
  const registry = stacksPath(paths);
  const registryTemporary = `${registry}.${String(process.pid)}.tmp`;
  await writeFile(
    registryTemporary,
    `${JSON.stringify({ version: 1, stacks: [...stacks.values()] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(registryTemporary, registry);
}

export async function readActiveStack(
  paths: LayerdotsPaths,
  target: string,
): Promise<ActiveStack> {
  const stacks = await readStacks(paths);
  const resolvedTarget = resolve(target);
  const stack = stacks.get(resolvedTarget);
  if (stack === undefined) {
    throw new LayerdotsError(
      stacks.size === 0
        ? 'No active stack is configured. Run layerdots init <overlay-url> --target <directory>.'
        : `No active stack is configured for target ${resolvedTarget}.`,
      stacks.size === 0
        ? 'STACK_NOT_CONFIGURED'
        : 'STACK_TARGET_NOT_CONFIGURED',
    );
  }
  return stack;
}

export async function hasActiveStack(
  paths: LayerdotsPaths,
  target: string,
): Promise<boolean> {
  return (await readStacks(paths)).has(resolve(target));
}

async function readStacks(
  paths: LayerdotsPaths,
): Promise<Map<string, ActiveStack>> {
  let text: string;
  try {
    text = await readFile(stacksPath(paths), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const stack = parseStack(
          JSON.parse(await readFile(stackPath(paths), 'utf8')) as unknown,
        );
        return new Map([[stack.target, stack]]);
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT')
          return new Map();
        if (legacyError instanceof LayerdotsError) throw legacyError;
        throw new LayerdotsError(
          'Active stack configuration is invalid.',
          'STACK_INVALID',
          { cause: legacyError },
        );
      }
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>).version !== 1 ||
      !Array.isArray((parsed as Record<string, unknown>).stacks)
    ) {
      throw new LayerdotsError(
        'Active stack configuration is invalid.',
        'STACK_INVALID',
      );
    }
    const stacks = new Map<string, ActiveStack>();
    for (const value of (parsed as { stacks: unknown[] }).stacks) {
      const stack = parseStack(value);
      if (stacks.has(stack.target))
        throw new LayerdotsError(
          'Active stack configuration is invalid.',
          'STACK_INVALID',
        );
      stacks.set(stack.target, stack);
    }
    return stacks;
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
}
