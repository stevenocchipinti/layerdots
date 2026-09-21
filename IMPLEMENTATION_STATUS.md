# Implementation Status

This file is the handoff ledger for implementation work. Update it after each verified integration point so another session can resume without reconstructing prior decisions.

## Current Position

- Active milestone: Milestone 3, Repository Lifecycle
- Active step: capture loop complete
- Last verified integration: whole-hunk staging, base-upward commits, and ordered pushes through local bare remotes
- Next step: remote-divergence detection and reviewed synchronization

## Safety Boundary

- Development fixtures, Git repositories, targets, state, cache, and conflict workspaces must live under the ignored `.layerdots-dev/` directory.
- Tests must replace `HOME`, XDG variables, and Git configuration with sandbox-local values before invoking Layerdots or Git.
- Development and test commands must never use the actual user home directory as a target.
- `applyComposition` requires an explicit `targetRoot` and never defaults to or writes the user's home directory. The `apply` CLI targets the real home only when both `--apply-to-home` and `LAYERDOTS_ALLOW_HOME=1` are set; development and tests remain sandbox-forced and never use a real home.

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
- [x] Expose target application through an `apply` CLI command (`src/cli/apply.ts`, `src/cli/main.ts`).
- [x] Resolve a default home target behind an explicit `--apply-to-home` flag AND the `LAYERDOTS_ALLOW_HOME=1` environment guard (`src/cli/target.ts`).
- [x] Implement distinct add, delete, and unmanage workflows (`src/assignment/workflows.ts`).
- [x] Pass the full verification gate at 278 tests.

### Milestone 3: Repository Lifecycle

- [x] Resolve XDG configuration, data, state, and cache directories for Layerdots.
- [x] Clone a top overlay and its recursively pinned parents into managed data storage.
- [x] Fetch parent branches, verify pinned parent commits, and require clean managed clones.
- [x] Register one active stack for an explicit target and resolve it through `inspect` and `apply`.
- [x] Stage whole-hunk assignments for review through `status` and `diff`.
- [x] Commit staged layer changes from base upward and push in the same order.
- [ ] Detect remote divergence and require reviewed synchronization.

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
- Apply CLI gate: `corepack pnpm verify` passed on 2026-09-07 with 247 tests.
- Guarded home-target gate: `corepack pnpm verify` passed on 2026-09-07 with 254 tests after double-opt-in opt-out audit.
- Workflows gate: `corepack pnpm verify` passed on 2026-09-07 with 278 tests after byte-preservation and regeneration review.
- Milestone 2 completion gate: `corepack pnpm verify` passed on 2026-09-07 with 278 tests after CLI, home-guard, and workflows review.
- Prototype bootstrap gate: `corepack pnpm verify` passed on 2026-09-21 with 280 tests after XDG, managed-clone, and active-stack review.
- Capture-loop gate: `corepack pnpm verify` passed on 2026-09-21 with 281 tests after staged-assignment, commit-order, and push-order review.
- Multi-path assignment regression gate: `corepack pnpm verify` passed on 2026-09-21 with 282 tests after multi-path staging and no-op patch regression review.

## Milestone 2 Limitations

- The `apply` CLI writes state under `<cwd>/.layerdots` and does not yet relocate state/configuration to XDG directories (Milestone 3).
- Real-home writes are reachable only behind the double opt-in (`--apply-to-home` + `LAYERDOTS_ALLOW_HOME=1`) and have not been exercised against an actual real home by the test suite.
- Add, delete, and unmanage workflows are core data operations, not yet surfaced as distinct user-facing CLI commands, and are not wired into a staged transaction (Milestone 4).
- A managed path that currently resolves to a directory on the target is rejected as `unsupported-object` by the target reader before type-replacement approval logic runs, so directory-to-file replacement is not reachable in the current version.

## Milestone 1 Limitations

- `inspect` and `apply` are the only exposed CLI workflows; assignment, rebase, and add/delete/unmanage are core APIs pending transaction command design.
- Managed remotes can now be cloned and inspected/applied, but synchronization staging, commits, and pushes remain in Milestone 3.
- Portable Node filesystem APIs cannot eliminate every concurrent symlink replacement race; static symlinks are rejected and file leaves use no-follow opens.

## Resume Checklist

1. Read `CONTEXT.md`, `PLAN.md`, and this file.
2. Run `corepack pnpm verify`.
3. Inspect `git status --short` and recent commits.
4. Continue from the current position above.
