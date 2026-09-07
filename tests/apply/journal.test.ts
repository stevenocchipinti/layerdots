import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureJournal, rollbackJournal } from '../../src/apply/journal.js';
import { createSandbox } from '../support/sandbox.js';

async function touchFile(
  absolute: string,
  content: string,
  executable = false,
): Promise<void> {
  const handle = await open(
    absolute,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    executable ? 0o755 : 0o644,
  );
  try {
    const data = new TextEncoder().encode(content);
    await handle.write(data, 0, data.length, 0);
  } finally {
    await handle.close();
  }
}

describe('captureJournal', () => {
  it('captures and rolls back an unmodified file byte-identically', async () => {
    const root = await createSandbox('journal-unmod');
    await mkdir(join(root, 'home', 'a', 'b'), { recursive: true });
    await touchFile(join(root, 'home', 'a', 'b', 'file.txt'), 'hello', false);

    const journal = await captureJournal(root, ['a/b/file.txt']);

    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.path).toBe('a/b/file.txt');
    expect(journal.records[0]?.entry.kind).toBe('file');
    const file = journal.records[0]?.entry;
    if (file?.kind === 'file') {
      expect(Buffer.from(file.content).toString()).toBe('hello');
      expect(file.executable).toBe(false);
    }

    await rollbackJournal(root, journal);
    const content = await readFile(
      join(root, 'home', 'a', 'b', 'file.txt'),
      'utf8',
    );
    expect(content).toBe('hello');
    const stats = await stat(join(root, 'home', 'a', 'b', 'file.txt'));
    expect((stats.mode & 0o111) === 0).toBe(true);
  });

  it('captures executable bit correctly', async () => {
    const root = await createSandbox('journal-exec');
    await mkdir(join(root, 'home', 'bin'), { recursive: true });
    await touchFile(join(root, 'home', 'bin', 'run.sh'), '#!/bin/sh\n', true);

    const journal = await captureJournal(root, ['bin/run.sh']);

    expect(journal.records[0]?.path).toBe('bin/run.sh');
    expect(journal.records[0]?.entry.kind).toBe('file');
    const file = journal.records[0]?.entry;
    if (file?.kind === 'file') {
      expect(Buffer.from(file.content).toString()).toBe('#!/bin/sh\n');
      expect(file.executable).toBe(true);
    }

    await rollbackJournal(root, journal);
    const stats = await stat(join(root, 'home', 'bin', 'run.sh'));
    expect((stats.mode & 0o111) !== 0).toBe(true);
  });

  it('captures a symlink as a symlink, not following it', async () => {
    const root = await createSandbox('journal-symlink');
    await mkdir(join(root, 'home', 'dir'), { recursive: true });
    await touchFile(join(root, 'home', 'dir', 'target.txt'), 'real');
    await symlink('dir/target.txt', join(root, 'home', 'link.txt'));

    const journal = await captureJournal(root, ['link.txt']);

    expect(journal.records[0]).toEqual({
      path: 'link.txt',
      entry: { kind: 'symlink', target: 'dir/target.txt' },
    });

    await rollbackJournal(root, journal);
    const target = await readlink(join(root, 'home', 'link.txt'));
    expect(target).toBe('dir/target.txt');
  });

  it('captures absent paths', async () => {
    const root = await createSandbox('journal-absent');
    await mkdir(join(root, 'home'), { recursive: true });

    const journal = await captureJournal(root, ['does/not/exist.txt']);

    expect(journal.records[0]).toEqual({
      path: 'does/not/exist.txt',
      entry: { kind: 'absent' },
    });
  });

  it('rollback removes files created by apply that were absent before', async () => {
    const root = await createSandbox('journal-restore-absent');
    await mkdir(join(root, 'home'), { recursive: true });

    const journal = await captureJournal(root, ['new-file.txt']);

    await touchFile(join(root, 'home', 'new-file.txt'), 'created by apply');

    await rollbackJournal(root, journal);

    await expect(access(join(root, 'home', 'new-file.txt'))).rejects.toThrow();
  });
});

