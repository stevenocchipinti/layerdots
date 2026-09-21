# Layerdots Implementation Plan

This roadmap delivers the riskiest composition behavior first. Each milestone should leave the repository in a working, tested state.

## Milestone 0: Domain Documentation

- [x] Define terminology and invariants in `CONTEXT.md`.
- [x] Record core architectural decisions in `docs/adr/`.
- [x] Record the phased implementation plan.
- [x] Create a standalone visual concept explainer.

## Milestone 1: Core Vertical Slice

### Goal

Prove that a public base and private overlay can be composed, inspected, changed, and rebased without losing provenance or target edits.

### Scope

1. [x] Scaffold a TypeScript CLI with automated tests.
2. [x] Define and validate version 1 of `layerdots.json`.
3. [x] Load local fixture repositories representing one base and one overlay.
4. [x] Compose plain files, full replacements, unified patches, and tombstones.
5. [x] Classify valid UTF-8 text and opaque binary files.
6. [x] Produce managed-path status and colored diffs.
7. [x] Calculate file and line provenance, including overrides and ambiguity.
8. [x] Detect unassigned target changes.
9. [x] Assign whole hunks to the base or overlay.
10. [x] Rebase an overlay after its parent advances using a three-way merge.
11. [x] Place unresolved conflicts in an isolated workspace.

### Acceptance Fixture

The automated scenario must demonstrate:

- a plain public base file;
- a private overlay patch overriding part of that file;
- correct composed output;
- base, overlay, override, and unassigned provenance;
- a target hunk assigned to either repository;
- unchanged effective target content after assignment;
- a non-conflicting parent update incorporated automatically;
- an overlapping update represented as an isolated conflict.

### Explicitly Out of Scope

- real remote cloning and pushing;
- coordinated Git commits;
- individual-line assignment;
- direct movement of committed hunks between layers;
- TUI implementation.

## Milestone 2: Safe Target Application

1. Add configurable target roots, defaulting to the user's home directory.
2. Record last-applied compositions in local state.
3. Merge target edits against new compositions.
4. Validate path traversal, symlink parents, case collisions, and object types.
5. Add explicit approval for type replacement.
6. Add apply journals and automatic rollback.
7. Preserve unmanaged siblings.
8. Add distinct add, delete, and unmanage workflows.

## Milestone 3: Repository Lifecycle

1. [x] Store machine configuration, state, data, and cache in XDG locations.
2. [x] Refuse to manage Layerdots' own local directories.
3. [x] Implement tool-managed clones.
4. [x] Initialize recursively from a top overlay URL.
5. [x] Fetch tracked parent branches and exact pinned commits.
6. [x] Require clean repository worktrees.
7. Stage synchronization results for review.
8. Coordinate commits from base upward.
9. Honor Git hooks and signing configuration.
10. Implement explicit base-to-overlay push.
11. Detect remote divergence and require synchronization.

## Milestone 4: Assignment Workflow

1. Add an interactive `git add -p`-style hunk selector.
2. Make the staged transaction visible through status and diff commands.
3. Add individual changed-line selection.
4. Define and implement the manual workflow for moving stored content between layers.
5. Add stable JSON output for read-only commands.
6. Add color controls and accessible non-color labels.

## Milestone 5: Stack Lifecycle

1. Enforce one active stack per target.
2. Stage stack switches as three-way target transitions.
3. Purge transient private state after switching away.
4. Keep clones until explicitly removed.
5. Exercise stacks with more than one overlay in core and CLI tests.

## Milestone 6: Two-Layer TUI

1. Display the complete target tree, including unmanaged paths.
2. Display separate base and overlay panes.
3. Show file-level ownership and mixed provenance.
4. Show line-level effective ownership, override markers, and unassigned edits.
5. Route files and hunks to a chosen layer.
6. Review staged transactions and conflict workspaces.
7. Support desktop and constrained terminal widths for the two-layer use case.

Multi-overlay TUI navigation remains deferred until a real use case clarifies whether columns, tabs, or another model is appropriate.

## Verification Strategy

- Pure composition tests use temporary directories and committed fixture repositories.
- Integration tests invoke real system Git with isolated config and local bare remotes.
- Filesystem tests cover symlinks, executable bits, CRLF, missing final newlines, binaries, type conflicts, and rollback.
- Property-style tests verify that assigning content does not change the effective composed bytes.
- Security tests verify that repository paths and symlink parents cannot escape the configured target.
- CLI snapshot tests cover human output separately from versioned JSON output.

## Open Decisions

These are intentionally postponed until the vertical slice provides evidence:

- the exact CLI command names and argument grammar;
- package manager and distribution mechanism;
- staging semantics for multi-step manual movement between layers;
- whether literal `.patch` and `.delete` paths need an escape mechanism;
- the TUI framework and multi-overlay navigation model.
