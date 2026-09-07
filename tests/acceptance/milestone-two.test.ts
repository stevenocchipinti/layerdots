/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyComposition } from '../../src/apply/apply.js';
import { readAppliedState } from '../../src/apply/state.js';
import { composeLayers } from '../../src/composition/compose.js';
import { LayerdotsError } from '../../src/domain/errors.js';
import { equalManagedObjects } from '../../src/domain/objects.js';
import type { ManagedObject } from '../../src/domain/objects.js';
import { loadLayerSnapshot } from '../../src/repositories/snapshot-loader.js';
import { readManagedPaths } from '../../src/repositories/tree-reader.js';
import { createGitFixture } from '../support/git.js';
import { createSandbox } from '../support/sandbox.js';

const text = (object: ManagedObject | undefined): string => {
  if (!object || object.kind !== 'file') throw new Error('expected text file');
  return new TextDecoder().decode(object.content);
};
const file = (value: string, executable = false): ManagedObject => ({
  kind: 'file',
  content: new TextEncoder().encode(value),
  executable,
});
const symlink = (target: string): ManagedObject => ({
  kind: 'symlink',
  target,
});

const BASE_GITCONFIG = `[user]
name = Test
email = test@test.com
theme = dark
`;
const OVERLAY_A_PATCH = `--- a/.gitconfig
+++ b/.gitconfig
@@ -1,4 +1,4 @@
 [user]
 name = Test
-email = test@test.com
+email = overlay@work.dev
 theme = dark
`;
const OVERLAY_B_PATCH = `--- a/.gitconfig
+++ b/.gitconfig
@@ -1,4 +1,4 @@
 [user]
 name = Test
 email = test@test.com
-theme = dark
+theme = light
`;
const PATCHED_LINE1 = `[user]
name = Test
email = overlay@work.dev
theme = dark
`;
const PATCHED_LINE4 = `[user]
name = Test
email = test@test.com
theme = light
`;

