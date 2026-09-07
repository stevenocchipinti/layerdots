/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it } from 'vitest';
import type { LayerManifestV1 } from '../../src/domain/manifest.js';
import type { LayerSnapshot, ManagedObject } from '../../src/domain/objects.js';
import { composeLayers } from '../../src/composition/compose.js';
import {
  addManagedObject,
  deleteManagedObject,
  unmanageManagedObject,
} from '../../src/assignment/workflows.js';

const file = (
  text: string | Uint8Array,
  executable = false,
): ManagedObject => ({
  kind: 'file',
  content:
    typeof text === 'string'
      ? new TextEncoder().encode(text)
      : new Uint8Array(text),
  executable,
});
const symlink = (target: string): ManagedObject => ({
  kind: 'symlink',
  target,
});
const baseManifest: LayerManifestV1 = { version: 1 };
const overlayManifest: LayerManifestV1 = {
  version: 1,
  parent: { url: 'x', branch: 'main', commit: 'x' },
};
const snapshot = (
  id: string,
  manifest: LayerManifestV1,
  objects: Record<string, ManagedObject>,
): LayerSnapshot => ({
  id,
  root: '.',
  manifest,
  objects: new Map(Object.entries(objects)),
});
const text = (object: ManagedObject | undefined) =>
  object?.kind === 'file'
    ? new TextDecoder().decode(object.content)
    : undefined;

describe('addManagedObject', () => {
  it('adds a brand-new file to the base', () => {
    const base = snapshot('base', baseManifest, { other: file('keep\n') });
    const composed = composeLayers(base);
    const before = new Map(composed.objects);
    const result = addManagedObject({
      layers: [base],
      composed,
      path: 'config',
      object: file('hello\n'),
      destinationLayerId: 'base',
    });
    const after = composeLayers(result.layers[0]!, []);
    expect(text(after.objects.get('config'))).toBe('hello\n');
    expect(text(after.objects.get('other'))).toBe('keep\n');
    expect(result.invalidatedParentPins).toEqual([]);
    expect(before.size).toBe(1);
  });

  it('adds a new file to the overlay', () => {
    const base = snapshot('base', baseManifest, {});
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = addManagedObject({
      layers,
      composed,
      path: 'config',
      object: file('overlay-value\n'),
      destinationLayerId: 'work',
    });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(text(after.objects.get('config'))).toBe('overlay-value\n');
    expect(result.invalidatedParentPins).toEqual([]);
  });

  it('adds a symlink', () => {
    const base = snapshot('base', baseManifest, {});
    const composed = composeLayers(base);
    const result = addManagedObject({
      layers: [base],
      composed,
      path: 'link',
      object: symlink('/usr/bin/tool'),
      destinationLayerId: 'base',
    });
    const after = composeLayers(result.layers[0]!, []);
    const link = after.objects.get('link');
    expect(link).toEqual({ kind: 'symlink', target: '/usr/bin/tool' });
  });

  it('is a no-op when adding an equal object to the base', () => {
    const base = snapshot('base', baseManifest, { config: file('val\n') });
    const composed = composeLayers(base);
    const result = addManagedObject({
      layers: [base],
      composed,
      path: 'config',
      object: file('val\n'),
      destinationLayerId: 'base',
    });
    expect(text(result.layers[0]!.objects.get('config'))).toBe('val\n');
  });

  it('throws operation-conflict when adding a different value over an existing path', () => {
    const base = snapshot('base', baseManifest, { config: file('original\n') });
    const composed = composeLayers(base);
    expect(() =>
      addManagedObject({
        layers: [base],
        composed,
        path: 'config',
        object: file('different\n'),
        destinationLayerId: 'base',
      }),
    ).toThrow(expect.objectContaining({ code: 'operation-conflict' }));
  });

  it('regenerates an overlay patch when adding to the base below it', () => {
    const base = snapshot('base', baseManifest, {
      config: file('public\nkeep\n'),
    });
    const overlay = snapshot('work', overlayManifest, {
      'config.patch': file(
        '--- a/config\n+++ b/config\n@@ -1,2 +1,2 @@\n public\n-keep\n+private\n',
      ),
    });
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = addManagedObject({
      layers,
      composed,
      path: 'config',
      object: file('public\nnew\n'),
      destinationLayerId: 'base',
    });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(text(after.objects.get('config'))).toBe('public\nprivate\n');
    expect(after.objects.get('config')).toBeDefined();
    const overlayObj = result.layers[1]!.objects.get('config.patch');
    expect(overlayObj).toBeDefined();
    expect(overlayObj!.kind).toBe('file');
  });

  it('adds to the top overlay', () => {
    const base = snapshot('base', baseManifest, {
      config: file('base-value\n'),
    });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = addManagedObject({
      layers,
      composed,
      path: 'new-file',
      object: file('overlay-value\n'),
      destinationLayerId: 'work',
    });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(text(after.objects.get('new-file'))).toBe('overlay-value\n');
    expect(text(after.objects.get('config'))).toBe('base-value\n');
  });

  it('throws operation-invalid for an unknown destination layer', () => {
    const base = snapshot('base', baseManifest, {});
    const composed = composeLayers(base);
    expect(() =>
      addManagedObject({
        layers: [base],
        composed,
        path: 'config',
        object: file('v'),
        destinationLayerId: 'missing',
      }),
    ).toThrow(expect.objectContaining({ code: 'operation-invalid' }));
  });
});

