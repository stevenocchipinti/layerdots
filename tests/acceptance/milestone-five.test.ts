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

describe('Milestone 5 acceptance', () => {
  it('stages a three-way switch, retains clones, purges the transient snapshot, and composes two overlays', async () => {
    const sandbox = await createSandbox('m5-lifecycle');
    const env = await createIsolatedEnvironment(sandbox);
    const oldBase = await createGitFixture({
      prefix: 'm5-old-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.shared': 'old\n',
        'home/.local': 'base\n',
      },
    });
    const oldBaseRemote = join(sandbox, 'old-base.git');
    await bareRemote(oldBase.root, oldBaseRemote, oldBase.env);
    const oldOverlay = await createGitFixture({
      prefix: 'm5-old-overlay',
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
      prefix: 'm5-new-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.shared': 'new\n',
        'home/.local': 'base\n',
      },
    });
    const newBaseRemote = join(sandbox, 'new-base.git');
    await bareRemote(newBase.root, newBaseRemote, newBase.env);
    const middle = await createGitFixture({
      prefix: 'm5-middle',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: newBaseRemote, branch: 'main', commit: newBase.head },
        }),
        'home/.shared.patch':
          '--- a/.shared\n+++ b/.shared\n@@ -1 +1 @@\n-new\n+middle\n',
      },
    });
    const middleRemote = join(sandbox, 'middle.git');
    await bareRemote(middle.root, middleRemote, middle.env);
    const top = await createGitFixture({
      prefix: 'm5-top',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: middleRemote, branch: 'main', commit: middle.head },
        }),
        'home/.shared.patch':
          '--- a/.shared\n+++ b/.shared\n@@ -1 +1 @@\n-middle\n+top\n',
        'home/.work': 'new private state\n',
      },
    });
    const topRemote = join(sandbox, 'top.git');
    await bareRemote(top.root, topRemote, top.env);

    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });
    await expect(
      runCli(['init', oldOverlayRemote, '--target', target], { env }),
    ).resolves.toBe(0);
    await expect(runCli(['apply', '--target', target], { env })).resolves.toBe(
      0,
    );
    await writeFile(join(target, 'home/.local'), 'target edit\n');
    await writeFile(join(target, 'home/unmanaged'), 'leave me\n');

    await expect(
      runCli(['switch', topRemote, '--target', target], { env }),
    ).resolves.toBe(0);
    expect(await readFile(join(target, 'home/.shared'), 'utf8')).toBe('old\n');
    expect(await readFile(join(target, 'home/.private'), 'utf8')).toBe(
      'old private state\n',
    );
    const status: string[] = [];
    await runCli(['status', '--target', target], {
      env,
      stdout: (value) => status.push(value),
    });
    expect(status.join('')).toContain('STAGED STACK SWITCH LAYERS 2 -> 3');
    const diff: string[] = [];
    await runCli(['diff', '--target', target], {
      env,
      stdout: (value) => diff.push(value),
    });
    expect(diff.join('')).toContain('STAGED STACK SWITCH');
    await access(
      join(
        sandbox,
        'xdg/state/layerdots',
        `stack-switch-${targetStateId(target)}.json`,
      ),
    );

    await expect(
      runCli(['switch', 'apply', '--target', target], { env }),
    ).resolves.toBe(0);
    expect(await readFile(join(target, 'home/.shared'), 'utf8')).toBe('top\n');
    expect(await readFile(join(target, 'home/.local'), 'utf8')).toBe(
      'target edit\n',
    );
    expect(await readFile(join(target, 'home/.work'), 'utf8')).toBe(
      'new private state\n',
    );
    expect(await readFile(join(target, 'home/unmanaged'), 'utf8')).toBe(
      'leave me\n',
    );
    await expect(access(join(target, 'home/.private'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      access(
        join(
          sandbox,
          'xdg/state/layerdots',
          `stack-switch-${targetStateId(target)}.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const registry = JSON.parse(
      await readFile(
        join(sandbox, 'xdg/config/layerdots/active-stacks.json'),
        'utf8',
      ),
    ) as { stacks: { layers: { root: string }[] }[] };
    expect(registry.stacks).toHaveLength(1);
    expect(registry.stacks[0]?.layers).toHaveLength(3);
    await access(registry.stacks[0]?.layers[0]?.root ?? '');
    const oldClone = join(sandbox, 'xdg/data/layerdots/clones');
    await access(oldClone);

    const otherTarget = join(sandbox, 'other-target');
    await expect(
      runCli(['init', topRemote, '--target', otherTarget], { env }),
    ).resolves.toBe(0);
    await expect(
      runCli(['init', topRemote, '--target', target], { env }),
    ).resolves.toBe(1);
    const updatedRegistry = JSON.parse(
      await readFile(
        join(sandbox, 'xdg/config/layerdots/active-stacks.json'),
        'utf8',
      ),
    ) as { stacks: unknown[] };
    expect(updatedRegistry.stacks).toHaveLength(2);
  });
});
