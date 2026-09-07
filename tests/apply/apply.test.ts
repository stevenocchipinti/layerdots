import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/apply/state.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/apply/state.js')
  >('../../src/apply/state.js');
  return { ...actual, writeAppliedState: vi.fn(actual.writeAppliedState) };
});

import { applyComposition } from '../../src/apply/apply.js';
import { readAppliedState, writeAppliedState } from '../../src/apply/state.js';
import type { ManagedObject, ManagedPath } from '../../src/domain/objects.js';
import { LayerdotsError } from '../../src/domain/errors.js';
import {
  createIsolatedEnvironment,
  createSandbox,
} from '../support/sandbox.js';

const file = (value: string, executable = false): ManagedObject => ({
  kind: 'file',
  content: new TextEncoder().encode(value),
  executable,
});
const sym = (target: string): ManagedObject => ({ kind: 'symlink', target });
const composedOf = (
  entries: Record<string, ManagedObject>,
): { objects: Map<ManagedPath, ManagedObject> } => ({
  objects: new Map(Object.entries(entries)),
});

async function setup(): Promise<{
  root: string;
  stateDir: string;
  targetId: string;
  workspaceRoot: string;
  allowedSandboxRoot: string;
}> {
  const root = await createSandbox('apply');
  await createIsolatedEnvironment(root);
  const stateDir = join(root, 'state/layerdots');
  const workspaceRoot = join(root, 'conflicts');
  await mkdir(workspaceRoot, { recursive: true });
  return {
    root,
    stateDir,
    targetId: 'target1',
    workspaceRoot,
    allowedSandboxRoot: root,
  };
}

async function withEmpty(input: Parameters<typeof applyComposition>[0]) {
  return applyComposition(input);
}

