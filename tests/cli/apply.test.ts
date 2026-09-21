import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import { createGitFixture } from '../support/git.js';
import {
  createIsolatedEnvironment,
  createSandbox,
} from '../support/sandbox.js';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runApply(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  cwd: string,
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: (value: string) => {
      stdout += value;
    },
    stderr: (value: string) => {
      stderr += value;
    },
  };
  vi.stubEnv('HOME', env.HOME ?? '');
  vi.stubEnv('XDG_CONFIG_HOME', env.XDG_CONFIG_HOME ?? '');
  vi.stubEnv('XDG_DATA_HOME', env.XDG_DATA_HOME ?? '');
  vi.stubEnv('XDG_STATE_HOME', env.XDG_STATE_HOME ?? '');
  vi.stubEnv('XDG_CACHE_HOME', env.XDG_CACHE_HOME ?? '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', env.GIT_CONFIG_GLOBAL ?? '');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', env.GIT_CONFIG_NOSYSTEM ?? '');
  try {
    const code = await runCli(args, { ...io, cwd });
    return { code, stdout, stderr };
  } finally {
    vi.unstubAllEnvs();
  }
}

interface ApplyTarget {
  readonly sandbox: string;
  readonly target: string;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
}

async function createApplyTarget(prefix: string): Promise<ApplyTarget> {
  const sandbox = await createSandbox(prefix);
  const target = join(sandbox, 'target');
  await mkdir(join(target, 'home'), { recursive: true });
  const env = await createIsolatedEnvironment(sandbox);
  return { sandbox, target, stateDir: join(sandbox, 'state'), env };
}

