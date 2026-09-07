import { mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { applyComposition } from '../apply/apply.js';
import { composeLayers } from '../composition/compose.js';
import { loadLayerSnapshot } from '../repositories/snapshot-loader.js';
import type { LayerSnapshot, ManagedPath } from '../domain/objects.js';

export interface ApplyOptions {
  readonly base: string;
  readonly overlays: readonly string[];
  readonly target: string;
  readonly stateDir?: string;
  readonly approve: readonly string[];
  readonly cwd?: string;
}

export async function applyCommand(options: ApplyOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const target = resolvePath(cwd, options.target);
  const stateDir = resolvePath(cwd, options.stateDir ?? '.layerdots/state');
  const workspaceRoot = stateDir;
  const allowedSandboxRoot = resolvePath(stateDir, '..');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const base = await loadLayerSnapshot(resolvePath(cwd, options.base), 'base');
  const overlays: LayerSnapshot[] = [];
  for (const [index, path] of options.overlays.entries()) {
    overlays.push(
      await loadLayerSnapshot(
        resolvePath(cwd, path),
        `overlay-${String(index + 1)}`,
      ),
    );
  }
  const composed = composeLayers(base, overlays);
  const approvals = new Set<ManagedPath>(options.approve);

  const result = await applyComposition({
    targetRoot: target,
    stateDir,
    targetId: 'default',
    composed,
    approvals,
    workspaceRoot,
    allowedSandboxRoot,
  });

  if (result.applied) {
    const lines = ['APPLIED'];
    for (const path of result.written) {
      lines.push(`WRITTEN ${path}`);
    }
    lines.push(`CONFLICTS ${String(result.conflicts.length)}`);
    return `${lines.join('\n')}\n`;
  }

  const lines = ['CONFLICTS'];
  for (const conflict of result.conflicts) {
    lines.push(`CONFLICT ${conflict.path} WORKSPACE ${conflict.workspace}`);
  }
  lines.push(
    'Live files are unchanged. Conflict files are in the workspace directory.',
  );
  return `${lines.join('\n')}\n`;
}
