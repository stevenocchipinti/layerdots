import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTargetPath } from '../../src/cli/target.js';
import { runCli } from '../../src/cli/main.js';
import { createGitFixture } from '../support/git.js';
import {
  createIsolatedEnvironment,
  createSandbox,
} from '../support/sandbox.js';

describe('resolveTargetPath', () => {
  it('resolves an explicit target against cwd', async () => {
    const sandbox = await createSandbox('target-explicit');
    const env = await createIsolatedEnvironment(sandbox);
    const result = resolveTargetPath({
      cwd: sandbox,
      explicitTarget: 'my-target',
      useHome: false,
      env,
    });
    expect(result).toBe(join(sandbox, 'my-target'));
  });

  it('throws CLI_USAGE when neither --target nor --apply-to-home is given', async () => {
    const sandbox = await createSandbox('target-none');
    const env = await createIsolatedEnvironment(sandbox);
    expect(() =>
      resolveTargetPath({
        cwd: sandbox,
        useHome: false,
        env,
      }),
    ).toThrow(expect.objectContaining({ code: 'CLI_USAGE' }));
  });

  it('throws HOME_TARGET_REQUIRES_OPT_IN when --apply-to-home is used without the env var', async () => {
    const sandbox = await createSandbox('target-guard');
    const env = await createIsolatedEnvironment(sandbox);
    expect(() =>
      resolveTargetPath({
        cwd: sandbox,
        useHome: true,
        env,
      }),
    ).toThrow(expect.objectContaining({ code: 'HOME_TARGET_REQUIRES_OPT_IN' }));
  });

  it('returns the sandbox HOME when --apply-to-home is used with LAYERDOTS_ALLOW_HOME=1', async () => {
    const sandbox = await createSandbox('target-home-ok');
    const env = await createIsolatedEnvironment(sandbox);
    const result = resolveTargetPath({
      cwd: sandbox,
      useHome: true,
      env: { ...env, LAYERDOTS_ALLOW_HOME: '1' },
    });
    expect(result).toBe(env.HOME);
  });

  it('throws CLI_USAGE when --apply-to-home is used but HOME is unset', async () => {
    const sandbox = await createSandbox('target-no-home');
    expect(() =>
      resolveTargetPath({
        cwd: sandbox,
        useHome: true,
        env: { LAYERDOTS_ALLOW_HOME: '1' },
      }),
    ).toThrow(expect.objectContaining({ code: 'CLI_USAGE' }));
  });

  it('throws CLI_USAGE when both --target and --apply-to-home are given', async () => {
    const sandbox = await createSandbox('target-conflict');
    const base = await createGitFixture({
      prefix: 'target-conflict-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'one\n',
      },
    });
    let stderr = '';
    const code = await runCli(
      [
        'apply',
        '--base',
        base.root,
        '--target',
        join(sandbox, 't'),
        '--apply-to-home',
      ],
      {
        stdout: () => {},
        stderr: (v) => {
          stderr += v;
        },
        cwd: sandbox,
      },
    );
    expect(code).toBe(1);
    expect(stderr).toContain('CLI_USAGE');
  });
});

describe('apply --apply-to-home integration', () => {
  it('rejects --apply-to-home at the CLI level when LAYERDOTS_ALLOW_HOME is not set', async () => {
    const sandbox = await createSandbox('target-integ-guard');
    const base = await createGitFixture({
      prefix: 'target-integ-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'one\n',
      },
    });
    let stdout = '';
    let stderr = '';
    const code = await runCli(
      ['apply', '--base', base.root, '--apply-to-home'],
      {
        stdout: (v) => {
          stdout += v;
        },
        stderr: (v) => {
          stderr += v;
        },
        cwd: sandbox,
      },
    );
    expect(code).toBe(1);
    expect(stderr).toContain('HOME_TARGET_REQUIRES_OPT_IN');
    expect(stdout).not.toContain('APPLIED');
  });
});
