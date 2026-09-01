import { describe, expect, it, vi } from 'vitest';

import { main, runCli } from '../../src/cli/main.js';

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
    ['color', ['inspect', '--base', 'base', '--color', 'auto']],
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
});
