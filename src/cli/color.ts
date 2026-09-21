import type { DiffColor } from '../status/diff.js';

export type ColorOption = 'always' | 'auto' | 'never';

export function resolveColor(
  option: ColorOption,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): DiffColor {
  if (option === 'always') return 'always';
  if (option === 'never' || env.NO_COLOR !== undefined) return 'never';
  return isTTY ? 'always' : 'never';
}