describe('Milestone 2 acceptance', () => {
  it('safe target application: compose, apply, three-way merge, conflict isolation, type-replacement approval, and unmanaged preservation', async () => {
    // ─── Phase 1: Initial compose + apply ───

    const baseAFixture = await createGitFixture({
      prefix: 'm2-base-a',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/.gitconfig': BASE_GITCONFIG,
        'home/.config/nvim/init.lua': 'return {}\n',
        'home/bin/hello.sh': '#!/bin/sh\necho hello\n',
      },
      executable: ['home/bin/hello.sh'],
    });
    const overlayAFixture = await createGitFixture({
      prefix: 'm2-overlay-a',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: {
            url: baseAFixture.root,
            branch: 'main',
            commit: baseAFixture.head,
          },
        }),
        'home/.gitconfig.patch': OVERLAY_A_PATCH,
        'home/.config/company/config.json': '{"env":"prod"}\n',
      },
    });

    const baseA = await loadLayerSnapshot(baseAFixture.root, 'baseA');
    const overlayA = await loadLayerSnapshot(overlayAFixture.root, 'overlayA');
    const composedA = composeLayers(baseA, [overlayA]);

    // Verify composition
    expect(text(composedA.objects.get('.gitconfig'))).toBe(PATCHED_LINE1);
    expect(text(composedA.objects.get('.config/nvim/init.lua'))).toBe(
      'return {}\n',
    );
    expect(text(composedA.objects.get('.config/company/config.json'))).toBe(
      '{"env":"prod"}\n',
    );
    expect(text(composedA.objects.get('bin/hello.sh'))).toBe(
      '#!/bin/sh\necho hello\n',
    );
    const helloSh = composedA.objects.get('bin/hello.sh')!;
    expect(helloSh.kind).toBe('file');
    if (helloSh.kind === 'file') expect(helloSh.executable).toBe(true);

    // Set up fresh target
    const sandbox = await createSandbox('m2-target');
    const targetRoot = join(sandbox, 'target');
    await mkdir(join(targetRoot, 'home'), { recursive: true });
    const stateDir = join(sandbox, 'state');
    const workspaceRoot = join(sandbox, 'workspaces');
    await mkdir(workspaceRoot);

    // Drop an unmanaged file before first apply
    const unmanagedPath = join(targetRoot, 'home/README-notes.txt');
    const unmanagedContent = 'my personal notes\n';
    await writeFile(unmanagedPath, unmanagedContent);

    const result1 = await applyComposition({
      targetRoot,
      stateDir,
      targetId: 't',
      composed: composedA,
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot: sandbox,
    });

    // Assert apply succeeded
    expect(result1.applied).toBe(true);
    expect(result1.written.length).toBeGreaterThan(0);
    expect(result1.conflicts).toHaveLength(0);

    // Verify on disk via readManagedPaths
    const paths1 = [
      '.gitconfig',
      '.config/nvim/init.lua',
      '.config/company/config.json',
      'bin/hello.sh',
    ];
    const onDisk1 = await readManagedPaths(targetRoot, paths1);
    for (const path of paths1) {
      const disk = onDisk1.get(path)!;
      const composed = composedA.objects.get(path)!;
      expect(equalManagedObjects(disk, composed)).toBe(true);
    }
    expect(text(onDisk1.get('.gitconfig'))).toBe(PATCHED_LINE1);
    expect(text(onDisk1.get('.config/company/config.json'))).toBe(
      '{"env":"prod"}\n',
    );
    expect(text(onDisk1.get('.config/nvim/init.lua'))).toBe('return {}\n');

    // Verify applied state persisted
    const state1 = await readAppliedState(stateDir, 't');
    expect(state1).toBeDefined();
    expect(state1!.objects.size).toBe(composedA.objects.size);
    expect(state1!.deleted.size).toBe(0);
    for (const [path, object] of composedA.objects) {
      expect(equalManagedObjects(state1!.objects.get(path)!, object)).toBe(
        true,
      );
    }

    // Unmanaged file survived first apply
    await access(unmanagedPath);
    expect(await readFile(unmanagedPath, 'utf8')).toBe(unmanagedContent);

    // ─── Phase 2: Simulate local edit + advance base → three-way merge preserves disjoint edits ───

    // Manual local edit: change a base-owned managed file the overlay doesn't touch
    const initLuaPath = join(targetRoot, 'home/.config/nvim/init.lua');
    const localEdit = 'vim.opt.number = true\nreturn {}\n';
    await writeFile(initLuaPath, localEdit);

    // Create a new overlay B that patches a DIFFERENT line (line 4: theme) of the same base A
    const overlayBFixture = await createGitFixture({
      prefix: 'm2-overlay-b',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: {
            url: baseAFixture.root,
            branch: 'main',
            commit: baseAFixture.head,
          },
        }),
        'home/.gitconfig.patch': OVERLAY_B_PATCH,
        'home/.config/company/config.json': '{"env":"prod"}\n',
        'home/.config/company/team.json': '{"team":"core"}\n',
      },
    });
    const overlayB = await loadLayerSnapshot(overlayBFixture.root, 'overlayB');
    const composedB = composeLayers(baseA, [overlayB]);

    // Verify new composition: .gitconfig has line 4 changed, overlay line 1 patch is NOT applied
    expect(text(composedB.objects.get('.gitconfig'))).toBe(PATCHED_LINE4);

    const result2 = await applyComposition({
      targetRoot,
      stateDir,
      targetId: 't',
      composed: composedB,
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot: sandbox,
    });

    // Apply succeeded: non-conflicting parent update + preserved local edit
    expect(result2.applied).toBe(true);
    expect(result2.conflicts).toHaveLength(0);

    // The local edit to init.lua SURVIVED (remote didn't touch it)
    const onDiskInitLua = await readManagedPaths(targetRoot, [
      '.config/nvim/init.lua',
    ]);
    expect(text(onDiskInitLua.get('.config/nvim/init.lua'))).toBe(localEdit);

    // .gitconfig now reflects the advanced overlay B patch (theme changed to light)
    const onDiskGitconfig2 = await readManagedPaths(targetRoot, ['.gitconfig']);
    expect(text(onDiskGitconfig2.get('.gitconfig'))).toBe(PATCHED_LINE4);

    // New overlay B file appeared
    const onDiskTeam = await readManagedPaths(targetRoot, [
      '.config/company/team.json',
    ]);
    expect(text(onDiskTeam.get('.config/company/team.json'))).toBe(
      '{"team":"core"}\n',
    );

    //    company config.json preserved through the re-compose + apply
    const onDiskCompany2 = await readManagedPaths(targetRoot, [
      '.config/company/config.json',
    ]);
    expect(text(onDiskCompany2.get('.config/company/config.json'))).toBe(
      '{"env":"prod"}\n',
    );

    // Unmanaged file still intact
    await access(unmanagedPath);
    expect(await readFile(unmanagedPath, 'utf8')).toBe(unmanagedContent);

    // ─── Phase 3: Conflicting local edit + remote change → live files untouched ───

    // Introduce a LOCAL edit to .gitconfig.  After phase 2 the on-disk value is
    // PATCHED_LINE4 (theme = light).  We change the theme line locally so that the
    // on-disk target now differs from the applied state (the three-way merge base).
    const localGitconfig = PATCHED_LINE4.replace(
      'theme = light',
      'theme = local',
    );
    await writeFile(join(targetRoot, 'home/.gitconfig'), localGitconfig);

    // The applied state (merge base) still records PATCHED_LINE4.
    const statePhase3 = await readAppliedState(stateDir, 't');
    expect(text(statePhase3!.objects.get('.gitconfig'))).toBe(PATCHED_LINE4);
    // The on-disk target now diverges on the theme line.
    expect(
      text(
        (await readManagedPaths(targetRoot, ['.gitconfig'])).get('.gitconfig'),
      ),
    ).toBe(localGitconfig);

    // Save the live .gitconfig bytes for the "unchanged after failed apply" check.
    const preConflictGitconfig = await readFile(
      join(targetRoot, 'home/.gitconfig'),
      'utf8',
    );

    // Construct a remote composition whose result changes the SAME theme line of
    // .gitconfig, but to a different value (theme = remote).  The patch context
    // must match base A's .gitconfig exactly (theme = dark) so it applies cleanly
    // during composition.
    const conflictOverlayPatch = `--- a/.gitconfig
+++ b/.gitconfig
@@ -1,4 +1,4 @@
 [user]
 name = Test
 email = test@test.com
-theme = dark
+theme = remote
`;
    const conflictComposed = composeLayers(baseA, [
      {
        ...overlayA,
        objects: new Map([['.gitconfig.patch', file(conflictOverlayPatch)]]),
      },
    ]);
    // The remote result changed the theme line differently than the local edit.
    expect(text(conflictComposed.objects.get('.gitconfig'))).toContain(
      'theme = remote',
    );

    const result3 = await applyComposition({
      targetRoot,
      stateDir,
      targetId: 't',
      composed: conflictComposed,
      approvals: new Set(),
      workspaceRoot,
      allowedSandboxRoot: sandbox,
    });

    // Apply FAILED: conflict detected
    expect(result3.applied).toBe(false);
    expect(result3.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(result3.written).toHaveLength(0);
    expect(result3.conflicts[0]!.path).toBe('.gitconfig');

    // Conflict workspace exists on disk
    await access(result3.conflicts[0]!.workspace);

    // CRITICAL: live .gitconfig is UNCHANGED from before this apply (last valid target remains active)
    expect(await readFile(join(targetRoot, 'home/.gitconfig'), 'utf8')).toBe(
      preConflictGitconfig,
    );

    // init.lua still has the local edit
    expect(await readFile(initLuaPath, 'utf8')).toBe(localEdit);

    // ─── Phase 4: Type-replacement without approval → throws ───

    // Current state on disk has bin/hello.sh as a regular file.  Compose a new
    // composition (based on overlay B so .gitconfig stays PATCHED_LINE4, matching
    // the applied state) that replaces bin/hello.sh with a symlink.  Since the
    // only concrete change is the whole-object file→symlink replacement at
    // bin/hello.sh, the three-way merge cleanly produces the symlink and the apply
    // hits the type-replacement guard.
    const typeReplaceOverlay = {
      ...overlayB,
      objects: new Map([
        ...overlayB.objects,
        ['bin/hello.sh', symlink('/usr/local/bin/hello')],
      ]),
    };
    const typeReplaceComposed = composeLayers(baseA, [typeReplaceOverlay]);
    expect(text(typeReplaceComposed.objects.get('.gitconfig'))).toBe(
      PATCHED_LINE4,
    );
    expect(typeReplaceComposed.objects.get('bin/hello.sh')).toEqual(
      symlink('/usr/local/bin/hello'),
    );

    await expect(
      applyComposition({
        targetRoot,
        stateDir,
        targetId: 't',
        composed: typeReplaceComposed,
        approvals: new Set(),
        workspaceRoot,
        allowedSandboxRoot: sandbox,
      }),
    ).rejects.toThrow(LayerdotsError);
    try {
      await applyComposition({
        targetRoot,
        stateDir,
        targetId: 't',
        composed: typeReplaceComposed,
        approvals: new Set(),
        workspaceRoot,
        allowedSandboxRoot: sandbox,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LayerdotsError);
      expect((error as LayerdotsError).code).toBe(
        'type-replacement-requires-approval',
      );
    }

    // Target path is still the original file on disk (unchanged)
    const statsAfterReject = await lstat(join(targetRoot, 'home/bin/hello.sh'));
    expect(statsAfterReject.isFile()).toBe(true);

    // ─── Phase 5: Type-replacement WITH approval → succeeds ───

    const result5 = await applyComposition({
      targetRoot,
      stateDir,
      targetId: 't',
      composed: typeReplaceComposed,
      approvals: new Set(['bin/hello.sh']),
      workspaceRoot,
      allowedSandboxRoot: sandbox,
    });

    expect(result5.applied).toBe(true);
    const statsAfterApproval = await lstat(
      join(targetRoot, 'home/bin/hello.sh'),
    );
    expect(statsAfterApproval.isSymbolicLink()).toBe(true);
    expect(await readlink(join(targetRoot, 'home/bin/hello.sh'))).toBe(
      '/usr/local/bin/hello',
    );

    // ─── Phase 6: Unmanaged file untouched through every apply ───

    await access(unmanagedPath);
    expect(await readFile(unmanagedPath, 'utf8')).toBe(unmanagedContent);
  });
});