describe('apply', () => {
  it('applies a base and overlay to the target and reports written paths', async () => {
    const base = await createGitFixture({
      prefix: 'cli-apply-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/base.txt': 'from base\n',
      },
    });
    const overlay = await createGitFixture({
      prefix: 'cli-apply-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: base.root, branch: 'main', commit: base.head },
        }),
        'home/base.txt.patch':
          '--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-from base\n+from overlay patch\n',
        'home/added.txt': 'from overlay\n',
      },
    });
    const { sandbox, target, stateDir, env } =
      await createApplyTarget('cli-apply-sandbox');

    const result = await runApply(
      env,
      [
        'apply',
        '--base',
        base.root,
        '--overlay',
        overlay.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
      ],
      sandbox,
    );

    expect(result.code).toBe(0);
    expect(await readFile(join(target, 'home/base.txt'), 'utf8')).toBe(
      'from overlay patch\n',
    );
    expect(await readFile(join(target, 'home/added.txt'), 'utf8')).toBe(
      'from overlay\n',
    );
    expect(result.stdout).toContain('APPLIED');
    expect(result.stdout).toContain('WRITTEN base.txt');
    expect(result.stdout).toContain('WRITTEN added.txt');
    expect(result.stdout).toContain('CONFLICTS 0');
    await access(join(stateDir, 'default.json'));
  });

  it('is idempotent when re-applying an unchanged composition', async () => {
    const base = await createGitFixture({
      prefix: 'cli-apply-idem-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'one\n',
      },
    });
    const { sandbox, target, env } = await createApplyTarget(
      'cli-apply-idem-sandbox',
    );

    const first = await runApply(
      env,
      ['apply', '--base', base.root, '--target', target],
      sandbox,
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('WRITTEN config');

    const second = await runApply(
      env,
      ['apply', '--base', base.root, '--target', target],
      sandbox,
    );
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('APPLIED');
    expect(second.stdout).toContain('CONFLICTS 0');
    expect(second.stdout).not.toContain('WRITTEN ');
    expect(await readFile(join(target, 'home/config'), 'utf8')).toBe('one\n');
  });

  it('preserves a disjoint local edit while landing advanced base content', async () => {
    const base1 = await createGitFixture({
      prefix: 'cli-apply-merge-base1',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'one\n',
        'home/vimrc': 'set x\n',
      },
    });
    const { sandbox, target, stateDir, env } = await createApplyTarget(
      'cli-apply-merge-sandbox',
    );

    const first = await runApply(
      env,
      [
        'apply',
        '--base',
        base1.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
      ],
      sandbox,
    );
    expect(first.code).toBe(0);

    await writeFile(join(target, 'home/vimrc'), 'set x\nset y\n');

    const base2 = await createGitFixture({
      prefix: 'cli-apply-merge-base2',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'one\nadvanced\n',
        'home/vimrc': 'set x\n',
      },
    });
    const second = await runApply(
      env,
      [
        'apply',
        '--base',
        base2.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
      ],
      sandbox,
    );

    expect(second.code).toBe(0);
    expect(await readFile(join(target, 'home/config'), 'utf8')).toBe(
      'one\nadvanced\n',
    );
    expect(await readFile(join(target, 'home/vimrc'), 'utf8')).toBe(
      'set x\nset y\n',
    );
  });

  it('isolates conflicts in a workspace and leaves the live target unchanged', async () => {
    const base1 = await createGitFixture({
      prefix: 'cli-apply-conflict-base1',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'line1\nline2\n',
      },
    });
    const { sandbox, target, stateDir, env } = await createApplyTarget(
      'cli-apply-conflict-sandbox',
    );

    const first = await runApply(
      env,
      [
        'apply',
        '--base',
        base1.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
      ],
      sandbox,
    );
    expect(first.code).toBe(0);

    await writeFile(join(target, 'home/config'), 'line1\nlocal\n');
    const preConflict = await readFile(join(target, 'home/config'), 'utf8');

    const base2 = await createGitFixture({
      prefix: 'cli-apply-conflict-base2',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'line1\nremote\n',
      },
    });
    const second = await runApply(
      env,
      [
        'apply',
        '--base',
        base2.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
      ],
      sandbox,
    );

    expect(second.code).toBe(0);
    expect(second.stdout).toContain('CONFLICTS');
    const line = second.stdout
      .split('\n')
      .find((entry) => entry.startsWith('CONFLICT config WORKSPACE '));
    expect(line).toBeDefined();
    if (line === undefined) return;
    const workspace = line.slice('CONFLICT config WORKSPACE '.length);
    await access(workspace);
    expect(await readFile(join(target, 'home/config'), 'utf8')).toBe(
      preConflict,
    );
  });

  it('rejects type replacement without approval and applies with it', async () => {
    const base1 = await createGitFixture({
      prefix: 'cli-apply-type-base1',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/tool': 'original\n',
      },
    });
    const { sandbox, target, stateDir, env } = await createApplyTarget(
      'cli-apply-type-sandbox',
    );

    const first = await runApply(
      env,
      [
        'apply',
        '--base',
        base1.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
      ],
      sandbox,
    );
    expect(first.code).toBe(0);
    let stats = await lstat(join(target, 'home/tool'));
    expect(stats.isFile()).toBe(true);

    const base2 = await createGitFixture({
      prefix: 'cli-apply-type-base2',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
      },
      symlinks: {
        'home/tool': '/usr/bin/tool',
      },
    });

    const unapproved = await runApply(
      env,
      [
        'apply',
        '--base',
        base2.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
      ],
      sandbox,
    );
    expect(unapproved.code).toBe(1);
    expect(unapproved.stderr).toContain('type-replacement-requires-approval');
    stats = await lstat(join(target, 'home/tool'));
    expect(stats.isFile()).toBe(true);

    const approved = await runApply(
      env,
      [
        'apply',
        '--base',
        base2.root,
        '--target',
        target,
        '--state-dir',
        stateDir,
        '--approve',
        'tool',
      ],
      sandbox,
    );
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain('WRITTEN tool');
    stats = await lstat(join(target, 'home/tool'));
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readlink(join(target, 'home/tool'))).toBe('/usr/bin/tool');
  });

  it('reports active-stack, unknown-flag, and missing-value errors', async () => {
    const base = await createGitFixture({
      prefix: 'cli-apply-usage-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'one\n',
      },
    });
    const { sandbox, target, env } = await createApplyTarget(
      'cli-apply-usage-sandbox',
    );

    const missingBase = await runApply(
      env,
      ['apply', '--target', target],
      sandbox,
    );
    expect(missingBase.code).toBe(1);
    expect(missingBase.stderr).toContain('STACK_NOT_CONFIGURED');

    const unknown = await runApply(
      env,
      ['apply', '--base', base.root, '--target', target, '--bogus'],
      sandbox,
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('CLI_USAGE');

    const missingOverlayValue = await runApply(
      env,
      ['apply', '--base', base.root, '--target', target, '--overlay'],
      sandbox,
    );
    expect(missingOverlayValue.code).toBe(1);
    expect(missingOverlayValue.stderr).toContain('CLI_USAGE');

    const emptyApprove = await runApply(
      env,
      ['apply', '--base', base.root, '--target', target, '--approve', ''],
      sandbox,
    );
    expect(emptyApprove.code).toBe(1);
    expect(emptyApprove.stderr).toContain('CLI_USAGE');

    const managedTarget = await runApply(
      env,
      ['apply', '--base', base.root, '--target', join(sandbox, 'xdg/data')],
      sandbox,
    );
    expect(managedTarget.code).toBe(1);
    expect(managedTarget.stderr).toContain('TARGET_OVERLAPS_LAYERDOTS_DATA');
  });

  it('rejects apply without an explicit target', async () => {
    const base = await createGitFixture({
      prefix: 'cli-apply-no-target-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'one\n',
      },
    });
    const sandbox = await createSandbox('cli-apply-no-target-sandbox');
    const env = await createIsolatedEnvironment(sandbox);

    const result = await runApply(env, ['apply', '--base', base.root], sandbox);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLI_USAGE');
    expect(result.stdout).not.toContain('APPLIED');
  });
});
