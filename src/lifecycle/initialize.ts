import { mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import { readManifest } from '../repositories/manifest-reader.js';
import { runGit } from '../repositories/git.js';
import type { ParentReference } from '../domain/manifest.js';
import type { LayerdotsPaths } from './paths.js';
import {
  writeActiveStack,
  type ActiveLayer,
  type ActiveStack,
} from './stack.js';

function clonePath(paths: LayerdotsPaths, url: string): string {
  const identity = createHash('sha256').update(url).digest('hex').slice(0, 24);
  return resolve(paths.clones, identity);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function requireCleanRepository(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const status = await runGit(['status', '--porcelain'], { cwd: root, env });
  if (status.stdout !== '') {
    throw new LayerdotsError(
      `Managed layer repository has uncommitted changes: ${root}.`,
      'REPOSITORY_DIRTY',
    );
  }
}

async function ensureClone(
  paths: LayerdotsPaths,
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const root = clonePath(paths, url);
  if (!(await exists(root))) {
    await mkdir(paths.clones, { recursive: true, mode: 0o700 });
    await runGit(['clone', '--quiet', '--origin', 'origin', url, root], {
      env,
    });
  }
  const remote = await runGit(['remote', 'get-url', 'origin'], {
    cwd: root,
    env,
  });
  if (remote.stdout.trim() !== url) {
    throw new LayerdotsError(
      `Managed clone ${root} belongs to ${remote.stdout.trim()}, not ${url}.`,
      'REPOSITORY_IDENTITY_MISMATCH',
    );
  }
  await requireCleanRepository(root, env);
  return root;
}

async function checkoutParent(
  root: string,
  parent: ParentReference,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runGit(['fetch', '--quiet', 'origin', parent.branch], {
    cwd: root,
    env,
  });
  await runGit(['cat-file', '-e', `${parent.commit}^{commit}`], {
    cwd: root,
    env,
  });
  await runGit(['checkout', '--quiet', '--detach', parent.commit], {
    cwd: root,
    env,
  });
  await requireCleanRepository(root, env);
}

export interface InitializeOptions {
  readonly overlayUrl: string;
  readonly target: string;
  readonly paths: LayerdotsPaths;
  readonly env: NodeJS.ProcessEnv;
}

export async function initializeStack(
  options: InitializeOptions,
): Promise<ActiveStack> {
  assertTargetOutsideLayerdotsPaths(options.target, options.paths);
  const layers: ActiveLayer[] = [];
  let url = options.overlayUrl;
  let expectedParent: ParentReference | undefined;
  const visited = new Set<string>();

  for (;;) {
    if (visited.has(url)) {
      throw new LayerdotsError(
        'Layer parent references form a cycle.',
        'LAYER_CYCLE',
      );
    }
    visited.add(url);
    const root = await ensureClone(options.paths, url, options.env);
    if (expectedParent !== undefined) {
      await checkoutParent(root, expectedParent, options.env);
    }
    const commit = (
      await runGit(['rev-parse', 'HEAD'], { cwd: root, env: options.env })
    ).stdout.trim();
    const branch =
      expectedParent?.branch ??
      (
        await runGit(['branch', '--show-current'], {
          cwd: root,
          env: options.env,
        })
      ).stdout.trim();
    if (branch === '') {
      throw new LayerdotsError(
        `Cannot determine the tracked branch for ${url}.`,
        'REPOSITORY_BRANCH_UNKNOWN',
      );
    }
    const manifest = await readManifest(root);
    layers.unshift({ url, root, branch, commit });
    if (manifest.parent === undefined) break;
    expectedParent = manifest.parent;
    url = manifest.parent.url;
  }

  const stack: ActiveStack = {
    version: 1,
    target: resolve(options.target),
    layers,
  };
  await writeActiveStack(options.paths, stack);
  return stack;
}

export function assertTargetOutsideLayerdotsPaths(
  target: string,
  paths: LayerdotsPaths,
): void {
  const resolvedTarget = resolve(target);
  for (const managedPath of [
    paths.config,
    paths.data,
    paths.state,
    paths.cache,
  ]) {
    const resolvedManagedPath = resolve(managedPath);
    if (pathsOverlap(resolvedTarget, resolvedManagedPath)) {
      throw new LayerdotsError(
        `Target ${resolvedTarget} overlaps Layerdots local data at ${resolvedManagedPath}.`,
        'TARGET_OVERLAPS_LAYERDOTS_DATA',
      );
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return (
    fromLeft === '' ||
    fromRight === '' ||
    (!fromLeft.startsWith(`..${sep}`) &&
      fromLeft !== '..' &&
      !fromLeft.startsWith(sep)) ||
    (!fromRight.startsWith(`..${sep}`) &&
      fromRight !== '..' &&
      !fromRight.startsWith(sep))
  );
}
