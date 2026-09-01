import { describe, expect, it } from 'vitest';

import { validateManagedPath } from '../../src/repositories/path-validation.js';

describe('validateManagedPath', () => {
  it.each([
    '',
    '/file',
    '.',
    '..',
    './file',
    '../file',
    'a//b',
    'a/./b',
    'a/../b',
    'a\\b',
    'a\0b',
  ])('rejects %j', (path) => {
    expect(() => validateManagedPath(path)).toThrow();
  });

  it('accepts canonical POSIX home-relative paths', () => {
    expect(validateManagedPath('.config/nvim/init.lua')).toBe(
      '.config/nvim/init.lua',
    );
  });
});
