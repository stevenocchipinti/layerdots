export const MANIFEST_VERSION = 1 as const;

export interface ParentReference {
  readonly url: string;
  readonly branch: string;
  readonly commit: string;
}

export interface LayerManifestV1 {
  readonly version: typeof MANIFEST_VERSION;
  readonly parent?: ParentReference;
}

export type LayerRole = 'base' | 'overlay';

export function layerRole(manifest: LayerManifestV1): LayerRole {
  return manifest.parent === undefined ? 'base' : 'overlay';
}
