# Implementation Status

This file is the handoff ledger for implementation work. Update it after each verified integration point so another session can resume without reconstructing prior decisions.

## Current Position

- Active milestone: Milestone 2, Safe Target Application
- Active step: not started
- Last verified integration: Milestone 1 core vertical slice and acceptance fixture
- Next step: design applied-state and journal contracts before implementing any target writes

## Safety Boundary

- Development fixtures, Git repositories, targets, state, cache, and conflict workspaces must live under the ignored `.layerdots-dev/` directory.
- Tests must replace `HOME`, XDG variables, and Git configuration with sandbox-local values before invoking Layerdots or Git.
- Development and test commands must never use the actual user home directory as a target.
- Milestone 2 must add an explicit target-root guard before any general target-writing command is exercised.

## Decisions

- Package manager: Corepack-pinned pnpm 11.24.0.
- Runtime: Node.js 22 or newer.
- Language: strict TypeScript using native ESM.
- Tests: Vitest.
- Formatting and linting: Prettier and ESLint.
- Integration policy: complete and verify one milestone before starting the next.
- Commit policy: commit at coherent, green integration gates with messages explaining the architectural purpose.

## Progress

### Milestone 0: Domain Documentation

- Complete before implementation began.

### Milestone 1: Core Vertical Slice

- [x] Scaffold TypeScript CLI and automated verification.
- [x] Define and validate manifest version 1.
- [x] Build isolated committed Git fixtures.
- [x] Read repository filesystem objects without losing bytes or metadata.
- [x] Compose additions, replacements, patches, and tombstones.
- [x] Produce status and colored diffs.
- [x] Calculate file and line provenance.
- [x] Detect unassigned target changes.
- [x] Assign whole hunks while preserving effective bytes.
- [x] Rebase overlays with isolated conflicts.
- [x] Pass the complete acceptance fixture.

## Verification Log

- Foundation gate: `corepack pnpm verify` passed on 2026-09-01 with 1 test.
- Repository integration gate: `corepack pnpm verify` passed on 2026-09-01 with 33 tests after independent safety review.
- Composition gate: `corepack pnpm verify` passed on 2026-09-01 with 43 tests after strict patch-semantics review.
- Inspection gate: `corepack pnpm verify` passed on 2026-09-01 with 55 tests after insertion-aware diff review.
- Provenance gate: `corepack pnpm verify` passed on 2026-09-01 with 71 tests after ambiguity and assignment-range review.
- Assignment gate: `corepack pnpm verify` passed on 2026-09-01 with 106 tests after adversarial privacy and malformed-hunk review.
- Synchronization gate: `corepack pnpm verify` passed on 2026-09-01 with 130 tests after diff3-boundary and workspace-safety review.
- Milestone 1 acceptance gate: `corepack pnpm verify` passed on 2026-09-01 with 143 tests after independent correctness and actual-home safety audits.

## Milestone 1 Limitations

- `inspect` is the only exposed CLI workflow; assignment and rebase are core APIs pending transaction command design.
- Real remotes, commits, pushes, target application, applied-state persistence, and rollback remain deliberately out of scope.
- Portable Node filesystem APIs cannot eliminate every concurrent symlink replacement race; static symlinks are rejected and file leaves use no-follow opens.

## Resume Checklist

1. Read `CONTEXT.md`, `PLAN.md`, and this file.
2. Run `corepack pnpm verify`.
3. Inspect `git status --short` and recent commits.
4. Continue from the current position above.
