import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/repositories/tree-reader.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/repositories/tree-reader.js')
  >('../../src/repositories/tree-reader.js');
  return { ...actual, readRepositoryTree: vi.fn(actual.readRepositoryTree) };
});

import { loadLayerSnapshot } from '../../src/repositories/snapshot-loader.js';
import { createGitFixture } from '../support/git.js';
import { createSandbox } from '../support/sandbox.js';

async function repository(
  manifest: object,
  entries: Record<string, string | null> = {},
): Promise<string> {
  const root = await createSandbox('snapshot');
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'layerdots.json'), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(entries)) {
    const target = join(root, 'home', path);
    await mkdir(dirname(target), { recursive: true });
    if (content !== null) await writeFile(target, content);
  }
  return root;
}

describe('loadLayerSnapshot', () => {
  it('loads a base snapshot with a stable root id and literal objects', async () => {
    const root = await repository({ version: 1 }, { '.gitconfig': 'base' });

    await expect(loadLayerSnapshot(root)).resolves.toMatchObject({
      id: resolve(root),
      root: resolve(root),
      manifest: { version: 1 },
    });
    const snapshot = await loadLayerSnapshot(root, 'base-fixture');
    expect(snapshot.id).toBe('base-fixture');
    expect(snapshot.objects.get('.gitconfig')).toEqual({
      kind: 'file',
      content: Buffer.from('base'),
      executable: false,
    });
  });

  it('loads an overlay manifest and reserved tree objects', async () => {
    const root = await repository(
      {
        version: 1,
        parent: { url: 'base', branch: 'main', commit: 'a'.repeat(40) },
      },
      { '.gitconfig.patch': 'patch', 'old.delete': '' },
    );

    await expect(loadLayerSnapshot(root, 'work')).resolves.toMatchObject({
      id: 'work',
      manifest: {
        parent: { url: 'base', branch: 'main', commit: 'a'.repeat(40) },
      },
    });
  });

  it('loads a committed repository fixture without consulting Git', async () => {
    const fixture = await createGitFixture({
      prefix: 'snapshot-committed',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.config/tool': 'from commit',
      },
    });

    const snapshot = await loadLayerSnapshot(fixture.root);
    expect(snapshot.id).toBe(resolve(fixture.root));
    expect(snapshot.objects.has('.config/tool')).toBe(true);
  });

  it('rejects malformed repositories', async () => {
    const root = await repository({ version: 2 });
    await expect(loadLayerSnapshot(root)).rejects.toMatchObject({
      code: 'MANIFEST_VERSION_UNSUPPORTED',
    });
  });

  it('rejects a symlinked repository root', async () => {
    const actual = await repository({ version: 1 });
    const parent = await createSandbox('snapshot-link');
    const link = join(parent, 'repo');
    await symlink(actual, link);
    await expect(loadLayerSnapshot(link)).rejects.toMatchObject({
      code: 'REPOSITORY_ROOT_INVALID',
    });
  });

  it('rejects a repository mutated during tree loading', async () => {
    const root = await repository({ version: 1 }, { settings: 'before' });
    const treeReader = await import('../../src/repositories/tree-reader.js');
    const actual = await vi.importActual<
      typeof import('../../src/repositories/tree-reader.js')
    >('../../src/repositories/tree-reader.js');
    const reader = vi.mocked(treeReader.readRepositoryTree);
    reader.mockImplementation(async (path) => {
      const objects = await actual.readRepositoryTree(path);
      await appendFile(join(path, 'home', 'settings'), '\n');
      return objects;
    });
    try {
      await expect(loadLayerSnapshot(root)).rejects.toMatchObject({
        code: 'REPOSITORY_CHANGED',
      });
    } finally {
      reader.mockReset();
    }
  });
});
