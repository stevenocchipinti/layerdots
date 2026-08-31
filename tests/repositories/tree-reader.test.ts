import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyFileContent,
  readRepositoryTree,
} from '../../src/repositories/tree-reader.js';
import { createSandbox } from '../support/sandbox.js';

describe('readRepositoryTree', () => {
  it('reads bytes, line endings, executable state, and symlinks literally', async () => {
    const root = await createSandbox('tree-reader');
    await mkdir(join(root, 'home', '.config'), { recursive: true });
    await writeFile(join(root, 'home', 'crlf'), Buffer.from('one\r\ntwo\r\n'));
    await writeFile(
      join(root, 'home', 'no-final-newline'),
      Buffer.from('last'),
    );
    await writeFile(join(root, 'home', 'binary'), Buffer.from([0, 255, 1]));
    await writeFile(join(root, 'home', 'script'), '#!/bin/sh\n');
    await chmod(join(root, 'home', 'script'), 0o755);
    await symlink('../target', join(root, 'home', '.config', 'link'));

    const objects = await readRepositoryTree(root);
    const crlf = objects.get('crlf');
    const binary = objects.get('binary');
    const script = objects.get('script');

    expect(crlf).toMatchObject({ kind: 'file' });
    expect(Buffer.from((crlf as { content: Uint8Array }).content)).toEqual(
      Buffer.from('one\r\ntwo\r\n'),
    );
    expect(
      (objects.get('no-final-newline') as { content: Uint8Array }).content,
    ).toEqual(Buffer.from('last'));
    expect(
      classifyFileContent((binary as { content: Uint8Array }).content),
    ).toBe('binary');
    expect(classifyFileContent((crlf as { content: Uint8Array }).content)).toBe(
      'text',
    );
    expect(script).toMatchObject({ kind: 'file', executable: true });
    expect(objects.get('.config/link')).toEqual({
      kind: 'symlink',
      target: '../target',
    });
  });

  it('rejects case-insensitive collisions', async () => {
    const root = await createSandbox('tree-collision');
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'Config'), 'one');
    await writeFile(join(root, 'home', 'config'), 'two');
    const names = await readdir(join(root, 'home'));
    if (names.length !== 2) {
      return;
    }
    await expect(readRepositoryTree(root)).rejects.toThrow(/collide by case/);
  });

  it('does not follow symlinked directories', async () => {
    const root = await createSandbox('tree-symlink');
    await mkdir(join(root, 'home', 'outside'), { recursive: true });
    await writeFile(join(root, 'home', 'outside', 'secret'), 'secret');
    await symlink('outside', join(root, 'home', 'linked'));
    const objects = await readRepositoryTree(root);
    expect(objects.get('linked')).toEqual({
      kind: 'symlink',
      target: 'outside',
    });
    expect(objects.has('linked/secret')).toBe(false);
  });
});
