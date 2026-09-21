import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { targetStateId } from '../../src/lifecycle/stack.js';
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

describe('discard acceptance', () => {
  it('discards a staged assignment transaction without touching the target or active stack', async () => {
    const sandbox = await createSandbox('discard-transaction');
    const env = await createIsolatedEnvironment(sandbox);
    await writeFile(
      env.GIT_CONFIG_GLOBAL ?? join(sandbox, 'gitconfig'),
      '[user]\nname = Layerdots Test\nemail = test@example.invalid\n',
    );
    const base = await createGitFixture({
      prefix: 'discard-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.gitconfig': '[user]\nname = Personal\n',
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);
    const overlay = await createGitFixture({
      prefix: 'discard-overlay',
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
    expect((await command(['status', '--target', target], env)).output).toBe(
      'UNASSIGNED .gitconfig STATUS modified KIND text-hunks\nSTAGED TRANSACTION\nSTAGED .gitconfig LAYER overlay SELECTIONS 1\n',
    );

    expect((await command(['discard', '--target', target], env)).output).toBe(
      'DISCARDED TRANSACTION\n',
    );

    // The target edit and the active stack are untouched: only the staged
    // transaction is gone.
    expect((await command(['status', '--target', target], env)).output).toBe(
      'UNASSIGNED .gitconfig STATUS modified KIND text-hunks\n',
    );
    expect(await readFile(join(target, 'home/.gitconfig'), 'utf8')).toBe(
      '[user]\nname = Updated\n',
    );

    const commitAfterDiscard = await command(
      ['commit', '--message', 'nothing to commit', '--target', target],
      env,
    );
    expect(commitAfterDiscard.code).toBe(1);
    expect(commitAfterDiscard.errors).toContain('TRANSACTION_NOT_FOUND');

    const discardAgain = await command(['discard', '--target', target], env);
    expect(discardAgain.code).toBe(1);
    expect(discardAgain.errors).toContain('TRANSACTION_NOT_FOUND');
  });

  it('discards a staged stack switch without touching the target or active stack', async () => {
    const sandbox = await createSandbox('discard-switch');
    const env = await createIsolatedEnvironment(sandbox);
    const oldBase = await createGitFixture({
      prefix: 'discard-switch-old-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.shared': 'old\n',
      },
    });
    const oldBaseRemote = join(sandbox, 'old-base.git');
    await bareRemote(oldBase.root, oldBaseRemote, oldBase.env);
    const oldOverlay = await createGitFixture({
      prefix: 'discard-switch-old-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: oldBaseRemote, branch: 'main', commit: oldBase.head },
        }),
        'home/.private': 'old private state\n',
      },
    });
    const oldOverlayRemote = join(sandbox, 'old-overlay.git');
    await bareRemote(oldOverlay.root, oldOverlayRemote, oldOverlay.env);

    const newBase = await createGitFixture({
      prefix: 'discard-switch-new-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.shared': 'new\n',
      },
    });
    const newBaseRemote = join(sandbox, 'new-base.git');
    await bareRemote(newBase.root, newBaseRemote, newBase.env);
    const newOverlay = await createGitFixture({
      prefix: 'discard-switch-new-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: newBaseRemote, branch: 'main', commit: newBase.head },
        }),
        'home/.work': 'new private state\n',
      },
    });
    const newOverlayRemote = join(sandbox, 'new-overlay.git');
    await bareRemote(newOverlay.root, newOverlayRemote, newOverlay.env);

    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });
    expect(
      (await command(['init', oldOverlayRemote, '--target', target], env)).code,
    ).toBe(0);
    expect((await command(['apply', '--target', target], env)).code).toBe(0);

    expect(
      (await command(['switch', newOverlayRemote, '--target', target], env))
        .output,
    ).toBe('SWITCH STAGED\n');
    await access(
      join(
        sandbox,
        'xdg/state/layerdots',
        `stack-switch-${targetStateId(target)}.json`,
      ),
    );

    expect((await command(['discard', '--target', target], env)).output).toBe(
      'DISCARDED STACK SWITCH\n',
    );
    await expect(
      access(
        join(
          sandbox,
          'xdg/state/layerdots',
          `stack-switch-${targetStateId(target)}.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // The old stack and target content are untouched.
    expect(await readFile(join(target, 'home/.shared'), 'utf8')).toBe('old\n');
    expect(await readFile(join(target, 'home/.private'), 'utf8')).toBe(
      'old private state\n',
    );
    const switchApplyAfterDiscard = await command(
      ['switch', 'apply', '--target', target],
      env,
    );
    expect(switchApplyAfterDiscard.code).toBe(1);
    expect(switchApplyAfterDiscard.errors).toContain('TRANSACTION_NOT_FOUND');
  });

  it('reports an error when nothing is staged for the target', async () => {
    const sandbox = await createSandbox('discard-empty');
    const env = await createIsolatedEnvironment(sandbox);
    const base = await createGitFixture({
      prefix: 'discard-empty-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.gitconfig': '[user]\nname = Personal\n',
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);
    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });
    expect(
      (await command(['init', baseRemote, '--target', target], env)).code,
    ).toBe(0);

    const result = await command(['discard', '--target', target], env);
    expect(result.code).toBe(1);
    expect(result.errors).toContain('Nothing is staged for this target.');
  });
});
