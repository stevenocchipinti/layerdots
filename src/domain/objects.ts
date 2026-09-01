export type ManagedPath = string;

export interface RegularFile {
  readonly kind: 'file';
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export interface SymbolicLink {
  readonly kind: 'symlink';
  readonly target: string;
}

export type ManagedObject = RegularFile | SymbolicLink;

export interface LayerSnapshot {
  readonly id: string;
  readonly root: string;
  readonly manifest: import('./manifest.js').LayerManifestV1;
  readonly objects: ReadonlyMap<ManagedPath, ManagedObject>;
}

export function equalManagedObjects(
  left: ManagedObject,
  right: ManagedObject,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'symlink') {
    return right.kind === 'symlink' && left.target === right.target;
  }

  return (
    right.kind === 'file' &&
    left.executable === right.executable &&
    Buffer.from(left.content).equals(right.content)
  );
}
