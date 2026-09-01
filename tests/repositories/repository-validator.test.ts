import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateRepository } from '../../src/repositories/repository-validator.js';
import { createSandbox } from '../support/sandbox.js';

async function repository(
  manifest: object,
  entries: Record<string, string | null> = {},
): Promise<string> {
  const root = await createSandbox('repository');
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'layerdots.json'), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(entries)) {
    const target = join(root, 'home', path);
    await mkdir(dirname(target), { recursive: true });
    if (content !== null) await writeFile(target, content);
  }
  return root;
}

const overlay = {
  version: 1,
  parent: { url: 'base', branch: 'main', commit: 'b'.repeat(40) },
};

describe('validateRepository', () => {
  it('validates a base and returns normalized representations', async () => {
    const root = await repository(
      { version: 1 },
      { '.gitconfig': 'x', '.config/tool': 'y' },
    );
    await expect(validateRepository(root)).resolves.toMatchObject({
      role: 'base',
      representations: ['.config/tool', '.gitconfig'],
    });
  });

  it('rejects contradictory, nested, and reserved representations', async () => {
    for (const entries of [
      { settings: 'x', 'settings.patch': 'diff' },
      { 'config.patch': 'diff', 'config/key': 'y' },
      { 'literal.patch.patch': 'x' },
    ]) {
      const root = await repository(overlay, entries);
      await expect(validateRepository(root)).rejects.toBeInstanceOf(Error);
    }
  });

  it('allows reserved suffixes as literal base paths', async () => {
    const base = await repository(
      { version: 1 },
      { 'settings.patch': 'literal', 'old.delete': 'literal' },
    );
    await expect(validateRepository(base)).resolves.toMatchObject({
      representations: ['old.delete', 'settings.patch'],
    });
  });

  it('rejects nonempty overlay tombstones', async () => {
    const invalid = await repository(overlay, {
      'settings.delete': 'not empty',
    });
    await expect(validateRepository(invalid)).rejects.toMatchObject({
      code: 'TOMBSTONE_INVALID',
    });
  });

  it('enforces tree path, collision, and object validation', async () => {
    const root = await repository({ version: 1 });
    await mkdir(join(root, 'home', 'empty'));
    await expect(validateRepository(root)).rejects.toMatchObject({
      code: 'unsupported-object',
    });
  });

  it('does not follow symlinked home entries', async () => {
    const root = await repository({ version: 1 });
    const outside = await createSandbox('home-target');
    await writeFile(join(outside, 'secret'), 'private');
    await symlink(join(outside, 'secret'), join(root, 'home', 'secret'));
    await expect(validateRepository(root)).resolves.toMatchObject({
      representations: ['secret'],
    });
  });
});
