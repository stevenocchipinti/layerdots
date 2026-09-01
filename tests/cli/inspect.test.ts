import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspect } from '../../src/cli/inspect.js';
import { createGitFixture } from '../support/git.js';
import { createSandbox } from '../support/sandbox.js';

describe('inspect', () => {
  it('reports composition, file metadata, line owners, and target hunks', async () => {
    const base = await createGitFixture({
      prefix: 'cli-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'public\nkeep\n',
      },
    });
    const overlay = await createGitFixture({
      prefix: 'cli-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: base.root, branch: 'main', commit: base.head },
        }),
        'home/config.patch':
          '--- a/config\n+++ b/config\n@@ -1,2 +1,2 @@\n public\n-keep\n+private\n',
      },
    });
    const target = await createSandbox('cli-target');
    await mkdir(join(target, 'home'));
    await writeFile(join(target, 'home/config'), 'public\nlocal\n');

    const output = await inspect({
      base: base.root,
      overlays: [overlay.root],
      target,
      color: 'never',
    });
    expect(output).toContain(
      'PATH config STATUS managed OWNER overlay-1 OPERATION patch OVERRIDE yes DELETED no',
    );
    expect(output).toContain('LINE 1 OWNER base');
    expect(output).toContain('LINE 2 OWNER overlay-1');
    expect(output).toContain('MODIFIED config');
    expect(output).toContain(
      'UNASSIGNED config STATUS modified KIND text-hunks',
    );
    expect(output).toContain('LINE OWNER unassigned +local');
  });

  it('does not consult HOME when target is omitted', async () => {
    const base = await createGitFixture({
      prefix: 'cli-no-target',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'safe\n',
      },
    });
    vi.stubEnv('HOME', join(base.root, 'unreadable-home'));
    try {
      const output = await inspect({
        base: base.root,
        overlays: [],
        color: 'never',
        cwd: process.cwd(),
      });
      expect(output).toContain('PATH config');
      expect(output).not.toContain('TARGET');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not read or report unmanaged target paths', async () => {
    const base = await createGitFixture({
      prefix: 'cli-managed-only',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'expected\n',
      },
    });
    const target = await createSandbox('cli-managed-only-target');
    await mkdir(join(target, 'home', 'unmanaged-empty'), { recursive: true });
    await writeFile(join(target, 'home/config'), 'actual\n');
    await writeFile(join(target, 'home/notes.txt'), 'unmanaged\n');

    const output = await inspect({
      base: base.root,
      overlays: [],
      target,
      color: 'never',
    });

    expect(output).toContain('MODIFIED config');
    expect(output).not.toContain('notes.txt');
    expect(output).not.toContain('unmanaged-empty');
  });

  it('inspects lingering target files masked by tombstones', async () => {
    const base = await createGitFixture({
      prefix: 'cli-tombstone-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/removed': 'old\n',
      },
    });
    const overlay = await createGitFixture({
      prefix: 'cli-tombstone-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: base.root, branch: 'main', commit: base.head },
        }),
        'home/removed.delete': '',
      },
    });
    const target = await createSandbox('cli-tombstone-target');
    await mkdir(join(target, 'home'));
    await writeFile(join(target, 'home/removed'), 'old\n');

    const output = await inspect({
      base: base.root,
      overlays: [overlay.root],
      target,
      color: 'never',
    });

    expect(output).toContain('PATH removed STATUS deleted');
    expect(output).toContain('ADDED removed');
    expect(output).toContain('UNASSIGNED removed STATUS added');
  });
});
