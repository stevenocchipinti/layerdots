/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignUnassignedChange } from '../../src/assignment/assign.js';
import { composeLayers } from '../../src/composition/compose.js';
import { calculateProvenance } from '../../src/provenance/provenance.js';
import { detectUnassignedChanges } from '../../src/provenance/unassigned.js';
import { loadLayerSnapshot } from '../../src/repositories/snapshot-loader.js';
import { rebaseOverlay } from '../../src/synchronization/rebase.js';
import { writeConflictWorkspace } from '../../src/synchronization/conflict-workspace.js';
import { runCli } from '../../src/cli/main.js';
import type { ManagedObject } from '../../src/domain/objects.js';
import { createGitFixture } from '../support/git.js';
import { createSandbox } from '../support/sandbox.js';

const text = (object: ManagedObject | undefined): string => {
  if (!object || object.kind !== 'file') throw new Error('expected text file');
  return new TextDecoder().decode(object.content);
};
const file = (value: string): ManagedObject => ({
  kind: 'file',
  content: new TextEncoder().encode(value),
  executable: false,
});

describe('Milestone 1 acceptance', () => {
  it('composes, assigns, rebases, isolates conflicts, and never writes live target', async () => {
    const baseFixture = await createGitFixture({
      prefix: 'm1-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'public\nkeep\n',
      },
    });
    const overlayFixture = await createGitFixture({
      prefix: 'm1-overlay',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: {
            url: baseFixture.root,
            branch: 'main',
            commit: baseFixture.head,
          },
        }),
        'home/config.patch':
          '--- a/config\n+++ b/config\n@@ -1,2 +1,2 @@\n public\n-keep\n+private\n',
      },
    });
    const base = await loadLayerSnapshot(baseFixture.root, 'base');
    const overlay = await loadLayerSnapshot(overlayFixture.root, 'overlay');
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    expect(text(composed.objects.get('config'))).toBe('public\nprivate\n');
    const provenance = calculateProvenance(layers, composed);
    expect(provenance.files.get('config')).toMatchObject({
      owner: 'overlay',
      operation: 'patch',
      overridesLower: true,
    });
    expect(provenance.lines.get('config')?.map((line) => line.owner)).toEqual([
      'base',
      'overlay',
    ]);

    const target = new Map([['config', file('public\nlocal\n')]]);
    const targetDirectory = await createSandbox('m1-target');
    await mkdir(join(targetDirectory, 'home'));
    await writeFile(join(targetDirectory, 'home/config'), 'public\nlocal\n');
    const change = detectUnassignedChanges(layers, composed, target)[0];
    if (!change) throw new Error('expected target change');
    expect(
      change.hunks[0]?.edits.some(
        (edit) => edit.kind === 'add' && edit.line.text === 'local',
      ),
    ).toBe(true);
    const overlayAssignment = assignUnassignedChange({
      layers,
      composed,
      change,
      hunkIndexes: [0],
      destinationLayerId: 'overlay',
    });
    expect(
      text(
        composeLayers(
          overlayAssignment.layers[0]!,
          overlayAssignment.layers.slice(1),
        ).objects.get('config'),
      ),
    ).toBe('public\nlocal\n');

    const baseTarget = new Map([['config', file('changed\nprivate\n')]]);
    const baseChange = detectUnassignedChanges(layers, composed, baseTarget)[0];
    if (!baseChange) throw new Error('expected base target change');
    const baseAssignment = assignUnassignedChange({
      layers,
      composed,
      change: baseChange,
      hunkIndexes: [0],
      destinationLayerId: 'base',
    });
    expect(text(baseAssignment.layers[0]!.objects.get('config'))).not.toContain(
      'private',
    );
    expect(
      text(
        composeLayers(
          baseAssignment.layers[0]!,
          baseAssignment.layers.slice(1),
        ).objects.get('config'),
      ),
    ).toBe('changed\nprivate\n');

    const oldParent = {
      ...base,
      objects: new Map([['config', file('public\nkeep\n')]]),
    };
    const nextParent = {
      ...base,
      id: 'next',
      objects: new Map([['config', file('parent\npublic\nkeep\n')]]),
    };
    const rebased = rebaseOverlay(oldParent, overlay, nextParent, {
      url: 'base',
      branch: 'main',
      commit: 'a'.repeat(40),
    });
    expect(rebased.conflicts).toHaveLength(0);
    expect(rebased.candidate?.manifest.parent?.commit).toBe('a'.repeat(40));
    expect(
      text(
        composeLayers(nextParent, [rebased.candidate!]).objects.get('config'),
      ),
    ).toBe('parent\npublic\nprivate\n');

    const overlap = rebaseOverlay(
      oldParent,
      overlay,
      {
        ...nextParent,
        objects: new Map([['config', file('public\nother\n')]]),
      },
      { url: 'base', branch: 'main', commit: 'b'.repeat(40) },
    );
    expect(overlap.candidate).toBeUndefined();
    const sandbox = await createSandbox('m1-conflict');
    const workspaceRoot = join(sandbox, 'workspaces');
    await mkdir(workspaceRoot);
    const workspace = await writeConflictWorkspace({
      workspaceRoot,
      transactionId: 'm1',
      conflicts: overlap.conflicts,
      allowedSandboxRoot: sandbox,
    });
    expect(await readFile(join(workspace, 'config/base'), 'utf8')).toContain(
      'keep',
    );
    expect(
      await readFile(join(workspace, 'config/conflict'), 'utf8'),
    ).toContain('<<<<<<<');
    expect(text(composed.objects.get('config'))).toBe('public\nprivate\n');
    expect(await readFile(join(targetDirectory, 'home/config'), 'utf8')).toBe(
      'public\nlocal\n',
    );
    const cliOutput: string[] = [];
    expect(
      await runCli(
        [
          'inspect',
          '--base',
          baseFixture.root,
          '--overlay',
          overlayFixture.root,
          '--target',
          targetDirectory,
          '--color',
          'never',
        ],
        { stdout: (value) => cliOutput.push(value), cwd: process.cwd() },
      ),
    ).toBe(0);
    expect(cliOutput.join('')).toContain('UNASSIGNED');
  });
});
