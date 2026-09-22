# Layerdots

Status: Milestone 5 stack lifecycle complete. Layerdots is pre-release; command names and behavior may still change. See [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for the current milestone.

Layerdots composes your dotfiles from an ordered stack of Git repositories: a public **base** (e.g. your personal dotfiles) and zero or more private **overlays** stacked on top (e.g. work configuration). It applies the composed result to a target directory, preserves files it doesn't manage and edits you've made by hand, and keeps private content out of the public base unless you explicitly put it there.

See [`CONTEXT.md`](CONTEXT.md) for the full domain model and terminology used below, and <https://stevenocchipinti.github.io/layerdots/> for a visual explainer.

## Installation

Layerdots isn't published yet. Build it from source:

```sh
corepack pnpm install
corepack pnpm build
```

This produces a `layerdots` executable at `dist/cli/main.js` (declared as the `bin` in `package.json`). Run it directly with Node, or link it onto your `PATH`:

```sh
node dist/cli/main.js --version
# or
corepack pnpm link --global
layerdots --version
```

The examples below assume `layerdots` is on your `PATH`. If you're running it unlinked, substitute `node dist/cli/main.js`.

## Quick start

Point Layerdots at your top overlay's Git URL and an explicit target directory. `init` clones the overlay and each of its pinned parents, verifies them, and registers the target's active stack — it never writes to the target itself:

```sh
layerdots init <private-overlay-url> --target ~/dotfiles-sandbox
layerdots inspect --target ~/dotfiles-sandbox
layerdots apply --target ~/dotfiles-sandbox
```

`inspect` shows the composed result and where each path comes from. `apply` writes only managed paths to the target, records the result as the new merge base, and leaves everything else in the target untouched.

Each target has one active stack at a time. `--target` should point at the real location you want dotfiles applied to (commonly your home directory); use a sandbox directory first if you want to try Layerdots safely before pointing it at somewhere important.

## Capturing and publishing a change

Edit a managed file in your target as you normally would, then route the change to a layer, review it, and publish it:

```sh
layerdots status --target ~/dotfiles-sandbox
layerdots assign .gitconfig --layer overlay --interactive --target ~/dotfiles-sandbox
layerdots diff --target ~/dotfiles-sandbox
layerdots commit --message "Update work Git identity" --target ~/dotfiles-sandbox
layerdots push --target ~/dotfiles-sandbox
```

`status` lists unassigned target changes. `assign` stages a change onto a chosen layer:

- `--interactive` opens a `git add -p`-style selector. Each hunk offers `y` (stage), `n` (skip), `l` (choose individual changed lines), or `q` (cancel).
- `--select 1,2` stages whole hunks non-interactively by number (one-based).
- `--select 1:2.3` stages individual changed lines within a hunk (`hunk:line.line`).
- `--all-hunks` stages every hunk for the path.

A single staged transaction can hold more than one assignment: separate `assign` calls can route distinct hunks of the same path to different layers, and `assign` can be combined with `move` (below), before one `commit`. `commit` writes the staged changes into each affected layer's repository, from base upward. `push` publishes committed layers to their remotes, base first, stopping if a push fails.

## Moving already-committed content between layers

To relocate content that's already stored in a layer (not just a pending target edit), stage an explicit move, review it, then commit:

```sh
layerdots move .gitconfig --from base --to overlay --target ~/dotfiles-sandbox
layerdots diff --target ~/dotfiles-sandbox
layerdots commit --message "Move Git identity to work layer" --target ~/dotfiles-sandbox
```

Moves preserve the effective content your target sees. Moving private material down to the base is an explicit choice, and it may publish that content when you next `push`.

## Switching stacks

Replacing the top overlay is staged as a reviewable three-way transition, not an immediate swap:

```sh
layerdots switch <new-top-overlay-url> --target ~/dotfiles-sandbox
layerdots status --target ~/dotfiles-sandbox
layerdots diff --target ~/dotfiles-sandbox
layerdots switch apply --target ~/dotfiles-sandbox
```

The target and active stack stay unchanged until `switch apply`. Conflicts are isolated outside the target rather than left as merge markers in your files. A completed switch preserves unmanaged files and non-conflicting target edits, removes its transient staged snapshot, and keeps managed repository clones around for later reuse.

## Staying in sync

Before committing local changes after an upstream update, synchronize:

```sh
layerdots sync --target ~/dotfiles-sandbox
```

This fetches every layer, rejects diverged branches (Layerdots never force-pushes), and stages non-conflicting parent rebases. Conflicts are written outside the live target, which is left unchanged along with the active stack. If synchronization is interrupted while it has a remote commit temporarily checked out, recover before retrying:

```sh
layerdots sync recover --target ~/dotfiles-sandbox
```

## Undoing a staged change

To abandon a staged assignment, move, or stack switch before it's committed or applied:

```sh
layerdots discard --target ~/dotfiles-sandbox
```

This removes only the staged transaction or stack switch. The target, the active stack, and every managed clone are left untouched.

## Read-only output: JSON and color

`inspect`, `status`, and `diff` are read-only and accept `--json` for scripting. `inspect` and `diff` also accept `--color always|auto|never` and honor `NO_COLOR` when color is `auto` (the default).

```sh
layerdots status --target ~/dotfiles-sandbox --json
layerdots diff --target ~/dotfiles-sandbox --color never
```

## Working without an active stack

`inspect` can also be pointed directly at local repository directories, without an `init`-registered target — useful for a one-off look at repositories you already have checked out:

```sh
layerdots inspect --base ./base --overlay ./overlay --color never
```

An optional `--target` adds a sandbox directory containing a literal `home/` tree for comparison; only its composed managed paths are read.

## Learn more

- [`CONTEXT.md`](CONTEXT.md) — domain model, terminology, and product invariants.
- [`docs/adr/`](docs/adr) — rationale for consequential architectural decisions.
- [`PLAN.md`](PLAN.md) — implementation roadmap and open design decisions.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — building, testing, and contributing to Layerdots itself.
- <https://stevenocchipinti.github.io/layerdots/> — visual concept explainer.