describe('rollback restores mutations', () => {
  it('restores file content changes', async () => {
    const root = await createSandbox('journal-restore-content');
    await mkdir(join(root, 'home', 'cfg'), { recursive: true });
    await touchFile(join(root, 'home', 'cfg', 'config.yaml'), 'original: true');

    const journal = await captureJournal(root, ['cfg/config.yaml']);

    await touchFile(join(root, 'home', 'cfg', 'config.yaml'), 'changed: false');

    await rollbackJournal(root, journal);
    const content = await readFile(
      join(root, 'home', 'cfg', 'config.yaml'),
      'utf8',
    );
    expect(content).toBe('original: true');
  });

  it('restores executable bit change', async () => {
    const root = await createSandbox('journal-restore-exec');
    await mkdir(join(root, 'home', 'bin'), { recursive: true });
    await touchFile(
      join(root, 'home', 'bin', 'script.sh'),
      '#!/bin/sh\n',
      true,
    );

    const journal = await captureJournal(root, ['bin/script.sh']);

    await chmod(join(root, 'home', 'bin', 'script.sh'), 0o644);

    await rollbackJournal(root, journal);
    const stats = await stat(join(root, 'home', 'bin', 'script.sh'));
    expect((stats.mode & 0o111) !== 0).toBe(true);
  });

  it('restores when a file is replaced by a symlink', async () => {
    const root = await createSandbox('journal-file-to-symlink');
    await mkdir(join(root, 'home', 'dir'), { recursive: true });
    await touchFile(join(root, 'home', 'dir', 'target.txt'), 'content');
    await touchFile(join(root, 'home', 'link.txt'), 'file content');

    const journal = await captureJournal(root, ['link.txt']);

    await unlink(join(root, 'home', 'link.txt'));
    await symlink('dir/target.txt', join(root, 'home', 'link.txt'));

    await rollbackJournal(root, journal);

    const content = await readFile(join(root, 'home', 'link.txt'), 'utf8');
    expect(content).toBe('file content');
    const stats = await stat(join(root, 'home', 'link.txt'));
    expect(stats.isFile()).toBe(true);
  });

  it('restores when a symlink is replaced by a file', async () => {
    const root = await createSandbox('journal-symlink-to-file');
    await mkdir(join(root, 'home', 'dir'), { recursive: true });
    await touchFile(join(root, 'home', 'dir', 'target.txt'), 'link target');
    await symlink('dir/target.txt', join(root, 'home', 'link.txt'));

    const journal = await captureJournal(root, ['link.txt']);

    await unlink(join(root, 'home', 'link.txt'));
    await touchFile(join(root, 'home', 'link.txt'), 'replaced with file');

    await rollbackJournal(root, journal);

    const target = await readlink(join(root, 'home', 'link.txt'));
    expect(target).toBe('dir/target.txt');
  });

  it('restores when a new file is added', async () => {
    const root = await createSandbox('journal-restore-new');
    await mkdir(join(root, 'home'), { recursive: true });

    const journal = await captureJournal(root, ['brand-new.txt']);

    await touchFile(join(root, 'home', 'brand-new.txt'), 'new content');

    await rollbackJournal(root, journal);

    await expect(access(join(root, 'home', 'brand-new.txt'))).rejects.toThrow();
  });

  it('restores when a file is deleted', async () => {
    const root = await createSandbox('journal-restore-delete');
    await mkdir(join(root, 'home', 'cfg'), { recursive: true });
    await touchFile(join(root, 'home', 'cfg', 'app.conf'), 'important');

    const journal = await captureJournal(root, ['cfg/app.conf']);

    await unlink(join(root, 'home', 'cfg', 'app.conf'));

    await rollbackJournal(root, journal);

    const content = await readFile(
      join(root, 'home', 'cfg', 'app.conf'),
      'utf8',
    );
    expect(content).toBe('important');
  });

  it('rollback handles multiple paths in one call', async () => {
    const root = await createSandbox('journal-multi');
    await mkdir(join(root, 'home', 'a'), { recursive: true });
    await mkdir(join(root, 'home', 'b'), { recursive: true });
    await touchFile(join(root, 'home', 'a', 'f1.txt'), 'file1');
    await touchFile(join(root, 'home', 'b', 'f2.txt'), 'file2');
    await symlink('a/f1.txt', join(root, 'home', 'link.txt'));

    const journal = await captureJournal(root, [
      'a/f1.txt',
      'b/f2.txt',
      'link.txt',
    ]);

    await touchFile(join(root, 'home', 'a', 'f1.txt'), 'changed1');
    await touchFile(join(root, 'home', 'b', 'f2.txt'), 'changed2');
    await unlink(join(root, 'home', 'link.txt'));
    await touchFile(join(root, 'home', 'link.txt'), 'was a symlink');

    await rollbackJournal(root, journal);

    expect(await readFile(join(root, 'home', 'a', 'f1.txt'), 'utf8')).toBe(
      'file1',
    );
    expect(await readFile(join(root, 'home', 'b', 'f2.txt'), 'utf8')).toBe(
      'file2',
    );
    const linkTarget = await readlink(join(root, 'home', 'link.txt'));
    expect(linkTarget).toBe('a/f1.txt');
  });
});

