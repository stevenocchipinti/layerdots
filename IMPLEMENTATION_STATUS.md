# Implementation Status

This file is the handoff ledger for implementation work. Update it after each verified integration point so another session can resume without reconstructing prior decisions.

## Current Position

- Active milestone: Milestone 2, Safe Target Application
- Active step: core apply modules complete; CLI exposure and remaining workflows pending (see Milestone 2 status below)
- Last verified integration: Milestone 2 core apply vertical slice and acceptance fixture
- Next step: expose target application through a CLI command, then complete the remaining Milestone 2 workflows (explicit home-default resolution and add/delete/unmanage)

## Safety Boundary

- Development fixtures, Git repositories, targets, state, cache, and conflict workspaces must live under the ignored `.layerdots-dev/` directory.
- Tests must replace `HOME`, XDG variables, and Git configuration with sandbox-local values before invoking Layerdots or Git.
- Development and test commands must never use the actual user home directory as a target.
- `applyComposition` requires an explicit `targetRoot` and never defaults to or writes the user's home directory. A CLI that resolves a default home target must add an explicit target-root guard and remain sandbox-forced in development before any general target-writing command is exercised.

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

### Milestone 2: Safe Target Application

- [x] Define applied-state, journal, and apply contracts (`src/apply/types.ts`).
- [x] Persist and reload the last applied composition (with explicit-deleted set) atomically and safely (`src/apply/state.ts`).
- [x] Capture target before-images and roll back on apply failure, pruning only apply-created parents (`src/apply/journal.ts`).
- [x] Orchestrate safe target application (`src/apply/apply.ts`): three-way merge against the applied-state base, isolated conflicts, path/case/symlink validation, type-replacement approval, journaled rollback, unmanaged-sibling preservation, and applied-state persistence after successful writes.
- [x] Harden with property, security, and fidelity tests (executable bits, CRLF, missing final newlines, binaries, idempotence, escape rejection, approval matrix, rollback, applied-state/target consistency).
- [x] Pass the Milestone 2 acceptance fixture with real Git layer repositories.
- [ ] Expose target application through a CLI command.
- [ ] Resolve a default home target with an explicit target-root guard.
- [ ] Implement distinct add, delete, and unmanage workflows.

## Verification Log

- Foundation gate: `corepack pnpm verify` passed on 2026-09-01 with 1 test.
- Repository integration gate: `corepack pnpm verify` passed on 2026-09-01 with 33 tests after independent safety review.
- Composition gate: `corepack pnpm verify` passed on 2026-09-01 with 43 tests after strict patch-semantics review.
- Inspection gate: `corepack pnpm verify` passed on 2026-09-01 with 55 tests after insertion-aware diff review.
- Provenance gate: `corepack pnpm verify` passed on 2026-09-01 with 71 tests after ambiguity and assignment-range review.
- Assignment gate: `corepack pnpm verify` passed on 2026-09-01 with 106 tests after adversarial privacy and malformed-hunk review.
- Synchronization gate: `corepack pnpm verify` passed on 2026-09-01 with 130 tests after diff3-boundary and workspace-safety review.
- Milestone 1 acceptance gate: `corepack pnpm verify` passed on 2026-09-01 with 143 tests after independent correctness and actual-home safety audits.
- Applied-state and journal gate: `corepack pnpm verify` passed on 2026-09-07 with 205 tests.
- Target application gate: `corepack pnpm verify` passed on 2026-09-07 with 217 tests after safety and merge-base review.
- Hardening gate: `corepack pnpm verify` passed on 2026-09-07 with 239 tests after fidelity, escaping, and approval-matrix review.
- Milestone 2 acceptance gate: `corepack pnpm verify` passed on 2026-09-07 with 240 tests.

## Milestone 2 Limitations

- Target application is exposed only through the `applyComposition` core API; there is no CLI command yet.
- `applyComposition` requires an explicit `targetRoot`; home-directory defaulting and the target-root guard are not yet implemented.
- Add, delete, and unmanage workflows exist only at the data level; they are not surfaced as distinct user commands.
- A managed path that currently resolves to a directory on the target is rejected as `unsupported-object` by the target reader before type-replacement approval logic runs, so directory-to-file replacement is not reachable in the current version.

- `inspect` is the only exposed CLI workflow; assignment and rebase are core APIs pending transaction command design.
- Real remotes, commits, and pushes through system Git remain deliberately out of scope (Milestone 3).
- Portable Node filesystem APIs cannot eliminate every concurrent symlink replacement race; static symlinks are rejected and file leaves use no-follow opens.

## Resume Checklist

1. Read `CONTEXT.md`, `PLAN.md`, and this file.
2. Run `corepack pnpm verify`.
3. Inspect `git status --short` and recent commits.
4. Continue from the current position above.
