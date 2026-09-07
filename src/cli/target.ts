import { resolve as resolvePath } from 'node:path';
import { LayerdotsError } from '../domain/errors.js';

const ALLOW_HOME_ENV = 'LAYERDOTS_ALLOW_HOME';

export interface ResolveTargetOptions {
  readonly cwd: string;
  readonly explicitTarget?: string;
  readonly useHome: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveTargetPath(options: ResolveTargetOptions): string {
  const { cwd, explicitTarget, useHome, env = process.env } = options;

  if (explicitTarget !== undefined) {
    return resolvePath(cwd, explicitTarget);
  }

  if (!useHome) {
    throw new LayerdotsError(
      'Applying requires either --target or --apply-to-home.',
      'CLI_USAGE',
    );
  }

  const home = env.HOME;
  if (home === undefined || home === '') {
    throw new LayerdotsError('HOME is not set.', 'CLI_USAGE');
  }

  if (env[ALLOW_HOME_ENV] !== '1') {
    throw new LayerdotsError(
      'Home target requires the environment variable LAYERDOTS_ALLOW_HOME=1 and the --apply-to-home flag.',
      'HOME_TARGET_REQUIRES_OPT_IN',
    );
  }

  return home;
}
