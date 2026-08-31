import { describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli/main.js';

describe('main', () => {
  it('prints the current version', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(main(['--version'])).toBe(0);
    expect(write).toHaveBeenCalledWith('layerdots 0.0.0\n');

    write.mockRestore();
  });
});
