import { LayerdotsError } from '../domain/errors.js';
import type { ManagedPath } from '../domain/objects.js';

/** Validate and return the canonical POSIX spelling of a managed path. */
export function validateManagedPath(path: string): ManagedPath {
  if (path.length === 0) {
    throw new LayerdotsError('Managed path must not be empty', 'invalid-path');
  }
  if (path.includes('\0')) {
    throw new LayerdotsError(
      'Managed path must not contain NUL',
      'invalid-path',
    );
  }
  if (path.includes('\\')) {
    throw new LayerdotsError(
      'Managed path must not contain backslashes',
      'invalid-path',
    );
  }
  if (path.startsWith('/')) {
    throw new LayerdotsError(
      'Managed path must be home-relative',
      'invalid-path',
    );
  }

  const components = path.split('/');
  if (
    components.some(
      (component) =>
        component.length === 0 || component === '.' || component === '..',
    )
  ) {
    throw new LayerdotsError(
      `Managed path is not canonical: ${path}`,
      'invalid-path',
    );
  }

  return path;
}
