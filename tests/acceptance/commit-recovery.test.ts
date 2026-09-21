import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { runGit } from '../../src/repositories/git.js';
import { createGitFixture } from '../support/git.js';
import {
  createIsolatedEnvironment,
  createSandbox,
} from '../support/sandbox.js';

async function bareRemote(
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runGit(['branch', '--move', 'main'], { cwd: source, env });
  await runGit(['clone', '--bare', '--quiet', source, destination], { env });
}

async function command(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string; errors: string }> {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli(args, {
    env,
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
  });
  return { code, output: output.join(''), errors: errors.join('') };
}

describe('commit recovery acceptance', () => {
  it('recovers a managed clone after a commit fails for an unconfigured Git identity', async () => {
    const sandbox = await createSandbox('commit-recovery');
    // Deliberately do not write a Git identity to env.GIT_CONFIG_GLOBAL: the
    // managed clones produced by `init` have no local identity of their own,
    // so `git commit` inside them fails exactly as it would for a user who
    // has not yet configured Git.
    const env = await createIsolatedEnvironment(sandbox);
    const base = await createGitFixture({
      prefix: 'commit-recovery-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.gitconfig': '[user]\nname = Personal\n',
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);
    const overlay = await createGitFixture({
      prefix: 'commit-recovery-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: baseRemote, branch: 'main', commit: base.head },
        }),
        'home/.overlay-marker': 'present\n',
      },
    });
    const overlayRemote = join(sandbox, 'overlay.git');
    await bareRemote(overlay.root, overlayRemote, overlay.env);
    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });

    expect(
      (await command(['init', overlayRemote, '--target', target], env)).code,
    ).toBe(0);
    expect((await command(['apply', '--target', target], env)).code).toBe(0);
    await writeFile(
      join(target, 'home/.gitconfig'),
      '[user]\nname = Updated\n',
    );
    expect(
      (
        await command(
          [
            'assign',
            '.gitconfig',
            '--layer',
            'overlay',
            '--all-hunks',
            '--target',
            target,
          ],
          env,
        )
      ).code,
    ).toBe(0);

    const registry = JSON.parse(
      await readFile(
        join(sandbox, 'xdg/config/layerdots/active-stack.json'),
        'utf8',
      ),
    ) as { layers: { root: string }[] };
    const overlayClone = registry.layers[1];
    if (overlayClone === undefined) throw new Error('expected overlay clone');

    const failed = await command(
      ['commit', '--message', 'Update work identity', '--target', target],
      env,
    );
    expect(failed.code).toBe(1);
    expect(failed.errors).toContain('git_command_failed');

    // The failed commit must not leave the managed clone dirty: a retry
    // after fixing the underlying cause should not require any manual
    // `git reset` in the clone.
    const cloneStatus = await runGit(['status', '--porcelain'], {
      cwd: overlayClone.root,
      env,
    });
    expect(cloneStatus.stdout).toBe('');

    // The staged transaction itself must survive the failed commit so the
    // same work can be retried without re-staging.
    expect((await command(['status', '--target', target], env)).output).toBe(
      'UNASSIGNED .gitconfig STATUS modified KIND text-hunks\nSTAGED TRANSACTION\nSTAGED .gitconfig LAYER overlay SELECTIONS 1\n',
    );

    // Fix the underlying cause (a real user would run `git config --global
    // user.name`/`user.email`) and retry the exact same command.
    await writeFile(
      env.GIT_CONFIG_GLOBAL ?? join(sandbox, 'gitconfig'),
      '[user]\nname = Layerdots Test\nemail = test@example.invalid\n',
    );
    expect(
      (
        await command(
          ['commit', '--message', 'Update work identity', '--target', target],
          env,
        )
      ).output,
    ).toBe('COMMITTED\n');
    expect((await command(['apply', '--target', target], env)).code).toBe(0);
    expect(await readFile(join(target, 'home/.gitconfig'), 'utf8')).toBe(
      '[user]\nname = Updated\n',
    );
    expect((await command(['status', '--target', target], env)).output).toBe(
      'CLEAN\n',
    );
  });
});
