import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManagedObject, ManagedPath } from '../../src/domain/objects.js';
import { LayerdotsError } from '../../src/domain/errors.js';
import {
  emptyAppliedState,
  parseAppliedState,
  readAppliedState,
  serializeAppliedState,
  writeAppliedState,
} from '../../src/apply/state.js';
import type { AppliedState } from '../../src/apply/types.js';
import {
  createIsolatedEnvironment,
  createSandbox,
} from '../support/sandbox.js';

const file = (value: Uint8Array, executable = false): ManagedObject => ({
  kind: 'file',
  content: value,
  executable,
});
const text = (value: string): ManagedObject =>
  file(new TextEncoder().encode(value));
const symlinkTarget = (target: string): ManagedObject => ({
  kind: 'symlink',
  target,
});

async function stateDir(): Promise<string> {
  const root = await createSandbox('apply-state');
  await createIsolatedEnvironment(root);
  return join(root, 'xdg/state/layerdots');
}

describe('serializeAppliedState', () => {
  it('round-trips an ASCII text file', () => {
    const state: AppliedState = {
      objects: new Map([['.gitconfig', text('user alice\n')]]),
      deleted: new Set(),
    };
    const parsed = parseAppliedState(serializeAppliedState(state));
    const object = parsed.objects.get('.gitconfig');
    if (!object || object.kind !== 'file') throw new Error('expected file');
    expect(object.kind).toBe('file');
    expect(object.executable).toBe(false);
    expect(new TextDecoder().decode(Buffer.from(object.content))).toBe(
      'user alice\n',
    );
  });

  it('round-trips a file with binary non-UTF8 bytes exactly', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x00, 0x41, 0xfe]);
    const state: AppliedState = {
      objects: new Map([['bin/raw', file(bytes)]]),
      deleted: new Set(),
    };
    const parsed = parseAppliedState(serializeAppliedState(state));
    const object = parsed.objects.get('bin/raw');
    if (!object || object.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(object.content).equals(Buffer.from(bytes))).toBe(true);
  });

  it('round-trips an executable file', () => {
    const state: AppliedState = {
      objects: new Map([
        ['bin/tool', file(new TextEncoder().encode('#!/bin/sh\n'), true)],
      ]),
      deleted: new Set(),
    };
    const parsed = parseAppliedState(serializeAppliedState(state));
    const object = parsed.objects.get('bin/tool');
    if (!object || object.kind !== 'file') throw new Error('expected file');
    expect(object.executable).toBe(true);
  });

  it('round-trips a symlink', () => {
    const state: AppliedState = {
      objects: new Map([['.config/link', symlinkTarget('../other')]]),
      deleted: new Set(),
    };
    const parsed = parseAppliedState(serializeAppliedState(state));
    const object = parsed.objects.get('.config/link');
    if (!object || object.kind !== 'symlink') throw new Error('expected link');
    expect(object.target).toBe('../other');
  });

  it('round-trips an empty objects map', () => {
    const state = emptyAppliedState();
    const parsed = parseAppliedState(serializeAppliedState(state));
    expect(parsed.objects.size).toBe(0);
    expect(parsed.deleted.size).toBe(0);
  });

  it('round-trips a non-empty deleted set', () => {
    const state: AppliedState = {
      objects: new Map(),
      deleted: new Set(['.obsolete', 'config/.cache']),
    };
    const parsed = parseAppliedState(serializeAppliedState(state));
    expect(parsed.deleted.has('.obsolete')).toBe(true);
    expect(parsed.deleted.has('config/.cache')).toBe(true);
  });

  it('produces deterministic serialization regardless of insertion order', () => {
    const a = new Map<ManagedPath, ManagedObject>([
      ['b/x', text('one')],
      ['a/x', text('two')],
      ['c/x', symlinkTarget('t')],
    ]);
    const b = new Map<ManagedPath, ManagedObject>([
      ['c/x', symlinkTarget('t')],
      ['a/x', text('two')],
      ['b/x', text('one')],
    ]);
    const deletedA = new Set(['z/deleted', 'a/deleted']);
    const deletedB = new Set(['a/deleted', 'z/deleted']);
    const serializedA = serializeAppliedState({
      objects: a,
      deleted: deletedA,
    });
    const serializedB = serializeAppliedState({
      objects: b,
      deleted: deletedB,
    });
    expect(serializedA).toBe(serializedB);
  });
});

