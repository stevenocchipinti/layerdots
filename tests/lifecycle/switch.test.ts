import { describe, expect, it } from 'vitest';

import { composeStack } from '../../src/lifecycle/switch.js';
import { createGitFixture } from '../support/git.js';

describe('stack lifecycle core', () => {
  it('composes every overlay in order', async () => {
    const base = await createGitFixture({
      prefix: 'stack-compose-base',
      files: {
        'layerdots.json': JSON.stringify({ version: 1 }),
        'home/config': 'base\n',
      },
    });
    const first = await createGitFixture({
      prefix: 'stack-compose-first',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: 'base', branch: 'main', commit: base.head },
        }),
        'home/config.patch':
          '--- a/config\n+++ b/config\n@@ -1 +1 @@\n-base\n+first\n',
      },
    });
    const second = await createGitFixture({
      prefix: 'stack-compose-second',
      files: {
        'layerdots.json': JSON.stringify({
          version: 1,
          parent: { url: 'first', branch: 'main', commit: first.head },
        }),
        'home/config.patch':
          '--- a/config\n+++ b/config\n@@ -1 +1 @@\n-first\n+second\n',
      },
    });

    const composed = await composeStack({
      version: 1,
      target: '/sandbox-target',
      layers: [
        { url: 'base', root: base.root, branch: 'main', commit: base.head },
        { url: 'first', root: first.root, branch: 'main', commit: first.head },
        {
          url: 'second',
          root: second.root,
          branch: 'main',
          commit: second.head,
        },
      ],
    });

    const config = composed.objects.get('config');
    expect(config?.kind).toBe('file');
    if (config?.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(config.content).toString('utf8')).toBe('second\n');
  });
});