describe('deleteManagedObject', () => {
  it('adds a tombstone to the top overlay', () => {
    const base = snapshot('base', baseManifest, {
      config: file('val\n'),
      other: file('keep\n'),
    });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = deleteManagedObject({ layers, composed, path: 'config' });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(after.objects.has('config')).toBe(false);
    expect(text(after.objects.get('other'))).toBe('keep\n');
    const topOverlay = result.layers[result.layers.length - 1]!;
    const tombstone = topOverlay.objects.get('config.delete');
    expect(tombstone).toBeDefined();
    expect(tombstone!.kind).toBe('file');
    if (tombstone!.kind === 'file') expect(tombstone!.content.length).toBe(0);
  });

  it('preserves all other managed paths', () => {
    const base = snapshot('base', baseManifest, {
      a: file('1\n'),
      b: file('2\n'),
      c: file('3\n'),
    });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = deleteManagedObject({ layers, composed, path: 'b' });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(text(after.objects.get('a'))).toBe('1\n');
    expect(after.objects.has('b')).toBe(false);
    expect(text(after.objects.get('c'))).toBe('3\n');
  });

  it('throws operation-conflict for an unmanaged path', () => {
    const base = snapshot('base', baseManifest, {});
    const composed = composeLayers(base);
    expect(() =>
      deleteManagedObject({ layers: [base], composed, path: 'missing' }),
    ).toThrow(expect.objectContaining({ code: 'operation-conflict' }));
  });

  it('invalidatedParentPins is empty for delete', () => {
    const base = snapshot('base', baseManifest, { config: file('v\n') });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = deleteManagedObject({ layers, composed, path: 'config' });
    expect(result.invalidatedParentPins).toEqual([]);
  });
});

describe('unmanageManagedObject', () => {
  it('removes a base path from management', () => {
    const base = snapshot('base', baseManifest, {
      config: file('val\n'),
      other: file('keep\n'),
    });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = unmanageManagedObject({ layers, composed, path: 'config' });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(after.objects.has('config')).toBe(false);
    expect(text(after.objects.get('other'))).toBe('keep\n');
    expect(result.layers[0]!.objects.has('config')).toBe(false);
  });

  it('removes an overlay patch for the path', () => {
    const base = snapshot('base', baseManifest, {
      config: file('base-value\n'),
    });
    const overlay = snapshot('work', overlayManifest, {
      'config.patch': file(
        '--- a/config\n+++ b/config\n@@ -1 +1 @@\n-base-value\n+patched\n',
      ),
    });
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = unmanageManagedObject({ layers, composed, path: 'config' });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(after.objects.has('config')).toBe(false);
    expect(result.layers[1]!.objects.has('config.patch')).toBe(false);
  });

  it('removes an overlay tombstone for the path', () => {
    const base = snapshot('base', baseManifest, {
      config: file('val\n'),
      other: file('keep\n'),
    });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const deleted = deleteManagedObject({ layers, composed, path: 'config' });
    const afterDelete = composeLayers(
      deleted.layers[0]!,
      deleted.layers.slice(1),
    );
    expect(afterDelete.objects.has('config')).toBe(false);
    const result = unmanageManagedObject({
      layers: deleted.layers,
      composed: afterDelete,
      path: 'config',
    });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(after.objects.has('config')).toBe(false);
    expect(result.layers[0]!.objects.has('config')).toBe(false);
    expect(result.layers[1]!.objects.has('config.delete')).toBe(false);
    expect(text(after.objects.get('other'))).toBe('keep\n');
  });

  it('preserves unrelated overlay patches', () => {
    const base = snapshot('base', baseManifest, {
      config: file('val\n'),
      other: file('base-other\n'),
    });
    const overlay = snapshot('work', overlayManifest, {
      'other.patch': file(
        '--- a/other\n+++ b/other\n@@ -1 +1 @@\n-base-other\n+overlay-other\n',
      ),
    });
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = unmanageManagedObject({ layers, composed, path: 'config' });
    const after = composeLayers(result.layers[0]!, result.layers.slice(1));
    expect(after.objects.has('config')).toBe(false);
    expect(text(after.objects.get('other'))).toBe('overlay-other\n');
    expect(result.layers[1]!.objects.has('other.patch')).toBe(true);
  });

  it('throws operation-conflict for a path not in the composition', () => {
    const base = snapshot('base', baseManifest, {});
    const composed = composeLayers(base);
    expect(() =>
      unmanageManagedObject({
        layers: [base],
        composed,
        path: 'missing',
      }),
    ).toThrow(expect.objectContaining({ code: 'operation-conflict' }));
  });

  it('invalidatedParentPins includes all overlays', () => {
    const base = snapshot('base', baseManifest, {
      config: file('val\n'),
    });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const result = unmanageManagedObject({ layers, composed, path: 'config' });
    expect(result.invalidatedParentPins).toEqual(['work']);
  });
});

