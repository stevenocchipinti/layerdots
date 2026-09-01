import type { ManagedObject, ManagedPath } from '../domain/objects.js';
import { equalManagedObjects } from '../domain/objects.js';

export type ManagedStatus =
  'unchanged' | 'added' | 'modified' | 'deleted' | 'type-changed';

export interface ManagedStatusEntry {
  readonly path: ManagedPath;
  readonly status: ManagedStatus;
  readonly expected?: ManagedObject;
  readonly actual?: ManagedObject;
}

/** Compare only the paths explicitly present in the supplied maps. */
export function compareManagedState(
  expected: ReadonlyMap<ManagedPath, ManagedObject>,
  actual: ReadonlyMap<ManagedPath, ManagedObject>,
): readonly ManagedStatusEntry[] {
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  return [...paths].sort().map((path) => {
    const before = expected.get(path);
    const after = actual.get(path);
    const status =
      before === undefined
        ? 'added'
        : after === undefined
          ? 'deleted'
          : before.kind !== after.kind
            ? 'type-changed'
            : equalManagedObjects(before, after)
              ? 'unchanged'
              : 'modified';
    return {
      path,
      status,
      ...(before === undefined ? {} : { expected: before }),
      ...(after === undefined ? {} : { actual: after }),
    };
  });
}
