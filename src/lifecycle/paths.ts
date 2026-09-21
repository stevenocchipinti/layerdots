import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface LayerdotsPaths {
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
  readonly clones: string;
}

export function resolveLayerdotsPaths(
  env: NodeJS.ProcessEnv = process.env,
): LayerdotsPaths {
  const home = env.HOME ?? homedir();
  const config = resolve(
    env.XDG_CONFIG_HOME ?? resolve(home, '.config'),
    'layerdots',
  );
  const data = resolve(
    env.XDG_DATA_HOME ?? resolve(home, '.local/share'),
    'layerdots',
  );
  const state = resolve(
    env.XDG_STATE_HOME ?? resolve(home, '.local/state'),
    'layerdots',
  );
  const cache = resolve(
    env.XDG_CACHE_HOME ?? resolve(home, '.cache'),
    'layerdots',
  );
  return { config, data, state, cache, clones: resolve(data, 'clones') };
}
