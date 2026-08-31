import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { runGit } from '../../src/repositories/git.js';
import {
  assertSandboxPath,
  createIsolatedEnvironment,
  createSandbox,
  SANDBOX_ROOT,
} from './sandbox.js';

export type FixtureFile = string | Uint8Array;

export interface GitFixtureOptions {
  readonly prefix?: string;
  readonly files?: Readonly<Record<string, FixtureFile>>;
  readonly symlinks?: Readonly<Record<string, string>>;
  readonly executable?: readonly string[];
  readonly message?: string;
}

export interface GitFixture {
  readonly root: string;
  readonly head: string;
  readonly env: NodeJS.ProcessEnv;
}

export async function createGitFixture(
  options: GitFixtureOptions = {},
): Promise<GitFixture> {
  const sandbox = await createSandbox(options.prefix ?? 'git');
  assertSandboxPath(sandbox);
  const root = resolve(sandbox, 'repository');
  assertSandboxPath(root);
  const env = await createIsolatedEnvironment(sandbox);

  const files = options.files ?? {};
  const symlinks = options.symlinks ?? {};
  const executable = new Set(options.executable ?? []);
  for (const path of [...Object.keys(files), ...Object.keys(symlinks)]) {
    assertFixturePath(path);
  }
  for (const path of executable) assertFixturePath(path);

  await mkdir(root, { recursive: true });
  await runGit(['init', '--quiet', root], { env });
  await runGit(['config', 'user.name', 'Layerdots Test'], { cwd: root, env });
  await runGit(['config', 'user.email', 'layerdots-test@example.invalid'], {
    cwd: root,
    env,
  });

  for (const [path, content] of Object.entries(files)) {
    const destination = fixturePath(root, path);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await writeFile(destination, content);
    if (executable.has(path)) await chmod(destination, 0o755);
  }
  for (const [path, target] of Object.entries(symlinks)) {
    const destination = fixturePath(root, path);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await symlink(target, destination);
  }

  await runGit(['add', '--all', '--', '.'], { cwd: root, env });
  await runGit(
    ['commit', '--quiet', '--message', options.message ?? 'fixture'],
    {
      cwd: root,
      env,
    },
  );
  const head = (
    await runGit(['rev-parse', 'HEAD'], { cwd: root, env })
  ).stdout.trim();
  return { root, head, env };
}

function assertFixturePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => part === '..')
  ) {
    throw new Error(`Unsafe fixture path outside ${SANDBOX_ROOT}: ${path}`);
  }
}

function fixturePath(root: string, path: string): string {
  const destination = resolve(root, path);
  const fromRoot = relative(root, destination);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot.startsWith(sep)
  ) {
    throw new Error(`Unsafe fixture path outside ${SANDBOX_ROOT}: ${path}`);
  }
  assertSandboxPath(destination);
  return destination;
}
