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
): Promise<string> {
  const output: string[] = [];
  await expect(
    runCli(args, { env, stdout: (value) => output.push(value) }),
  ).resolves.toBe(0);
  return output.join('');
}

describe('synchronization acceptance', () => {
  it('stages a non-conflicting parent advance and regenerates the overlay pin', async () => {
    const sandbox = await createSandbox('sync');
    const env = await createIsolatedEnvironment(sandbox);
    await writeFile(
      env.GIT_CONFIG_GLOBAL ?? join(sandbox, 'gitconfig'),
      '[user]\nname = Test\nemail = test@example.invalid\n',
    );
    const base = await createGitFixture({
      prefix: 'sync-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'base\nsetting = old\n',
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);
    const overlay = await createGitFixture({
      prefix: 'sync-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: baseRemote, branch: 'main', commit: base.head },
        }),
        'home/config.patch': `--- a/config
+++ b/config
@@ -1,2 +1,2 @@
 base
-setting = old
+setting = work
`,
      },
    });
    const overlayRemote = join(sandbox, 'overlay.git');
    await bareRemote(overlay.root, overlayRemote, overlay.env);
    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });
    await command(['init', overlayRemote, '--target', target], env);
    await command(['apply', '--target', target], env);

    await writeFile(join(base.root, 'home/new-public'), 'available\n');
    await runGit(['add', '--all'], { cwd: base.root, env: base.env });
    await runGit(['commit', '--message', 'Advance base'], {
      cwd: base.root,
      env: base.env,
    });
    await runGit(['push', baseRemote, 'main:main'], {
      cwd: base.root,
      env: base.env,
    });

    expect(await command(['sync', '--target', target], env)).toBe(
      'SYNC STAGED\n',
    );
    expect(
      await command(
        ['commit', '--message', 'Sync parent', '--target', target],
        env,
      ),
    ).toBe('COMMITTED\n');
    await command(['apply', '--target', target], env);
    expect(await readFile(join(target, 'home/config'), 'utf8')).toBe(
      'base\nsetting = work\n',
    );
    expect(await readFile(join(target, 'home/new-public'), 'utf8')).toBe(
      'available\n',
    );
  });

  it('rejects a diverged remote without changing the active stack', async () => {
    const sandbox = await createSandbox('sync-diverged');
    const env = await createIsolatedEnvironment(sandbox);
    await writeFile(
      env.GIT_CONFIG_GLOBAL ?? join(sandbox, 'gitconfig'),
      '[user]\nname = Test\nemail = test@example.invalid\n',
    );
    const base = await createGitFixture({
      prefix: 'sync-diverged-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'original\n',
      },
    });
    const remote = join(sandbox, 'base.git');
    await bareRemote(base.root, remote, base.env);
    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });
    await command(['init', remote, '--target', target], env);

    const config = JSON.parse(
      await readFile(
        join(sandbox, 'xdg/config/layerdots/active-stack.json'),
        'utf8',
      ),
    ) as { layers: { root: string }[] };
    const clone = config.layers[0]?.root;
    if (clone === undefined) throw new Error('expected managed clone');
    await writeFile(join(clone, 'home/config'), 'local\n');
    await runGit(['add', '--all'], { cwd: clone, env });
    await runGit(['commit', '--message', 'Local advance'], { cwd: clone, env });

    await writeFile(join(base.root, 'home/config'), 'remote\n');
    await runGit(['add', '--all'], { cwd: base.root, env: base.env });
    await runGit(['commit', '--message', 'Remote advance'], {
      cwd: base.root,
      env: base.env,
    });
    await runGit(['push', remote, 'main:main'], {
      cwd: base.root,
      env: base.env,
    });

    const errors: string[] = [];
    await expect(
      runCli(['sync', '--target', target], {
        env,
        stderr: (value) => errors.push(value),
      }),
    ).resolves.toBe(1);
    expect(errors.join('')).toContain('REMOTE_DIVERGED');
    expect(await readFile(join(clone, 'home/config'), 'utf8')).toBe('local\n');
  });

  it('recovers a checkpointed managed checkout', async () => {
    const sandbox = await createSandbox('sync-recover');
    const env = await createIsolatedEnvironment(sandbox);
    await writeFile(
      env.GIT_CONFIG_GLOBAL ?? join(sandbox, 'gitconfig'),
      '[user]\nname = Test\nemail = test@example.invalid\n',
    );
    const base = await createGitFixture({
      prefix: 'sync-recover-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'original\n',
      },
    });
    const remote = join(sandbox, 'base.git');
    await bareRemote(base.root, remote, base.env);
    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });
    await command(['init', remote, '--target', target], env);
    const stackPath = join(sandbox, 'xdg/config/layerdots/active-stack.json');
    const stack = await readFile(stackPath, 'utf8');
    const clone = (JSON.parse(stack) as { layers: { root: string }[] })
      .layers[0]?.root;
    if (clone === undefined) throw new Error('expected managed clone');
    await writeFile(join(clone, 'home/config'), 'interrupted\n');
    await runGit(['add', '--all'], { cwd: clone, env });
    await runGit(['commit', '--message', 'Interrupted checkout'], {
      cwd: clone,
      env,
    });
    await mkdir(join(sandbox, 'xdg/state/layerdots'), { recursive: true });
    await writeFile(
      join(sandbox, 'xdg/state/layerdots/sync-recovery.json'),
      stack,
    );
    expect(await command(['sync', 'recover', '--target', target], env)).toBe(
      'SYNC RECOVERED\n',
    );
    expect(await readFile(join(clone, 'home/config'), 'utf8')).toBe(
      'original\n',
    );
  });
});
