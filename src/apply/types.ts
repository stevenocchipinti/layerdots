import type { ManagedObject, ManagedPath } from '../domain/objects.js';

/**
 * The last composed state successfully written to a target. It is retained
 * locally as the merge base for later synchronization (see CONTEXT.md,
 * "Applied State").
 *
 * `objects` holds the composed managed objects that were written. Paths that
 * an apply removed from the target (e.g. a tombstone in a new composition) are
 * represented by an explicit `deleted` set so the applied state records that
 * they are intentionally absent rather than merely unread.
 */
export interface AppliedState {
  readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
  readonly deleted: ReadonlySet<ManagedPath>;
}

/**
 * A filesystem-object kind as it currently exists where an apply will write.
 * Used to require explicit approval before replacing one kind with another.
 */
export type ExistingObjectKind = 'absent' | 'file' | 'symlink' | 'dir';

/** Kind of managed object an apply intends to write at a path. */
export type TargetObjectKind = 'file' | 'symlink' | 'delete';

/**
 * The outcome of validating a single managed path before writing. A path whose
 * existing object differs in kind from what will be written is not applied
 * unless an explicit approval names it.
 */
export interface ApplyValidation {
  readonly path: ManagedPath;
  readonly existing: ExistingObjectKind;
  /** Not set when no change would be written. */
  readonly target?: TargetObjectKind;
}

/**
 * Result of an apply operation. Either a set of written paths and the new
 * applied state, or an unapplied set of conflicts.
 */
export interface ApplyResult {
  readonly applied: boolean;
  readonly written: readonly ManagedPath[];
  readonly state: AppliedState;
  readonly conflicts: readonly ApplyConflict[];
}

/**
 * A three-way target conflict that prevented application and was placed in an
 * isolated conflict workspace. The last valid target files remain active.
 */
export interface ApplyConflict {
  readonly path: ManagedPath;
  readonly workspace: string;
}
