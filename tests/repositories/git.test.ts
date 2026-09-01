import { lstat, readlink } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { LayerdotsError } from '../../src/domain/errors.js';
import { GitCommandError, runGit } from '../../src/repositories/git.js';
import { createGitFixture } from '../support/git.js';
import {
  createIsolatedEnvironment,
  createSandbox,
} from '../support/sandbox.js';

describe('system Git adapter', () => {
  it('rejects a missing explicit environment at runtime', async () => {
    await expect(
      runGit(['--version'], { env: undefined } as unknown as {
        env: NodeJS.ProcessEnv;
      }),
    ).rejects.toMatchObject({ code: 'git_environment_required' });
  });

  it('creates a clean committed fixture and returns HEAD', async () => {
    const fixture = await createGitFixture({
      files: { 'home/.gitconfig': '[user]\n', 'bin/tool': '#!/bin/sh\n' },
      executable: ['bin/tool'],
      symlinks: { 'home/.config-link': '../config' },
    });

    expect(fixture.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(
      (
        await runGit(['status', '--porcelain'], {
          cwd: fixture.root,
          env: fixture.env,
        })
      ).stdout,
    ).toBe('');
    expect(
      (
        await runGit(['rev-parse', 'HEAD'], {
          cwd: fixture.root,
          env: fixture.env,
        })
      ).stdout.trim(),
    ).toBe(fixture.head);
    expect(
      (await lstat(`${fixture.root}/home/.config-link`)).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(`${fixture.root}/home/.config-link`)).toBe(
      '../config',
    );
    expect((await lstat(`${fixture.root}/bin/tool`)).mode & 0o111).not.toBe(0);
  });

  it('reports structured diagnostics for failed Git commands', async () => {
    const sandbox = await createSandbox('git-failure');
    const env = await createIsolatedEnvironment(sandbox);

    await expect(
      runGit(['not-a-real-command'], { cwd: sandbox, env }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof LayerdotsError)) return false;
      const gitError = error as GitCommandError;
      return (
        error.code === 'git_command_failed' &&
        error.message.includes('not-a-real-command') &&
        error.cause !== undefined &&
        gitError.stderr.includes('not-a-real-command') &&
        gitError.exitCode === 1
      );
    });
  });

  it('rejects fixture paths outside the sandbox repository', async () => {
    await expect(
      createGitFixture({ files: { '../escape': 'nope' } }),
    ).rejects.toThrow('Unsafe fixture path');
    await expect(
      createGitFixture({ files: { '/tmp/escape': 'nope' } }),
    ).rejects.toThrow('Unsafe fixture path');
  });
});
