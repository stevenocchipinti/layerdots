import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { main, runCli } from '../../src/cli/main.js';
import { resolveLayerdotsPaths } from '../../src/lifecycle/paths.js';
import { readTransaction } from '../../src/transaction/transaction.js';
import {
  createIsolatedEnvironment,
  createSandbox,
} from '../support/sandbox.js';

describe('main', () => {
  it('prints the current version', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(main(['--version'])).toBe(0);
    expect(write).toHaveBeenCalledWith('layerdots 0.0.0\n');

    write.mockRestore();
  });

  it.each([
    ['unknown', ['inspect', '--base', 'base', '--wat', 'x']],
    [
      'duplicate',
      ['inspect', '--base', 'base', '--target', 'a', '--target', 'b'],
    ],
    ['missing', ['inspect', '--base']],
    ['color', ['inspect', '--base', 'base', '--color', 'rainbow']],
  ])(
    'rejects %s arguments without reading repositories',
    async (_name, args) => {
      const errors: string[] = [];
      await expect(
        runCli(args, {
          stderr: (value) => errors.push(value),
          cwd: '/unreadable',
        }),
      ).resolves.toBe(1);
      expect(errors.join('')).toMatch(/CLI_USAGE/);
    },
  );

  it('uses injected output and cwd seams', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      runCli(['inspect', '--base', 'missing'], {
        cwd: '/unreadable',
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
      }),
    ).resolves.toBe(1);
    expect(output).toEqual([]);
    expect(errors.join('')).toContain('/unreadable');
  });

  it('rejects malformed scripted line selections before reading a stack', async () => {
    const errors: string[] = [];
    await expect(
      runCli(
        [
          'assign',
          'config',
          '--layer',
          'base',
          '--select',
          '1:2:3',
          '--target',
          'target',
        ],
        { cwd: '/unreadable', stderr: (value) => errors.push(value) },
      ),
    ).resolves.toBe(1);
    expect(errors.join('')).toContain('CLI_USAGE');
  });

  it('rejects a transaction whose stored path escapes a layer repository', async () => {
    const sandbox = await createSandbox('transaction-validation');
    const env = await createIsolatedEnvironment(sandbox);
    const paths = resolveLayerdotsPaths(env);
    await mkdir(paths.state, { recursive: true });
    await writeFile(
      join(paths.state, 'transaction.json'),
      JSON.stringify({
        version: 1,
        target: '/target',
        layers: [
          {
            id: 'base',
            url: 'url',
            root: '/root',
            branch: 'main',
            commit: 'commit',
            manifest: { version: 1 },
            objects: [
              {
                path: '../escape',
                kind: 'file',
                content: '',
                executable: false,
              },
            ],
          },
        ],
      }),
    );
    await expect(readTransaction(paths, '/target')).rejects.toMatchObject({
      code: 'TRANSACTION_INVALID',
    });
  });
});
