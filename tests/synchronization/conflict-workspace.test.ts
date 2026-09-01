import { homedir } from 'node:os';
import { lstat, mkdir, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeConflictWorkspace } from '../../src/synchronization/conflict-workspace.js';
import { createSandbox } from '../support/sandbox.js';
import type { MergeConflict } from '../../src/synchronization/merge.js';

const conflict: MergeConflict = {
  path: 'config/app',
  base: {
    kind: 'file',
    content: new TextEncoder().encode('base'),
    executable: false,
  },
  ours: {
    kind: 'file',
    content: new TextEncoder().encode('ours'),
    executable: false,
  },
  theirs: {
    kind: 'file',
    content: new TextEncoder().encode('theirs'),
    executable: false,
  },
  text: new TextEncoder().encode('<<<<<<< ours\n'),
};

describe('writeConflictWorkspace', () => {
  it('writes separate objects and preview only below the workspace', async () => {
    const root = await createSandbox('conflicts');
    const workspaceRoot = join(root, 'workspaces');
    await mkdir(workspaceRoot);
    const workspace = await writeConflictWorkspace({
      workspaceRoot,
      transactionId: 'tx-1',
      conflicts: [conflict],
      allowedSandboxRoot: root,
    });
    expect(await readFile(join(workspace, 'config/app/base'), 'utf8')).toBe(
      'base',
    );
    expect(await readFile(join(workspace, 'config/app/ours'), 'utf8')).toBe(
      'ours',
    );
    expect(await readFile(join(workspace, 'config/app/theirs'), 'utf8')).toBe(
      'theirs',
    );
    expect(
      await readFile(join(workspace, 'config/app/conflict'), 'utf8'),
    ).toContain('<<<<<<<');
    expect(resolve(workspace).startsWith(resolve(root))).toBe(true);
  });

  it('rejects actual home, repository root, outside roots, and unsafe transaction ids', async () => {
    const root = await createSandbox('conflict-reject');
    const workspaceRoot = join(root, 'workspaces');
    await mkdir(workspaceRoot);
    for (const workspace of [homedir(), process.cwd(), resolve(root, '..')])
      await expect(
        writeConflictWorkspace({
          workspaceRoot: workspace,
          transactionId: 'tx',
          conflicts: [],
          allowedSandboxRoot: root,
        }),
      ).rejects.toMatchObject({ name: 'LayerdotsError' });
    for (const transactionId of [
      '',
      '.',
      '..',
      '../x',
      '/tmp/x',
      'a/b',
      'a\\b',
    ])
      await expect(
        writeConflictWorkspace({
          workspaceRoot,
          transactionId,
          conflicts: [],
          allowedSandboxRoot: root,
        }),
      ).rejects.toMatchObject({ code: 'invalid-transaction-id' });
  });

  it('rejects symlink roots and parents and duplicate transactions without overwrite', async () => {
    const root = await createSandbox('conflict-links');
    const workspaceRoot = join(root, 'workspaces');
    await mkdir(workspaceRoot);
    const linkedRoot = join(root, 'linked-root');
    await symlink(workspaceRoot, linkedRoot);
    await expect(
      writeConflictWorkspace({
        workspaceRoot: linkedRoot,
        transactionId: 'tx',
        conflicts: [],
        allowedSandboxRoot: root,
      }),
    ).rejects.toMatchObject({ code: 'invalid-workspace-root' });
    await writeConflictWorkspace({
      workspaceRoot,
      transactionId: 'tx',
      conflicts: [conflict],
      allowedSandboxRoot: root,
    });
    await expect(
      writeConflictWorkspace({
        workspaceRoot,
        transactionId: 'tx',
        conflicts: [conflict],
        allowedSandboxRoot: root,
      }),
    ).rejects.toMatchObject({ code: 'conflict-workspace-create-failed' });
    const pathParent = join(workspaceRoot, 'tx2');
    await symlink(root, pathParent);
    await expect(
      writeConflictWorkspace({
        workspaceRoot,
        transactionId: 'tx2',
        conflicts: [conflict],
        allowedSandboxRoot: root,
      }),
    ).rejects.toMatchObject({ code: 'conflict-workspace-create-failed' });
  });

  it('prevalidates collisions and leaves no staging or final workspace', async () => {
    const root = await createSandbox('conflict-atomic');
    const workspaceRoot = join(root, 'workspaces');
    await mkdir(workspaceRoot);
    const invalid = { ...conflict, path: '../escape' };
    await expect(
      writeConflictWorkspace({
        workspaceRoot,
        transactionId: 'tx',
        conflicts: [conflict, invalid],
        allowedSandboxRoot: root,
      }),
    ).rejects.toMatchObject({ code: 'invalid-path' });
    await expect(lstat(join(workspaceRoot, 'tx'))).rejects.toBeDefined();
    await expect(
      lstat(join(workspaceRoot, '.tx.staging')),
    ).rejects.toBeDefined();
    const nested = { ...conflict, path: 'config' };
    await expect(
      writeConflictWorkspace({
        workspaceRoot,
        transactionId: 'tx2',
        conflicts: [conflict, nested],
        allowedSandboxRoot: root,
      }),
    ).rejects.toMatchObject({ code: 'conflict-path-collision' });
    await expect(lstat(join(workspaceRoot, 'tx2'))).rejects.toBeDefined();
  });
});
