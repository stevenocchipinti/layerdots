import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSandboxPath,
  createIsolatedEnvironment,
  createSandbox,
  SANDBOX_ROOT,
} from './sandbox.js';

describe('sandbox safety', () => {
  it('rejects the actual home and repository root', () => {
    expect(() => {
      assertSandboxPath(homedir());
    }).toThrow(/Unsafe test path/);
    expect(() => {
      assertSandboxPath(resolve(SANDBOX_ROOT, '..'));
    }).toThrow(/Unsafe test path/);
  });

  it('creates isolated HOME, XDG, and Git configuration paths', async () => {
    const root = await createSandbox('environment');
    const environment = await createIsolatedEnvironment(root);

    expect(environment.HOME).toBe(resolve(root, 'home'));
    expect(environment.XDG_DATA_HOME).toBe(resolve(root, 'xdg/data'));
    expect(environment.GIT_CONFIG_GLOBAL).toBe(resolve(root, 'gitconfig'));
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1');
  });
});
