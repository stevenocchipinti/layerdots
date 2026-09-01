import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LayerdotsError } from '../../src/domain/errors.js';
import { readManifest } from '../../src/repositories/manifest-reader.js';
import { createSandbox } from '../support/sandbox.js';

async function repository(manifest: string): Promise<string> {
  const root = await createSandbox('manifest');
  await mkdir(join(root, 'home'));
  await writeFile(join(root, 'layerdots.json'), manifest);
  return root;
}

describe('readManifest', () => {
  it('reads a base and infers its role through the domain contract', async () => {
    const root = await repository('{"version":1}');
    await expect(readManifest(root)).resolves.toEqual({ version: 1 });
  });

  it('accepts full SHA-1 and SHA-256 parent object IDs', async () => {
    const root = await repository(
      JSON.stringify({
        version: 1,
        parent: {
          url: 'https://example.test/base',
          branch: 'main',
          commit: 'a'.repeat(64),
        },
      }),
    );
    await expect(readManifest(root)).resolves.toMatchObject({
      parent: { commit: 'a'.repeat(64) },
    });
  });

  it('rejects unknown keys, malformed versions, and partial parent references', async () => {
    for (const manifest of [
      '{"version":1,"extra":true}',
      '{"version":2}',
      '{"version":1,"parent":{"url":"u","branch":"main","commit":"abc"}}',
    ]) {
      const root = await repository(manifest);
      await expect(readManifest(root)).rejects.toMatchObject({
        name: 'LayerdotsError',
      });
    }
  });

  it('does not follow a symlinked manifest', async () => {
    const root = await createSandbox('manifest-link');
    await mkdir(join(root, 'home'));
    const outside = await createSandbox('manifest-target');
    await writeFile(join(outside, 'manifest.json'), '{"version":1}');
    await symlink(join(outside, 'manifest.json'), join(root, 'layerdots.json'));
    await expect(readManifest(root)).rejects.toMatchObject({
      code: 'MANIFEST_SYMLINK',
    } satisfies Partial<LayerdotsError>);
  });
});
