import { describe, expect, it } from 'vitest';

import { equalManagedObjects } from '../../src/domain/objects.js';

describe('equalManagedObjects', () => {
  it('compares file bytes and executable state', () => {
    const file = {
      kind: 'file' as const,
      content: Uint8Array.from([0, 255]),
      executable: false,
    };

    expect(equalManagedObjects(file, file)).toBe(true);
    expect(equalManagedObjects(file, { ...file, executable: true })).toBe(
      false,
    );
    expect(
      equalManagedObjects(file, {
        ...file,
        content: Uint8Array.from([0, 254]),
      }),
    ).toBe(false);
  });

  it('compares symlink targets without following them', () => {
    expect(
      equalManagedObjects(
        { kind: 'symlink', target: '../shared' },
        { kind: 'symlink', target: '../shared' },
      ),
    ).toBe(true);
  });
});