describe('path validation', () => {
  it('rejects unsafe paths with invalid-path', () => {
    const base = snapshot('base', baseManifest, {});
    const composed = composeLayers(base);
    expect(() =>
      addManagedObject({
        layers: [base],
        composed,
        path: '../escape',
        object: file('v'),
        destinationLayerId: 'base',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-path' }));
    expect(() =>
      deleteManagedObject({
        layers: [base],
        composed,
        path: '../escape',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-path' }));
    expect(() =>
      unmanageManagedObject({
        layers: [base],
        composed,
        path: '../escape',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-path' }));
  });

  it('rejects NUL bytes in path', () => {
    const base = snapshot('base', baseManifest, {});
    const composed = composeLayers(base);
    expect(() =>
      addManagedObject({
        layers: [base],
        composed,
        path: 'bad\0path',
        object: file('v'),
        destinationLayerId: 'base',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-path' }));
  });
});

describe('invariant and non-mutation', () => {
  it('does not throw workflow-invariant-broken for legitimate operations', () => {
    const base = snapshot('base', baseManifest, { config: file('v\n') });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    expect(() =>
      addManagedObject({
        layers,
        composed,
        path: 'new',
        object: file('n\n'),
        destinationLayerId: 'base',
      }),
    ).not.toThrow(/invariant/);
    expect(() =>
      deleteManagedObject({ layers, composed, path: 'config' }),
    ).not.toThrow(/invariant/);
  });

  it('does not mutate input layers', () => {
    const base = snapshot('base', baseManifest, { config: file('v\n') });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const beforeBaseObjects = new Map(base.objects);
    const beforeOverlayObjects = new Map(overlay.objects);
    addManagedObject({
      layers,
      composed,
      path: 'new',
      object: file('n\n'),
      destinationLayerId: 'base',
    });
    expect(base.objects).toEqual(beforeBaseObjects);
    expect(overlay.objects).toEqual(beforeOverlayObjects);
    expect(base.objects.get('new')).toBeUndefined();
  });

  it('does not mutate input layers on delete', () => {
    const base = snapshot('base', baseManifest, { config: file('v\n') });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const beforeBaseObjects = new Map(base.objects);
    deleteManagedObject({ layers, composed, path: 'config' });
    expect(base.objects).toEqual(beforeBaseObjects);
    expect(base.objects.has('config')).toBe(true);
  });

  it('does not mutate input layers on unmanage', () => {
    const base = snapshot('base', baseManifest, { config: file('v\n') });
    const overlay = snapshot('work', overlayManifest, {});
    const layers = [base, overlay];
    const composed = composeLayers(base, [overlay]);
    const beforeBaseObjects = new Map(base.objects);
    unmanageManagedObject({ layers, composed, path: 'config' });
    expect(base.objects).toEqual(beforeBaseObjects);
    expect(base.objects.has('config')).toBe(true);
  });
});