describe('parseAppliedState', () => {
  const invalidCases: Array<{ name: string; json: string }> = [
    { name: 'not JSON', json: 'not-json{' },
    { name: 'array root', json: '[]' },
    { name: 'null root', json: 'null' },
    { name: 'wrong version', json: '{"version":2,"objects":[],"deleted":[]}' },
    { name: 'missing version', json: '{"objects":[],"deleted":[]}' },
    {
      name: 'unknown top-level key',
      json: '{"version":1,"objects":[],"deleted":[],"extra":1}',
    },
    {
      name: 'objects not array',
      json: '{"version":1,"objects":{},"deleted":[]}',
    },
    {
      name: 'deleted not array',
      json: '{"version":1,"objects":[],"deleted":{}}',
    },
    {
      name: 'entry not object',
      json: '{"version":1,"objects":[1],"deleted":[]}',
    },
    { name: 'entry array', json: '{"version":1,"objects":[[]],"deleted":[]}' },
    {
      name: 'missing path',
      json: '{"version":1,"objects":[{"kind":"file","content":"YQ==","executable":false}],"deleted":[]}',
    },
    {
      name: 'path not string',
      json: '{"version":1,"objects":[{"path":1,"kind":"file","content":"YQ==","executable":false}],"deleted":[]}',
    },
    {
      name: 'empty path',
      json: '{"version":1,"objects":[{"path":"","kind":"file","content":"YQ==","executable":false}],"deleted":[]}',
    },
    {
      name: 'unknown kind',
      json: '{"version":1,"objects":[{"path":"a","kind":"dir","content":"YQ==","executable":false}],"deleted":[]}',
    },
    {
      name: 'file missing content',
      json: '{"version":1,"objects":[{"path":"a","kind":"file","executable":false}],"deleted":[]}',
    },
    {
      name: 'file missing executable',
      json: '{"version":1,"objects":[{"path":"a","kind":"file","content":"YQ=="}],"deleted":[]}',
    },
    {
      name: 'content not string',
      json: '{"version":1,"objects":[{"path":"a","kind":"file","content":123,"executable":false}],"deleted":[]}',
    },
    {
      name: 'executable not boolean',
      json: '{"version":1,"objects":[{"path":"a","kind":"file","content":"YQ==","executable":"yes"}],"deleted":[]}',
    },
    {
      name: 'invalid base64',
      json: '{"version":1,"objects":[{"path":"a","kind":"file","content":"!!!not--b64!!","executable":false}],"deleted":[]}',
    },
    {
      name: 'unknown object key',
      json: '{"version":1,"objects":[{"path":"a","kind":"file","content":"YQ==","executable":false,"extra":1}],"deleted":[]}',
    },
    {
      name: 'file with target',
      json: '{"version":1,"objects":[{"path":"a","kind":"file","content":"YQ==","executable":false,"target":"x"}],"deleted":[]}',
    },
    {
      name: 'symlink missing target',
      json: '{"version":1,"objects":[{"path":"a","kind":"symlink"}],"deleted":[]}',
    },
    {
      name: 'symlink target not string',
      json: '{"version":1,"objects":[{"path":"a","kind":"symlink","target":5}],"deleted":[]}',
    },
    {
      name: 'deleted path not string',
      json: '{"version":1,"objects":[],"deleted":[1]}',
    },
  ];

  for (const { name, json } of invalidCases) {
    it(`rejects: ${name}`, () => {
      let error: unknown;
      try {
        parseAppliedState(json);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(LayerdotsError);
      expect((error as LayerdotsError).code).toBe('invalid-applied-state');
    });
  }
});

describe('readAppliedState', () => {
  it('returns undefined when the file is absent', async () => {
    const dir = await stateDir();
    const state = await readAppliedState(join(dir, 'missing'), 'target');
    expect(state).toBeUndefined();
  });

  it('returns undefined and creates nothing when the state dir is absent', async () => {
    const root = await createSandbox('apply-state-no-dir');
    await createIsolatedEnvironment(root);
    const dir = join(root, 'xdg/state/layerdots');
    const state = await readAppliedState(dir, 'target');
    expect(state).toBeUndefined();
    await expect(lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips a previously written state with byte equality', async () => {
    const dir = await stateDir();
    const bytes = new Uint8Array([0x00, 0xff, 0x40, 0x20, 0xfe]);
    const state: AppliedState = {
      objects: new Map([
        ['.gitconfig', text('user bob\n')],
        ['bin/raw', file(bytes, true)],
        ['.config/link', symlinkTarget('../real')],
      ]),
      deleted: new Set(['.tmp/.o']),
    };
    await writeAppliedState(dir, 'target-1', state);
    const loaded = await readAppliedState(dir, 'target-1');
    if (!loaded) throw new Error('expected loaded state');
    const git = loaded.objects.get('.gitconfig');
    const raw = loaded.objects.get('bin/raw');
    const link = loaded.objects.get('.config/link');
    if (!git || git.kind !== 'file') throw new Error('expected file');
    if (!raw || raw.kind !== 'file') throw new Error('expected file');
    if (!link || link.kind !== 'symlink') throw new Error('expected link');
    expect(
      Buffer.from(git.content).equals(
        Buffer.from(new TextEncoder().encode('user bob\n')),
      ),
    ).toBe(true);
    expect(Buffer.from(raw.content).equals(Buffer.from(bytes))).toBe(true);
    expect(raw.executable).toBe(true);
    expect(link.target).toBe('../real');
    expect(loaded.deleted.has('.tmp/.o')).toBe(true);
  });

  it('mutating the returned map does not corrupt the serialized source', async () => {
    const dir = await stateDir();
    const state: AppliedState = {
      objects: new Map([['a', text('one')]]),
      deleted: new Set(['d']),
    };
    await writeAppliedState(dir, 't', state);
    const loaded = await readAppliedState(dir, 't');
    if (!loaded) throw new Error('expected state');
    (loaded.objects as Map<string, unknown>).delete('a');
    (loaded.deleted as Set<string>).clear();
    const again = await readAppliedState(dir, 't');
    if (!again || !again.objects.get('a') || !again.deleted.has('d'))
      throw new Error('original state must be preserved');
  });

  it('throws invalid-applied-state for a corrupted file', async () => {
    const dir = await stateDir();
    const realDir = join(dir, 'real');
    await mkdir(realDir, { recursive: true });
    await writeAppliedState(realDir, 't', emptyAppliedState());
    await writeFile(join(realDir, 't.json'), '!!garbage!!{', { flag: 'w' });
    await expect(readAppliedState(realDir, 't')).rejects.toMatchObject({
      code: 'invalid-applied-state',
    });
  });
});

describe('writeAppliedState', () => {
  it('creates the directory if missing and writes a parseable file', async () => {
    const root = await createSandbox('apply-state-dir');
    await createIsolatedEnvironment(root);
    const dir = join(root, 'xdg/state/layerdots');
    const state: AppliedState = {
      objects: new Map([['.gitconfig', text('user carol\n')]]),
      deleted: new Set(),
    };
    await writeAppliedState(dir, 't', state);
    const loaded = await readAppliedState(dir, 't');
    if (!loaded) throw new Error('expected state');
    const object = loaded.objects.get('.gitconfig');
    if (!object || object.kind !== 'file') throw new Error('expected file');
    expect(new TextDecoder().decode(object.content)).toBe('user carol\n');
  });

  it('echoes an empty applied state through write and read', async () => {
    const dir = await stateDir();
    await writeAppliedState(dir, 'empty', emptyAppliedState());
    const loaded = await readAppliedState(dir, 'empty');
    if (!loaded) throw new Error('expected state');
    expect(loaded.objects.size).toBe(0);
    expect(loaded.deleted.size).toBe(0);
  });

  it('rejects unsafe target ids', async () => {
    const dir = await stateDir();
    for (const bad of ['../evil', 'a/b', '', '.', '..', 'a\\b', '/x'])
      await expect(
        writeAppliedState(dir, bad, emptyAppliedState()),
      ).rejects.toMatchObject({ code: 'invalid-target-id' });
  });

  it('refuses to write through a symlinked parent directory', async () => {
    const root = await createSandbox('apply-state-link');
    await createIsolatedEnvironment(root);
    const real = join(root, 'real');
    await mkdir(real, { recursive: true });
    const linked = join(root, 'linked');
    await symlink(real, linked);
    await expect(
      writeAppliedState(linked, 't', emptyAppliedState()),
    ).rejects.toMatchObject({ code: 'applied-state-symlink' });
  });

  it('rejects a symlinked existing staging file on write', async () => {
    const root = await createSandbox('apply-state-stage-link');
    await createIsolatedEnvironment(root);
    const dir = join(root, 'xdg/state/layerdots');
    await mkdir(dir, { recursive: true });
    await symlink(join(root, 'victim'), join(dir, '.t.tmp'));
    await expect(
      writeAppliedState(dir, 't', emptyAppliedState()),
    ).rejects.toMatchObject({ name: 'LayerdotsError' });
  });

  it('does not leave a staging file behind', async () => {
    const dir = await stateDir();
    await writeAppliedState(dir, 't', emptyAppliedState());
    const entries = await readdir(dir);
    expect(entries).toEqual(['t.json']);
  });
});
