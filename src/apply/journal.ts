import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

import { LayerdotsError } from '../domain/errors.js';
import type { ManagedPath } from '../domain/objects.js';
import { validateManagedPath } from '../repositories/path-validation.js';

type JournalEntry =
  | { kind: 'absent' }
  | { kind: 'file'; content: Uint8Array; executable: boolean }
  | { kind: 'symlink'; target: string };

interface JournalRecord {
  readonly path: ManagedPath;
  readonly entry: JournalEntry;
}

export interface Journal {
  readonly records: ReadonlyArray<JournalRecord>;
  readonly existingDirs: ReadonlySet<string>;
}

export async function captureJournal(
  targetRoot: string,
  paths: Iterable<ManagedPath>,
): Promise<Journal> {
  const home = join(targetRoot, 'home');
  await assertRealDirectory(home, 'journal-capture-failed');

  const sorted = [...new Set([...paths])].sort();
  const records: JournalRecord[] = [];
  const existingDirs = new Set<string>();

  for (const candidate of sorted) {
    const path = validateManagedPath(candidate);
    const { entry, dirs } = await capturePath(home, path);
    records.push({ path, entry });
    for (const dir of dirs) existingDirs.add(dir);
  }

  return { records, existingDirs };
}

export async function rollbackJournal(
  targetRoot: string,
  journal: Journal,
): Promise<void> {
  const home = join(targetRoot, 'home');
  const errors: Error[] = [];

  for (const { path, entry } of journal.records) {
    try {
      const absolute = join(home, path);
      const components = path.split('/');

      await removeIfExists(absolute);

      // Remove empty parent directories that were newly created by the apply,
      // from the leaf upward. Never touch directories that existed at capture.
      for (let i = components.length - 2; i >= 0; i--) {
        const dirPath = components.slice(0, i + 1).join('/');
        if (journal.existingDirs.has(dirPath)) break;
        const dir = join(home, ...components.slice(0, i + 1));
        try {
          const stats = await lstat(dir);
          if (!stats.isDirectory() || stats.isSymbolicLink()) break;
          const entries = await readdir(dir);
          if (entries.length > 0) break;
          await rm(dir, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
      }

      if (entry.kind === 'absent') continue;

      const parentDir = join(home, ...components.slice(0, -1));
      await mkdir(parentDir, { recursive: true });

      if (entry.kind === 'file') {
        await writeFileNoFollow(absolute, entry.content, entry.executable);
      } else {
        await symlink(entry.target, absolute);
      }
    } catch (error) {
      if (error instanceof LayerdotsError) errors.push(error);
      else
        errors.push(
          new LayerdotsError(
            `Failed to rollback path: ${path}`,
            'journal-rollback-failed',
            { cause: error instanceof Error ? error : undefined },
          ),
        );
    }
  }

  if (errors.length > 0) {
    const message = errors.map((e) => e.message).join('; ');
    throw new LayerdotsError(
      `Journal rollback failed: ${message}`,
      'journal-rollback-failed',
      { cause: errors[0] },
    );
  }
}

async function capturePath(
  home: string,
  path: ManagedPath,
): Promise<{ entry: JournalEntry; dirs: string[] }> {
  const components = path.split('/');
  const dirs: string[] = [];
  let current = home;

  for (const [index, component] of components.entries()) {
    current = join(current, component);

    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entry: { kind: 'absent' }, dirs };
      }
      throw new LayerdotsError(
        'Cannot inspect managed target path.',
        'journal-capture-failed',
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const leaf = index === components.length - 1;

    if (!leaf) {
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new LayerdotsError(
          'Managed target parent is not a real directory.',
          'journal-symlink-parent',
        );
      dirs.push(components.slice(0, index + 1).join('/'));
      continue;
    }

    if (stats.isSymbolicLink()) {
      const target = await readlink(current, 'utf8');
      return { entry: { kind: 'symlink', target }, dirs };
    }

    if (stats.isFile()) {
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink > 1)
          throw new LayerdotsError(
            'Unsupported managed target object.',
            'journal-capture-failed',
          );
        const content = await handle.readFile();
        const executable = (opened.mode & 0o111) !== 0;
        return { entry: { kind: 'file', content, executable }, dirs };
      } finally {
        await handle.close();
      }
    }

    throw new LayerdotsError(
      'Unsupported managed target object.',
      'journal-capture-failed',
    );
  }

  return { entry: { kind: 'absent' }, dirs };
}

async function assertRealDirectory(path: string, code: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      throw new LayerdotsError('Target home is a symlink.', code);
    if (!stats.isDirectory())
      throw new LayerdotsError('Target home is not a directory.', code);
  } catch (error) {
    if (error instanceof LayerdotsError) throw error;
    throw new LayerdotsError(`Target home is not accessible: ${path}`, code, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

async function removeIfExists(absolute: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    await unlink(absolute);
    return;
  }

  if (stats.isFile()) {
    await unlink(absolute);
    return;
  }

  throw new LayerdotsError(
    'Unsupported object during rollback removal.',
    'journal-rollback-failed',
  );
}

async function writeFileNoFollow(
  absolute: string,
  content: Uint8Array,
  executable: boolean,
): Promise<void> {
  const handle = await open(
    absolute,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.write(content, 0, content.length, 0);
  } finally {
    await handle.close();
  }
  if (executable) await chmod(absolute, 0o755);
  else await chmod(absolute, 0o644);
}
