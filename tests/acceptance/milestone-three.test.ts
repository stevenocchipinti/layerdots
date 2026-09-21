import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { runGit } from '../../src/repositories/git.js';
import { createGitFixture } from '../support/git.js';
import {
  createSandbox,
  createIsolatedEnvironment,
} from '../support/sandbox.js';

async function bareRemote(
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runGit(['branch', '--move', 'main'], { cwd: source, env });
  await runGit(['clone', '--bare', '--quiet', source, destination], { env });
}

describe('Milestone 3 acceptance', () => {
  it('initializes a pinned stack from bare remotes and applies it through XDG state', async () => {
    const sandbox = await createSandbox('m3-lifecycle');
    const env = await createIsolatedEnvironment(sandbox);
    const base = await createGitFixture({
      prefix: 'm3-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.gitconfig': '[user]\nname = Base\n',
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);

    const overlay = await createGitFixture({
      prefix: 'm3-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: baseRemote, branch: 'main', commit: base.head },
        }),
        'home/.gitconfig.patch': `--- a/.gitconfig
+++ b/.gitconfig
@@ -1,2 +1,2 @@
 [user]
-name = Base
+name = Overlay
`,
      },
    });
    const overlayRemote = join(sandbox, 'overlay.git');
    await bareRemote(overlay.root, overlayRemote, overlay.env);

    const target = join(sandbox, 'target');
    await mkdir(join(target, 'home'), { recursive: true });
    const output: string[] = [];
    await expect(
      runCli(['init', overlayRemote, '--target', target], {
        env,
        stdout: (value) => output.push(value),
      }),
    ).resolves.toBe(0);
    expect(output.join('')).toContain(`INITIALIZED TARGET ${resolve(target)}`);

    const inspect: string[] = [];
    await expect(
      runCli(['inspect', '--target', target], {
        env,
        stdout: (value) => inspect.push(value),
      }),
    ).resolves.toBe(0);
    expect(inspect.join('')).toContain('OWNER overlay-1');

    await expect(runCli(['apply', '--target', target], { env })).resolves.toBe(
      0,
    );
    expect(await readFile(join(target, 'home/.gitconfig'), 'utf8')).toBe(
      '[user]\nname = Overlay\n',
    );
    await access(join(sandbox, 'xdg/state/layerdots/default.json'));
  });

  it('rejects initialization when a managed clone is dirty', async () => {
    const sandbox = await createSandbox('m3-dirty');
    const env = await createIsolatedEnvironment(sandbox);
    const base = await createGitFixture({
      prefix: 'm3-dirty-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/a': 'a\n',
      },
    });
    const baseRemote = join(sandbox, 'base.git');
    await bareRemote(base.root, baseRemote, base.env);
    const overlay = await createGitFixture({
      prefix: 'm3-dirty-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: baseRemote, branch: 'main', commit: base.head },
        }),
        'home/b': 'b\n',
      },
    });
    const overlayRemote = join(sandbox, 'overlay.git');
    await bareRemote(overlay.root, overlayRemote, overlay.env);
    const target = join(sandbox, 'target');

    await expect(
      runCli(['init', overlayRemote, '--target', target], { env }),
    ).resolves.toBe(0);
    const config = JSON.parse(
      await readFile(
        join(sandbox, 'xdg/config/layerdots/active-stack.json'),
        'utf8',
      ),
    ) as { layers: { root: string }[] };
    const overlayLayer = config.layers[1];
    if (overlayLayer === undefined) throw new Error('expected overlay clone');
    await writeFile(join(overlayLayer.root, 'uncommitted'), 'private\n');

    const errors: string[] = [];
    await expect(
      runCli(['init', overlayRemote, '--target', target], {
        env,
        stderr: (value) => errors.push(value),
      }),
    ).resolves.toBe(1);
    expect(errors.join('')).toContain('REPOSITORY_DIRTY');
  });
});
