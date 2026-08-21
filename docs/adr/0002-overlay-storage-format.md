# ADR 0002: Store Overlay Deltas as Standard Patches and Literal Objects

- Status: Accepted
- Date: 2026-08-21

## Context

Overlay repositories must remain inspectable in ordinary Git tools while supporting line-level provenance and assignment. They also need to represent new files, binaries, symlinks, full replacements, and deletions.

## Decision

Use a mixed literal tree under `home/`:

- a plain path is an addition or whole-object replacement;
- `<path>.patch` is a Git-compatible unified patch;
- `<path>.delete` is an empty persistent tombstone.

The `.patch` and `.delete` suffixes are reserved. A repository with multiple representations for one effective path is invalid.

Unified patches are pinned snapshot deltas. They describe the exact difference from the recorded parent, not semantic transformations such as append or regex replacement.

## Consequences

- Text changes can use mature Git diff and apply plumbing.
- Repository diffs remain reviewable without Layerdots.
- Private-only plain files remain directly readable.
- Binary files use whole-file replacement.
- Literal overlay-managed filenames ending in reserved suffixes are unsupported in format version 1.
- Parent updates require patches to be rebased and regenerated.

## Alternatives Considered

### Separate `home/` and `patches/` trees

This avoids reserved suffixes and all filename ambiguity, but separates one virtual file tree into two repository locations. The expected dotfile use case makes suffix collisions unlikely.

### One patch file for the entire layer

This resembles raw `git diff`, but unrelated paths create noisy conflicts and make per-file status and regeneration harder.

### Custom structured delta format

Stable operation IDs and annotations could be embedded in JSON, but this would require custom diff/apply tooling and reduce interoperability.

### Transformation instructions

Append, prepend, and regex operations can float over changing bases, but introduce ordering, idempotency, and failure semantics that conflict with deterministic snapshot composition.
