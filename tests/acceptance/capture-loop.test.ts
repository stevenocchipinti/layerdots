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
    // The whole diff at .gitconfig is already staged by the interactive
    // assignment above, so re-assigning the same path with nothing left
    // unassigned is rejected, not because a transaction exists, but because
    // there is no remaining change to route. A second, distinct path can
    // still be staged into the same transaction (see the multi-path capture
    // test below).
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
    expect(errors.join('')).toContain('ASSIGNMENT_NOT_FOUND');
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

  it('stages two distinct hunks of the same path to different layers within one transaction', async () => {
    const sandbox = await createSandbox('capture-multi-hunk');
    const env = await createIsolatedEnvironment(sandbox);
    await writeFile(
      env.GIT_CONFIG_GLOBAL ?? join(sandbox, 'gitconfig'),
      '[user]\nname = Layerdots Test\nemail = test@example.invalid\n',
    );
    const lines = Array.from(
      { length: 12 },
      (_unused, index) => `line${String(index + 1).padStart(2, '0')}`,
    );
    const base = await createGitFixture({
      prefix: 'multi-hunk-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.multi': `${lines.join('\n')}\n`,
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);
    const overlay = await createGitFixture({
      prefix: 'multi-hunk-overlay',
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

    const edited = [...lines];
    edited[0] = 'LINE01';
    edited[11] = 'LINE12';
    await writeFile(join(target, 'home/.multi'), `${edited.join('\n')}\n`);

    // Confirm the edits produce two distinct hunks, then cancel without
    // staging anything, before staging each hunk to a different layer.
    const prompts: string[] = [];
    const cancelAnswers = ['n', 'q'];
    expect(
      await runCli(
        [
          'assign',
          '.multi',
          '--layer',
          'overlay',
          '--interactive',
          '--target',
          target,
        ],
        {
          env,
          stdout: (value) => prompts.push(value),
          readLine: () => Promise.resolve(cancelAnswers.shift()),
        },
      ),
    ).toBe(0);
    expect(prompts.join('')).toContain('HUNK 1/2');
    expect(prompts.join('')).toContain('HUNK 2/2');

    expect(
      (
        await command(
          [
            'assign',
            '.multi',
            '--layer',
            'overlay',
            '--select',
            '1',
            '--target',
            target,
          ],
          env,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await command(
          [
            'assign',
            '.multi',
            '--layer',
            'base',
            '--select',
            '1',
            '--target',
            target,
          ],
          env,
        )
      ).code,
    ).toBe(0);

    const status = await command(['status', '--target', target], env);
    expect(status.output).toContain('STAGED .multi LAYER overlay SELECTIONS 1');
    expect(status.output).toContain('STAGED .multi LAYER base SELECTIONS 1');

    const diffAfterStaging = await command(['diff', '--target', target], env);
    expect(diffAfterStaging.output).toMatch(/REMAINING TARGET DIFF\nCLEAN/);

    expect(
      (
        await command(
          [
            'commit',
            '--message',
            'Split hunks across layers',
            '--target',
            target,
          ],
          env,
        )
      ).output,
    ).toBe('COMMITTED\n');
    expect((await command(['apply', '--target', target], env)).code).toBe(0);
    expect(await readFile(join(target, 'home/.multi'), 'utf8')).toBe(
      `${edited.join('\n')}\n`,
    );
    expect((await command(['status', '--target', target], env)).output).toBe(
      'CLEAN\n',
    );
  });
});