describe('parent directory cleanup', () => {
  it('removes newly created parent directories during rollback', async () => {
    const root = await createSandbox('journal-new-parents');
    await mkdir(join(root, 'home', 'a'), { recursive: true });

    const journal = await captureJournal(root, ['a/b/c/file.txt']);

    await mkdir(join(root, 'home', 'a', 'b', 'c'), { recursive: true });
    await touchFile(join(root, 'home', 'a', 'b', 'c', 'file.txt'), 'deep');

    await rollbackJournal(root, journal);

    await expect(
      access(join(root, 'home', 'a', 'b', 'c', 'file.txt')),
    ).rejects.toThrow();
    await expect(access(join(root, 'home', 'a', 'b'))).rejects.toThrow();
    const statsA = await lstat(join(root, 'home', 'a'));
    expect(statsA.isDirectory()).toBe(true);
  });

  it('leaves pre-existing sibling files untouched', async () => {
    const root = await createSandbox('journal-sibling');
    await mkdir(join(root, 'home', 'a', 'b'), { recursive: true });
    await touchFile(join(root, 'home', 'a', 'b', 'existing.txt'), 'keep me');

    const journal = await captureJournal(root, ['a/b/new.txt']);

    await touchFile(join(root, 'home', 'a', 'b', 'new.txt'), 'added');

    await rollbackJournal(root, journal);

    const content = await readFile(
      join(root, 'home', 'a', 'b', 'existing.txt'),
      'utf8',
    );
    expect(content).toBe('keep me');
    await expect(
      access(join(root, 'home', 'a', 'b', 'new.txt')),
    ).rejects.toThrow();
  });

  it('does not remove a pre-existing parent that contains other content', async () => {
    const root = await createSandbox('journal-keep-parent');
    await mkdir(join(root, 'home', 'shared'), { recursive: true });
    await touchFile(
      join(root, 'home', 'shared', 'other.txt'),
      'existing content',
    );

    const journal = await captureJournal(root, ['shared/added.txt']);

    await touchFile(join(root, 'home', 'shared', 'added.txt'), 'new content');

    await rollbackJournal(root, journal);

    const other = await readFile(
      join(root, 'home', 'shared', 'other.txt'),
      'utf8',
    );
    expect(other).toBe('existing content');
    await expect(
      access(join(root, 'home', 'shared', 'added.txt')),
    ).rejects.toThrow();
  });
});

describe('unmanaged sibling preservation', () => {
  it('preserves unmanaged files alongside managed ones through capture+rollback', async () => {
    const root = await createSandbox('journal-unmanaged');
    await mkdir(join(root, 'home', 'config'), { recursive: true });
    await touchFile(join(root, 'home', 'config', 'app.ini'), 'managed=true');
    await touchFile(join(root, 'home', 'config', 'secrets.env'), 'SECRET=123');

    const journal = await captureJournal(root, ['config/app.ini']);

    await touchFile(join(root, 'home', 'config', 'app.ini'), 'managed=false');

    await rollbackJournal(root, journal);

    expect(
      await readFile(join(root, 'home', 'config', 'app.ini'), 'utf8'),
    ).toBe('managed=true');
    expect(
      await readFile(join(root, 'home', 'config', 'secrets.env'), 'utf8'),
    ).toBe('SECRET=123');
  });
});

describe('best-effort rollback', () => {
  it('restores other paths even when one path fails', async () => {
    const root = await createSandbox('journal-best-effort');
    await mkdir(join(root, 'home', 'a'), { recursive: true });
    await mkdir(join(root, 'home', 'b'), { recursive: true });
    await touchFile(join(root, 'home', 'a', 'file1.txt'), 'one');
    await touchFile(join(root, 'home', 'b', 'file2.txt'), 'two');

    const journal = await captureJournal(root, ['a/file1.txt', 'b/file2.txt']);

    await touchFile(join(root, 'home', 'a', 'file1.txt'), 'mutated');

    // Sabotage the second path by replacing its parent directory with a file,
    // so rollback of 'b/file2.txt' necessarily fails.
    await rm(join(root, 'home', 'b'), {
      recursive: true,
      force: true,
    });
    await touchFile(join(root, 'home', 'b'), 'blocking file');

    await expect(rollbackJournal(root, journal)).rejects.toMatchObject({
      code: 'journal-rollback-failed',
    });

    expect(await readFile(join(root, 'home', 'a', 'file1.txt'), 'utf8')).toBe(
      'one',
    );
  });
});

describe('validation rejects', () => {
  it('rejects a symlinked parent of a managed path', async () => {
    const root = await createSandbox('journal-symlink-parent');
    await mkdir(join(root, 'home', 'real'), { recursive: true });
    await mkdir(join(root, 'home', 'real', 'deep'), { recursive: true });
    await touchFile(join(root, 'home', 'real', 'deep', 'file.txt'), 'data');
    await symlink('real', join(root, 'home', 'linked'));

    await expect(
      captureJournal(root, ['linked/deep/file.txt']),
    ).rejects.toMatchObject({ code: 'journal-symlink-parent' });
  });

  it('rejects unsafe managed paths via validateManagedPath', async () => {
    const root = await createSandbox('journal-unsafe-paths');
    await mkdir(join(root, 'home'), { recursive: true });

    for (const bad of ['../escape', '/absolute/path', 'has\0null']) {
      await expect(captureJournal(root, [bad])).rejects.toMatchObject({
        name: 'LayerdotsError',
      });
    }
  });

  it('rejects a parent traversal path', async () => {
    const root = await createSandbox('journal-parent-traversal');
    await mkdir(join(root, 'home'), { recursive: true });

    await expect(
      captureJournal(root, ['a/../b/file.txt']),
    ).rejects.toMatchObject({ code: 'invalid-path' });
  });
});
