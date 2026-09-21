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
): Promise<{ code: number; output: string }> {
  const output: string[] = [];
  const code = await runCli(args, {
    env,
    stdout: (value) => output.push(value),
  });
  return { code, output: output.join('') };
}

describe('capture loop acceptance', () => {
  it('stages all hunks, commits to the overlay, and pushes base before overlay', async () => {
    const sandbox = await createSandbox('capture-loop');
    const env = await createIsolatedEnvironment(sandbox);
    await writeFile(
      env.GIT_CONFIG_GLOBAL ?? join(sandbox, 'gitconfig'),
      '[user]\nname = Layerdots Test\nemail = test@example.invalid\n',
    );
    const base = await createGitFixture({
      prefix: 'capture-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.config/nvim/init.lua': 'return {}\n',
        'home/.gitconfig': '[user]\nname = Personal\n',
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);
    const overlay = await createGitFixture({
      prefix: 'capture-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: baseRemote, branch: 'main', commit: base.head },
        }),
        'home/.gitconfig.patch': `--- a/.gitconfig
+++ b/.gitconfig
@@ -1,2 +1,2 @@
 [user]
-name = Personal
+name = Work
`,
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
      '[user]\nname = Updated Work\n',
    );

    const status = await command(['status', '--target', target], env);
    expect(status.code).toBe(0);
    expect(status.output).toContain('UNASSIGNED .gitconfig STATUS modified');
    const jsonStatus: string[] = [];
    await expect(
      runCli(['status', '--target', target, '--json'], {
        env,
        stdout: (value) => jsonStatus.push(value),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(jsonStatus.join(''))).toMatchObject({
      version: 1,
      command: 'status',
    });
    const answers = ['y'];
    const interactiveOutput: string[] = [];
    expect(
      await runCli(
        [
          'assign',
          '.gitconfig',
          '--layer',
          'overlay',
          '--interactive',
          '--target',
          target,
        ],
        {
          env,
          stdout: (value) => interactiveOutput.push(value),
          readLine: () => Promise.resolve(answers.shift()),
        },
      ),
    ).toBe(0);
    expect(interactiveOutput.join('')).toContain(
      'STAGED .gitconfig LAYER overlay',
    );
    const errors: string[] = [];
    await expect(
      runCli(
        [
          'assign',
          '.gitconfig',
          '--layer',
          'overlay',
          '--all-hunks',
          '--target',
          target,
        ],
        { env, stderr: (value) => errors.push(value) },
      ),
    ).resolves.toBe(1);
    expect(errors.join('')).toContain('TRANSACTION_EXISTS');
    expect(
      (await command(['status', '--target', target], env)).output,
    ).toContain('STAGED TRANSACTION');
    const diff = await command(
      ['diff', '--target', target, '--color', 'always'],
      env,
    );
    expect(diff.output).toContain('Updated Work');
    expect(diff.output).toContain('STAGED DIFF');
    expect(diff.output).toContain('\u001b[');

    expect(
      (
        await command(
          ['commit', '--message', 'Update work identity', '--target', target],
          env,
        )
      ).output,
    ).toBe('COMMITTED\n');
    expect((await command(['push', '--target', target], env)).output).toBe(
      'PUSHED\n',
    );
    const patch = await runGit(
      ['--git-dir', overlayRemote, 'show', 'main:home/.gitconfig.patch'],
      { env },
    );
    expect(patch.stdout).toContain('+name = Updated Work');
    expect(await readFile(join(target, 'home/.gitconfig'), 'utf8')).toBe(
      '[user]\nname = Updated Work\n',
    );

    await writeFile(join(target, 'home/new-config'), 'new\n');
    expect(
      (
        await command(
          [
            'assign',
            'new-config',
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
    const stagedAddition = await command(['diff', '--target', target], env);
    expect(stagedAddition.output).toContain('STAGED DIFF');
    expect(stagedAddition.output).toMatch(/REMAINING TARGET DIFF\nCLEAN/);
  });
});
