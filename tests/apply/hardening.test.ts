import {
  access,
  chmod,
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
import { readManagedPaths } from '../../src/repositories/tree-reader.js';
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

const bytes = (content: number[], executable = false): ManagedObject => ({
  kind: 'file',
  content: new Uint8Array(content),
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
  const root = await createSandbox('hardening');
  await createIsolatedEnvironment(root);
  const stateDir = join(root, 'state/layerdots');
  const workspaceRoot = join(root, 'conflicts');
  await mkdir(workspaceRoot, { recursive: true });
  return {
    root,
    stateDir,
    targetId: 'hard1',
    workspaceRoot,
    allowedSandboxRoot: root,
  };
}

describe('hardening', () => {
  describe('executive bit and line-ending fidelity', () => {
    it('preserves exact bytes for mixed line endings and binary content', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      const crlfContent = Buffer.from('line1\r\nline2\r\n');
      const binaryContent = new Uint8Array([
        0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0xfd,
      ]);

      const composed = composedOf({
        'ascii.txt': file('hello world\n'),
        'crlf.txt': bytes([...crlfContent]),
        'with-newline.txt': file('ends with newline\n'),
        'no-newline.txt': file('no trailing newline'),
        'binary.bin': bytes([...binaryContent]),
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
      expect(result.written).toEqual([
        'ascii.txt',
        'binary.bin',
        'crlf.txt',
        'no-newline.txt',
        'with-newline.txt',
      ]);

      expect(await readFile(join(root, 'home', 'ascii.txt'))).toEqual(
        Buffer.from('hello world\n'),
      );
      expect(await readFile(join(root, 'home', 'crlf.txt'))).toEqual(
        crlfContent,
      );
      expect(await readFile(join(root, 'home', 'with-newline.txt'))).toEqual(
        Buffer.from('ends with newline\n'),
      );
      expect(await readFile(join(root, 'home', 'no-newline.txt'))).toEqual(
        Buffer.from('no trailing newline'),
      );
      expect(await readFile(join(root, 'home', 'binary.bin'))).toEqual(
        Buffer.from(binaryContent),
      );
    });

    it('round-trips executable bits and records them in applied state', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();

      const composed = composedOf({
        'bin/script.sh': file('#!/bin/sh\necho hi\n', true),
        'doc/readonly.txt': file('locked', false),
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

      const scriptMode = (await stat(join(root, 'home', 'bin', 'script.sh')))
        .mode;
      expect((scriptMode & 0o111) !== 0).toBe(true);

      const docMode = (await stat(join(root, 'home', 'doc', 'readonly.txt')))
        .mode;
      expect((docMode & 0o111) === 0).toBe(true);

      const state = await readAppliedState(stateDir, targetId);
      expect(state).toBeDefined();
      const scriptObj = state?.objects.get('bin/script.sh');
      expect(scriptObj?.kind).toBe('file');
      if (scriptObj?.kind === 'file') {
        expect(scriptObj.executable).toBe(true);
      }
      const docObj = state?.objects.get('doc/readonly.txt');
      expect(docObj?.kind).toBe('file');
      if (docObj?.kind === 'file') {
        expect(docObj.executable).toBe(false);
      }
    });

    it('clears the executable bit when overwriting an executable file with a non-executable one', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['script.sh', file('old', true)]]),
        deleted: new Set(),
      });
      await writeFile(join(root, 'home', 'script.sh'), 'old');
      await chmod(join(root, 'home', 'script.sh'), 0o755);

      const composed = composedOf({
        'script.sh': file('new', false),
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
      expect(result.written).toContain('script.sh');
      expect(await readFile(join(root, 'home', 'script.sh'), 'utf8')).toBe(
        'new',
      );
      const mode = (await stat(join(root, 'home', 'script.sh'))).mode;
      expect((mode & 0o111) === 0).toBe(true);

      const state = await readAppliedState(stateDir, targetId);
      const obj = state?.objects.get('script.sh');
      if (obj?.kind === 'file') {
        expect(obj.executable).toBe(false);
      }
    });

    it('idempotent: applying the same composed state twice is a no-op', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      const composed = composedOf({
        '.vimrc': file('set number\n'),
        link: sym('/tmp/dest'),
      });

      const result1 = await applyComposition({
        targetRoot: root,
        stateDir,
        targetId,
        composed,
        approvals: new Set(),
        workspaceRoot,
        allowedSandboxRoot,
      });
      expect(result1.applied).toBe(true);
      expect(result1.written).toEqual(['.vimrc', 'link']);

      const firstBytes = await readFile(join(root, 'home', '.vimrc'));
      const firstLink = await readlink(join(root, 'home', 'link'));

      const result2 = await applyComposition({
        targetRoot: root,
        stateDir,
        targetId,
        composed,
        approvals: new Set(),
        workspaceRoot,
        allowedSandboxRoot,
      });
      expect(result2.applied).toBe(true);
      expect(result2.written).toEqual([]);

      expect(await readFile(join(root, 'home', '.vimrc'))).toEqual(firstBytes);
      expect(await readlink(join(root, 'home', 'link'))).toBe(firstLink);
    });
  });

  describe('unmanaged sibling and unrelated-target preservation', () => {
    it('does not modify unrelated files or dirs when applying managed files', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home', '.config', 'app'), { recursive: true });
      await writeFile(
        join(root, 'home', '.config', 'app', 'settings.json'),
        '{}',
      );
      await writeFile(
        join(root, 'home', '.config', 'unrelated.log'),
        'old log',
      );
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['.config/app/settings.json', file('{}')]]),
        deleted: new Set(),
      });

      const composed = composedOf({
        '.config/app/settings.json': file('{"theme":"dark"}'),
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
      expect(result.written).toEqual(['.config/app/settings.json']);
      expect(
        await readFile(
          join(root, 'home', '.config', 'app', 'settings.json'),
          'utf8',
        ),
      ).toBe('{"theme":"dark"}');
      expect(
        await readFile(join(root, 'home', '.config', 'unrelated.log'), 'utf8'),
      ).toBe('old log');
    });

    it('deletes a managed path while preserving unmanaged siblings in the same parent', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home', '.config', 'myapp'), { recursive: true });
      await writeFile(
        join(root, 'home', '.config', 'myapp', 'managed.cfg'),
        'v1',
      );
      await writeFile(
        join(root, 'home', '.config', 'myapp', 'unmanaged.cfg'),
        'keep',
      );
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['.config/myapp/managed.cfg', file('v1')]]),
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
      expect(result.written).toEqual(['.config/myapp/managed.cfg']);
      await expect(
        access(join(root, 'home', '.config', 'myapp', 'managed.cfg')),
      ).rejects.toThrow();
      expect(
        await readFile(
          join(root, 'home', '.config', 'myapp', 'unmanaged.cfg'),
          'utf8',
        ),
      ).toBe('keep');
      const parentStats = await lstat(join(root, 'home', '.config', 'myapp'));
      expect(parentStats.isDirectory()).toBe(true);
    });

    it('does not remove a post-apply unmanaged file on a subsequent apply', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['managed.txt', file('managed')]]),
        deleted: new Set(),
      });
      await writeFile(join(root, 'home', 'managed.txt'), 'managed');
      await writeFile(join(root, 'home', 'user-note.txt'), 'hand-written');

      const composed = composedOf({ 'managed.txt': file('managed') });

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
      expect(result.written).toEqual([]);
      expect(await readFile(join(root, 'home', 'user-note.txt'), 'utf8')).toBe(
        'hand-written',
      );
      expect(await readFile(join(root, 'home', 'managed.txt'), 'utf8')).toBe(
        'managed',
      );
    });
  });

  describe('security and path escaping', () => {
    it('rejects parent-traversal, absolute, NUL-byte, dot, and double-dot paths', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home'), { recursive: true });

      const badPaths = ['../escape', '/etc/passwd', 'a\0b', 'a/.', 'a/..'];

      for (const bad of badPaths) {
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

    it('rejects case-colliding paths without writing anything', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();

      await expect(
        applyComposition({
          targetRoot: root,
          stateDir,
          targetId,
          composed: composedOf({ Foo: file('a'), foo: file('b') }),
          approvals: new Set(),
          workspaceRoot,
          allowedSandboxRoot,
        }),
      ).rejects.toMatchObject({ code: 'path-collision' });

      await expect(access(join(root, 'home', 'Foo'))).rejects.toThrow();
      await expect(access(join(root, 'home', 'foo'))).rejects.toThrow();
    });

    it('rejects writes through a symlinked parent and does not write through it', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      const outsideTarget = join(root, 'escaped');
      await mkdir(outsideTarget, { recursive: true });
      await writeFile(join(outsideTarget, 'secret.txt'), 'stolen');
      await mkdir(join(root, 'home', 'real-dir'), { recursive: true });
      await symlink(outsideTarget, join(root, 'home', 'link-dir'));

      await expect(
        applyComposition({
          targetRoot: root,
          stateDir,
          targetId,
          composed: composedOf({ 'link-dir/injected.txt': file('bad') }),
          approvals: new Set(),
          workspaceRoot,
          allowedSandboxRoot,
        }),
      ).rejects.toMatchObject({ code: 'target-symlink-parent' });

      expect(await readFile(join(outsideTarget, 'secret.txt'), 'utf8')).toBe(
        'stolen',
      );
      await expect(
        access(join(outsideTarget, 'injected.txt')),
      ).rejects.toThrow();
    });

    it('rejects writing a file over an existing unapproved symlink leaf', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home', 'app'), { recursive: true });
      await symlink('/etc/hostname', join(root, 'home', 'app', 'link'));
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['app/link', sym('/etc/hostname')]]),
        deleted: new Set(),
      });

      await expect(
        applyComposition({
          targetRoot: root,
          stateDir,
          targetId,
          composed: composedOf({ 'app/link': file('override') }),
          approvals: new Set(),
          workspaceRoot,
          allowedSandboxRoot,
        }),
      ).rejects.toMatchObject({ code: 'type-replacement-requires-approval' });

      expect(await readlink(join(root, 'home', 'app', 'link'))).toBe(
        '/etc/hostname',
      );

      const result = await applyComposition({
        targetRoot: root,
        stateDir,
        targetId,
        composed: composedOf({ 'app/link': file('override') }),
        approvals: new Set(['app/link']),
        workspaceRoot,
        allowedSandboxRoot,
      });
      expect(result.applied).toBe(true);
      expect(await readFile(join(root, 'home', 'app', 'link'), 'utf8')).toBe(
        'override',
      );
    });
  });

  describe('type replacement approval matrix', () => {
    it.each([
      ['file→file', 'file', 'file', false],
      ['file→symlink', 'file', 'symlink', true],
      ['symlink→file', 'symlink', 'file', true],
      ['symlink→symlink', 'symlink', 'symlink', false],
      ['absent→file', 'absent', 'file', false],
      ['absent→symlink', 'absent', 'symlink', false],
    ] as const)(
      '%s: existing=%s target=%s needsApproval=%s',
      async (_label, existingKind, targetKind, needsApproval) => {
        const ek: 'file' | 'symlink' | 'absent' = existingKind;
        const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
          await setup();
        await mkdir(join(root, 'home'), { recursive: true });

        if (ek === 'file') {
          await writeFile(join(root, 'home', 'path'), 'existing');
          await writeAppliedState(stateDir, targetId, {
            objects: new Map([['path', file('existing')]]),
            deleted: new Set(),
          });
        } else if (ek === 'symlink') {
          await symlink('target', join(root, 'home', 'path'));
          await writeAppliedState(stateDir, targetId, {
            objects: new Map([['path', sym('target')]]),
            deleted: new Set(),
          });
        } else {
          await writeAppliedState(stateDir, targetId, {
            objects: new Map(),
            deleted: new Set(),
          });
        }

        const targetObj: ManagedObject =
          targetKind === 'symlink' ? sym('/new-target') : file('new content');

        const composed = composedOf({ path: targetObj });

        const input = {
          targetRoot: root,
          stateDir,
          targetId,
          composed,
          workspaceRoot,
          allowedSandboxRoot,
        };

        const withoutApproval = applyComposition({
          ...input,
          approvals: new Set(),
        });

        if (needsApproval) {
          await expect(withoutApproval).rejects.toBeInstanceOf(LayerdotsError);
          await expect(withoutApproval).rejects.toMatchObject({
            code: 'type-replacement-requires-approval',
          });

          if (ek === 'file') {
            expect(await readFile(join(root, 'home', 'path'), 'utf8')).toBe(
              'existing',
            );
          } else if (ek === 'symlink') {
            expect(await readlink(join(root, 'home', 'path'))).toBe('target');
          }
        } else {
          const result = await withoutApproval;
          expect(result.applied).toBe(true);
        }

        const withApproval = await applyComposition({
          ...input,
          approvals: new Set(['path']),
        });
        expect(withApproval.applied).toBe(true);

        if (targetKind === 'symlink') {
          expect(await readlink(join(root, 'home', 'path'))).toBe(
            '/new-target',
          );
        } else {
          expect(await readFile(join(root, 'home', 'path'), 'utf8')).toBe(
            'new content',
          );
        }
      },
    );

    it('managed path resolving to a directory throws unsupported-object', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home', 'path'), { recursive: true });
      await writeFile(join(root, 'home', 'path', 'child.txt'), 'data');
      await writeAppliedState(stateDir, targetId, {
        objects: new Map(),
        deleted: new Set(),
      });

      const input = {
        targetRoot: root,
        stateDir,
        targetId,
        composed: composedOf({ path: file('replaced') }),
        workspaceRoot,
        allowedSandboxRoot,
      };

      await expect(
        applyComposition({ ...input, approvals: new Set() }),
      ).rejects.toMatchObject({ code: 'unsupported-object' });
    });

    it('deleting a managed file does not require approval', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home'), { recursive: true });
      await writeFile(join(root, 'home', 'cfg'), 'old');
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['cfg', file('old')]]),
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
      expect(result.written).toEqual(['cfg']);
      await expect(access(join(root, 'home', 'cfg'))).rejects.toThrow();
    });

    it('deleting managed files inside a directory removes files and preserves the pre-existing parent', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home', 'mydir'), { recursive: true });
      await writeFile(join(root, 'home', 'mydir', 'a'), 'aaa');
      await writeFile(join(root, 'home', 'mydir', 'b'), 'bbb');
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([
          ['mydir/a', file('aaa')],
          ['mydir/b', file('bbb')],
        ]),
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
      expect(result.written).toEqual(['mydir/a', 'mydir/b']);
      await expect(access(join(root, 'home', 'mydir', 'a'))).rejects.toThrow();
      await expect(access(join(root, 'home', 'mydir', 'b'))).rejects.toThrow();
      const parentStats = await lstat(join(root, 'home', 'mydir'));
      expect(parentStats.isDirectory()).toBe(true);
    });
  });

  describe('journal rollback on simulated mid-apply failure', () => {
    it('rolls back all writes when writeAppliedState fails', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home'), { recursive: true });
      await writeFile(join(root, 'home', 'existing.txt'), 'original');
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['existing.txt', file('original')]]),
        deleted: new Set(),
      });
      await writeFile(join(root, 'home', 'unmanaged.log'), 'leave me alone');

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
            'brand-new.txt': file('new'),
          }),
          approvals: new Set(),
          workspaceRoot,
          allowedSandboxRoot,
        }),
      ).rejects.toMatchObject({ code: 'apply-failed' });

      expect(await readFile(join(root, 'home', 'existing.txt'), 'utf8')).toBe(
        'original',
      );
      await expect(
        access(join(root, 'home', 'brand-new.txt')),
      ).rejects.toThrow();
      expect(await readFile(join(root, 'home', 'unmanaged.log'), 'utf8')).toBe(
        'leave me alone',
      );

      const state = await readAppliedState(stateDir, targetId);
      const entry = state?.objects.get('existing.txt');
      expect(entry?.kind).toBe('file');
      if (entry?.kind === 'file') {
        expect(Buffer.from(entry.content).toString()).toBe('original');
      }
    });
  });

  describe('applied-state == target consistency after apply', () => {
    it('applied state matches on-disk target for files, symlinks, and deleted paths', async () => {
      const { root, stateDir, targetId, workspaceRoot, allowedSandboxRoot } =
        await setup();
      await mkdir(join(root, 'home'), { recursive: true });
      await writeFile(join(root, 'home', 'old.txt'), 'obsolete');
      await writeAppliedState(stateDir, targetId, {
        objects: new Map([['old.txt', file('obsolete')]]),
        deleted: new Set(),
      });

      const composed = composedOf({
        'config.json': file('{"key":1}\n'),
        link: sym('/usr/local'),
        'script.sh': file('#!/bin/sh\necho run\n', true),
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

      const state = await readAppliedState(stateDir, targetId);
      expect(state).toBeDefined();
      const appliedState = state as NonNullable<typeof state>;

      const managedPaths = [...appliedState.objects.keys()];
      const onDiskObjects = await readManagedPaths(root, managedPaths);

      for (const [path, expectedObj] of appliedState.objects) {
        const diskObj = onDiskObjects.get(path);
        expect(diskObj).toBeDefined();
        expect(diskObj?.kind).toBe(expectedObj.kind);

        if (expectedObj.kind === 'file' && diskObj?.kind === 'file') {
          expect(Buffer.from(diskObj.content)).toEqual(
            Buffer.from(expectedObj.content),
          );
          expect(diskObj.executable).toBe(expectedObj.executable);
        } else if (
          expectedObj.kind === 'symlink' &&
          diskObj?.kind === 'symlink'
        ) {
          expect(diskObj.target).toBe(expectedObj.target);
        }
      }

      expect(appliedState.deleted.has('old.txt')).toBe(true);
      await expect(access(join(root, 'home', 'old.txt'))).rejects.toThrow();
    });
  });
});