describe('applyComposition', () => {
  it('applies a clean composition with files and a symlink', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    const composed = composedOf({
      '.gitconfig': file('[user]\n  name = alice\n'),
      link: sym('somewhere'),
      'dir/nested.txt': file('nested'),
    });

    const result = await applyComposition({
      targetRoot: root,
      stateDir,
      targetId,
      composed,
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot,
    });

    expect(result.applied).toBe(true);
    expect(result.written).toEqual(['.gitconfig', 'dir/nested.txt', 'link']);
    expect(result.conflicts).toEqual([]);
    expect(await readFile(join(root, 'home', '.gitconfig'), 'utf8')).toBe(
      '[user]\n  name = alice\n',
    );
    expect(await readlink(join(root, 'home', 'link'))).toBe('somewhere');
    expect(
      await readFile(join(root, 'home', 'dir', 'nested.txt'), 'utf8'),
    ).toBe('nested');

    const state = await readAppliedState(stateDir, targetId);
    expect(state).toBeDefined();
    expect(state?.objects.get('link')).toEqual({
      kind: 'symlink',
      target: 'somewhere',
    });
    const gitconfig = state?.objects.get('.gitconfig');
    expect(gitconfig?.kind).toBe('file');
    if (gitconfig?.kind === 'file') {
      expect(Buffer.from(gitconfig.content).toString()).toBe(
        '[user]\n  name = alice\n',
      );
      expect(gitconfig.executable).toBe(false);
    }
    expect(state?.deleted.size).toBe(0);
  });

  it('overwrites an existing managed file and applies its executable bit', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([['.gitconfig', file('v1', false)]]),
      deleted: new Set(),
    });
    await writeFile(join(root, 'home', '.gitconfig'), 'v1');

    const result = await applyComposition({
      targetRoot: root,
      stateDir,
      targetId,
      composed: composedOf({ '.gitconfig': file('v2', true) }),
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot,
    });

    expect(result.applied).toBe(true);
    expect(result.written).toEqual(['.gitconfig']);
    expect(await readFile(join(root, 'home', '.gitconfig'), 'utf8')).toBe('v2');
    const stats = await stat(join(root, 'home', '.gitconfig'));
    expect((stats.mode & 0o111) !== 0).toBe(true);
  });

  it('deletes a managed path absent from the new composition', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([['obsolete.conf', file('old')]]),
      deleted: new Set(),
    });
    await writeFile(join(root, 'home', 'obsolete.conf'), 'old');

    const result = await applyComposition({
      targetRoot: root,
      stateDir,
      targetId,
      composed: composedOf({}),
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot,
    });

    expect(result.applied).toBe(true);
    expect(result.written).toEqual(['obsolete.conf']);
    await expect(access(join(root, 'home', 'obsolete.conf'))).rejects.toThrow();

    const state = await readAppliedState(stateDir, targetId);
    expect(state?.deleted.has('obsolete.conf')).toBe(true);
  });

  it('preserves a disjoint local edit on another managed path', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([
        ['a/b', file('x')],
        ['c/d', file('z')],
      ]),
      deleted: new Set(),
    });
    await mkdir(join(root, 'home', 'a'), { recursive: true });
    await mkdir(join(root, 'home', 'c'), { recursive: true });
    await writeFile(join(root, 'home', 'a', 'b'), 'x');
    await writeFile(join(root, 'home', 'c', 'd'), 'local');

    const result = await applyComposition({
      targetRoot: root,
      stateDir,
      targetId,
      composed: composedOf({
        'a/b': file('y'),
        'c/d': file('z'),
      }),
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot,
    });

    expect(result.applied).toBe(true);
    expect(await readFile(join(root, 'home', 'a', 'b'), 'utf8')).toBe('y');
    expect(await readFile(join(root, 'home', 'c', 'd'), 'utf8')).toBe('local');
  });

  it('does not apply and reports conflicts when base and target diverge', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([['a/b', file('x')]]),
      deleted: new Set(),
    });
    await mkdir(join(root, 'home', 'a'), { recursive: true });
    await writeFile(join(root, 'home', 'a', 'b'), 'local');

    const result = await applyComposition({
      targetRoot: root,
      stateDir,
      targetId,
      composed: composedOf({ 'a/b': file('remote') }),
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot,
    });

    expect(result.applied).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]?.path).toBe('a/b');
    expect(await readFile(join(root, 'home', 'a', 'b'), 'utf8')).toBe('local');

    const workspace = result.conflicts[0]?.workspace;
    expect(workspace).toBeDefined();
    await expect(access(workspace as string)).resolves.toBeUndefined();
  });

  it('requires explicit approval to replace a symlink with a file', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await mkdir(join(root, 'home', '.config'), { recursive: true });
    await symlink('../target', join(root, 'home', '.config', 'app'));
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([['.config/app', sym('../target')]]),
      deleted: new Set(),
    });

    const input = {
      targetRoot: root,
      stateDir,
      targetId,
      composed: composedOf({ '.config/app': file('file content') }),
      workspaceRoot,
      allowedSandboxRoot,
    };

    await expect(
      withEmpty({ ...input, approvals: new Set() }),
    ).rejects.toBeInstanceOf(LayerdotsError);
    await expect(
      withEmpty({ ...input, approvals: new Set() }),
    ).rejects.toMatchObject({ code: 'type-replacement-requires-approval' });
    expect(await readlink(join(root, 'home', '.config', 'app'))).toBe(
      '../target',
    );

    const result = await applyComposition({
      ...input,
      approvals: new Set(['.config/app']),
    });
    expect(result.applied).toBe(true);
    expect(await readFile(join(root, 'home', '.config', 'app'), 'utf8')).toBe(
      'file content',
    );
    const stats = await stat(join(root, 'home', '.config', 'app'));
    expect(stats.isFile()).toBe(true);
  });

  it('rolls the target back when applied-state persistence fails', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([['existing.txt', file('original')]]),
      deleted: new Set(),
    });
    await writeFile(join(root, 'home', 'existing.txt'), 'original');

    vi.mocked(writeAppliedState).mockRejectedValueOnce(
      new Error('simulated disk failure'),
    );

    await expect(
      applyComposition({
        targetRoot: root,
        stateDir,
        targetId,
        composed: composedOf({
          'existing.txt': file('changed'),
          'newfile.txt': file('brand new'),
        }),
        approvals: new Set(),
        workspaceRoot,
        allowedSandboxRoot,
      }),
    ).rejects.toMatchObject({ code: 'apply-failed' });

    expect(await readFile(join(root, 'home', 'existing.txt'), 'utf8')).toBe(
      'original',
    );
    await expect(access(join(root, 'home', 'newfile.txt'))).rejects.toThrow();
  });

  it('rejects unsafe composed paths without touching the target', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await mkdir(join(root, 'home'), { recursive: true });

    for (const bad of ['../escape', '/absolute/path']) {
      await expect(
        applyComposition({
          targetRoot: root,
          stateDir,
          targetId,
          composed: composedOf({ [bad]: file('x') }),
          approvals: new Set(),
          workspaceRoot,
          allowedSandboxRoot,
        }),
      ).rejects.toMatchObject({ code: 'invalid-path' });
    }
  });

  it('rejects case-colliding composed paths', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();

    await expect(
      applyComposition({
        targetRoot: root,
        stateDir,
        targetId,
        composed: composedOf({ Config: file('a'), config: file('b') }),
        approvals: new Set(),
        workspaceRoot,
        allowedSandboxRoot,
      }),
    ).rejects.toMatchObject({ code: 'path-collision' });
  });

  it('rejects applying through a symlinked parent', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await mkdir(join(root, 'home', 'real'), { recursive: true });
    await symlink('real', join(root, 'home', 'linked'));

    await expect(
      applyComposition({
        targetRoot: root,
        stateDir,
        targetId,
        composed: composedOf({ 'linked/file.txt': file('x') }),
        approvals: new Set(),
        workspaceRoot,
        allowedSandboxRoot,
      }),
    ).rejects.toMatchObject({ code: 'target-symlink-parent' });
  });

  it('preserves unmanaged sibling files alongside managed ones', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await mkdir(join(root, 'home', '.config', 'somedir'), { recursive: true });
    await writeFile(join(root, 'home', '.config', 'somedir', 'a'), 'managed a');
    await writeFile(
      join(root, 'home', '.config', 'somedir', 'b'),
      'unmanaged b',
    );
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([['.config/somedir/a', file('managed a')]]),
      deleted: new Set(),
    });

    const result = await applyComposition({
      targetRoot: root,
      stateDir,
      targetId,
      composed: composedOf({ '.config/somedir/a': file('managed a updated') }),
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot,
    });

    expect(result.applied).toBe(true);
    expect(
      await readFile(join(root, 'home', '.config', 'somedir', 'a'), 'utf8'),
    ).toBe('managed a updated');
    expect(
      await readFile(join(root, 'home', '.config', 'somedir', 'b'), 'utf8'),
    ).toBe('unmanaged b');
  });

  it('does not remove a pre-existing parent directory when deleting', async () => {
    const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
      await setup();
    await mkdir(join(root, 'home', '.config', 'somedir'), { recursive: true });
    await writeFile(join(root, 'home', '.config', 'somedir', 'a'), 'managed a');
    await writeFile(
      join(root, 'home', '.config', 'somedir', 'b'),
      'unmanaged b',
    );
    await writeAppliedState(stateDir, targetId, {
      objects: new Map([['.config/somedir/a', file('managed a')]]),
      deleted: new Set(),
    });

    const result = await applyComposition({
      targetRoot: root,
      stateDir,
      targetId,
      composed: composedOf({}),
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot,
    });

    expect(result.applied).toBe(true);
    await expect(
      access(join(root, 'home', '.config', 'somedir', 'a')),
    ).rejects.toThrow();
    expect(
      await readFile(join(root, 'home', '.config', 'somedir', 'b'), 'utf8'),
    ).toBe('unmanaged b');
    const stats = await lstat(join(root, 'home', '.config', 'somedir'));
    expect(stats.isDirectory()).toBe(true);
  });
});
