import { applyUnifiedPatch } from '../composition/patch.js';
import { LayerdotsError } from '../domain/errors.js';
import { validateManagedPath } from '../repositories/path-validation.js';
import { splitTextLines, type TextLine } from '../provenance/lines.js';

export function createUnifiedPatch(
  path: string,
  lowerBytes: Uint8Array,
  upperBytes: Uint8Array,
): Uint8Array {
  validateManagedPath(path);
  let oldLines: TextLine[];
  let newLines: TextLine[];
  try {
    oldLines = splitTextLines(lowerBytes);
    newLines = splitTextLines(upperBytes);
  } catch (cause) {
    throw new LayerdotsError(
      'Unified patches require UTF-8 text.',
      'assignment-patch-invalid',
      { cause },
    );
  }
  if (!sameEndingStyle(oldLines, newLines))
    throw new LayerdotsError(
      'Newline conversion cannot be represented by the strict patch parser.',
      'assignment-patch-unrepresentable',
    );
  const patch = new TextEncoder().encode(
    [
      `--- ${oldLines.length === 0 ? '/dev/null' : `a/${path}`}`,
      `+++ ${newLines.length === 0 ? '/dev/null' : `b/${path}`}`,
      `@@ -${oldLines.length === 0 ? '0' : '1'},${String(oldLines.length)} +${newLines.length === 0 ? '0' : '1'},${String(newLines.length)} @@`,
      ...oldLines.flatMap((line) => patchLine('-', line)),
      ...newLines.flatMap((line) => patchLine('+', line)),
      '',
    ].join('\n'),
  );
  let result: Uint8Array;
  try {
    result = applyUnifiedPatch(lowerBytes, patch, path, false).content;
  } catch (cause) {
    throw new LayerdotsError(
      'Generated patch cannot be represented by the strict patch parser.',
      'assignment-patch-unrepresentable',
      { cause },
    );
  }
  if (!Buffer.from(result).equals(Buffer.from(upperBytes)))
    throw new LayerdotsError(
      'Generated patch would change bytes.',
      'assignment-patch-unrepresentable',
    );
  return patch;
}

function patchLine(prefix: '-' | '+', line: TextLine): string[] {
  return line.ending === ''
    ? [`${prefix}${line.text}`, '\\ No newline at end of file']
    : [`${prefix}${line.text}`];
}
function sameEndingStyle(
  oldLines: readonly TextLine[],
  newLines: readonly TextLine[],
): boolean {
  const old = oldLines
    .filter((line) => line.ending !== '')
    .map((line) => line.ending);
  const next = newLines
    .filter((line) => line.ending !== '')
    .map((line) => line.ending);
  return (
    old.length === 0 ||
    next.length === 0 ||
    (old.every((ending) => ending === old[0]) &&
      next.every((ending) => ending === old[0]))
  );
}
