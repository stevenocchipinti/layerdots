import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export const SANDBOX_ROOT = resolve(WORKSPACE_ROOT, '.layerdots-dev');

export function assertSandboxPath(candidate: string): void {
  const resolved = resolve(candidate);
  const fromRoot = relative(SANDBOX_ROOT, resolved);
  const isInside =
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !fromRoot.startsWith(sep);

  if (!isInside) {
    throw new Error(`Unsafe test path outside ${SANDBOX_ROOT}: ${resolved}`);
  }
}

export async function createSandbox(prefix: string): Promise<string> {
  await mkdir(SANDBOX_ROOT, { recursive: true });
  const path = await mkdtemp(resolve(SANDBOX_ROOT, `${prefix}-`));
  assertSandboxPath(path);
  return path;
}

export async function createIsolatedEnvironment(
  root: string,
): Promise<NodeJS.ProcessEnv> {
  assertSandboxPath(root);

  const home = resolve(root, 'home');
  const config = resolve(root, 'xdg/config');
  const data = resolve(root, 'xdg/data');
  const state = resolve(root, 'xdg/state');
  const cache = resolve(root, 'xdg/cache');
  await Promise.all(
    [home, config, data, state, cache].map(async (path) =>
      mkdir(path, { recursive: true }),
    ),
  );

  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    GIT_CONFIG_GLOBAL: resolve(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
