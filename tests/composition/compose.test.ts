import { describe, expect, it } from 'vitest';

import type { LayerManifestV1 } from '../../src/domain/manifest.js';
import type { LayerSnapshot, ManagedObject } from '../../src/domain/objects.js';
import { composeLayers } from '../../src/composition/compose.js';

const baseManifest: LayerManifestV1 = { version: 1 };
const overlayManifest: LayerManifestV1 = {
  version: 1,
  parent: { url: 'fixture', branch: 'main', commit: 'parent' },
};

function snapshot(
  id: string,
  manifest: LayerManifestV1,
  objects: Record<string, ManagedObject>,
): LayerSnapshot {
  return {
    id,
    root: `/fixture/${id}`,
    manifest,
    objects: new Map(Object.entries(objects)),
  };
}

function file(content: string | Uint8Array, executable = false): ManagedObject {
  return {
    kind: 'file',
    content:
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : new Uint8Array(content),
    executable,
  };
}

describe('composeLayers', () => {
  it('composes additions, replacements, patches, tombstones, and multiple overlays', () => {
    const base = snapshot('base', baseManifest, {
      'config.txt': file('one\ntwo\n'),
      'remove.txt': file('gone'),
      link: { kind: 'symlink', target: 'target' },
      binary: file(new Uint8Array([0, 255])),
    });
    const first = snapshot('work', overlayManifest, {
      'config.txt.patch': file(
        '--- a/config.txt\n+++ b/config.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+WORK\n',
      ),
      'remove.txt.delete': file(''),
      'new.txt': file('new'),
      link: { kind: 'symlink', target: 'work-target' },
    });
    const second = snapshot('top', overlayManifest, {
      'new.txt': file('top', true),
      binary: file(new Uint8Array([1, 2, 3])),
    });

    const result = composeLayers(base, [first, second]);
    expect(text(result.objects.get('config.txt'))).toBe('one\nWORK\n');
    expect(result.objects.has('remove.txt')).toBe(false);
    expect(text(result.objects.get('new.txt'))).toBe('top');
    expect(result.objects.get('new.txt')).toMatchObject({
      kind: 'file',
      executable: true,
    });
    expect(result.objects.get('link')).toEqual({
      kind: 'symlink',
      target: 'work-target',
    });
    expect(result.objects.get('binary')).toEqual({
      kind: 'file',
      content: new Uint8Array([1, 2, 3]),
      executable: false,
    });
    expect(result.metadata.get('config.txt')).toMatchObject({
      layerId: 'work',
      operation: 'patch',
    });
    expect(result.metadata.get('remove.txt')).toMatchObject({
      layerId: 'work',
      operation: 'delete',
    });
    expect(result.metadata.get('new.txt')).toMatchObject({
      layerId: 'top',
      operation: 'replace',
    });
  });

  it('preserves CRLF, missing final newline, and executable state through patches', () => {
    const base = snapshot('base', baseManifest, {
      script: file('one\r\ntwo', true),
    });
    const overlay = snapshot('overlay', overlayManifest, {
      'script.patch': file(
        '--- a/script\n+++ b/script\n@@ -1,2 +1,2 @@\n one\r\n-two\n\\ No newline at end of file\n+THREE\n\\ No newline at end of file\n',
      ),
    });
    const result = composeLayers(base, [overlay]);
    expect(text(result.objects.get('script'))).toBe('one\r\nTHREE');
    expect(result.objects.get('script')).toMatchObject({
      kind: 'file',
      executable: true,
    });
  });

  it('rejects invalid targets, binary patches, missing deletions, and contradictions', () => {
    const base = snapshot('base', baseManifest, {
      text: file('x'),
      link: { kind: 'symlink', target: 'x' },
    });
    expect(() =>
      composeLayers(base, [
        snapshot('o', overlayManifest, { 'missing.delete': file('') }),
      ]),
    ).toThrow(/tombstone/i);
    expect(() =>
      composeLayers(base, [
        snapshot('o', overlayManifest, { 'link.patch': file('x') }),
      ]),
    ).toThrow(/UTF-8 regular file/i);
    expect(() =>
      composeLayers(base, [
        snapshot('o', overlayManifest, {
          'text.patch': file(new Uint8Array([255])),
        }),
      ]),
    ).toThrow(/UTF-8/i);
    expect(() =>
      composeLayers(base, [
        snapshot('o', overlayManifest, {
          text: file('x'),
          'text.patch': file('x'),
        }),
      ]),
    ).toThrow(/Contradictory/i);
    expect(() =>
      composeLayers(base, [
        snapshot('o', overlayManifest, {
          directory: { kind: 'symlink', target: 'x' },
          'directory/file': file('nested'),
        }),
      ]),
    ).toThrow(/Nested|collide/i);
  });

  it('does not mutate snapshots or their byte arrays', () => {
    const baseFile = file('base\n');
    const patchFile = file(
      '--- a/text\n+++ b/text\n@@ -1,1 +1,1 @@\n-base\n+changed\n',
    );
    const base = snapshot('base', baseManifest, { text: baseFile });
    const overlay = snapshot('overlay', overlayManifest, {
      'text.patch': patchFile,
    });
    const beforeBase = new Uint8Array(
      (baseFile as { content: Uint8Array }).content,
    );
    const beforePatch = new Uint8Array(
      (patchFile as { content: Uint8Array }).content,
    );
    const result = composeLayers(base, [overlay]);
    (result.objects.get('text') as { content: Uint8Array }).content[0] = 0;
    expect(baseFile).toMatchObject({ content: beforeBase });
    expect(patchFile).toMatchObject({ content: beforePatch });
    expect((baseFile as { content: Uint8Array }).content).not.toBe(
      (result.objects.get('text') as { content: Uint8Array }).content,
    );
  });
});

function text(object: ManagedObject | undefined): string {
  if (object?.kind !== 'file') throw new Error('expected file');
  return new TextDecoder().decode(object.content);
}
