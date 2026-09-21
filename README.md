# Layerdots

Status: Milestone 5 stack lifecycle complete.

Layerdots composes dotfiles from an ordered stack of Git repositories. It safely applies a composed stack to an explicit target, preserves unmanaged files and local target edits, and isolates conflicts outside the live target.

Development and tests are intentionally sandboxed under the ignored `.layerdots-dev/` directory. Applying to the real home remains behind an explicit double opt-in.

## Development

```sh
corepack pnpm install
corepack pnpm verify
```

The test suite clears `.layerdots-dev/` once at the start of every run, so its size is bounded by the run in progress. Run `corepack pnpm clean` at any time to remove `.layerdots-dev/`, `dist/`, and `coverage/` manually.

For a usable prototype, initialize from the top overlay remote and use an explicit sandbox target:

```sh
corepack pnpm dev -- init <private-overlay-url> --target ~/layerdots-sandbox
corepack pnpm dev -- inspect --target ~/layerdots-sandbox
corepack pnpm dev -- apply --target ~/layerdots-sandbox
```

`init` clones the overlay and each pinned parent under XDG data storage, verifies the parent commits, and records the active stack in XDG configuration. It never writes the target. `apply` stores its merge base in XDG state and writes only managed paths.

Each target has one active stack. To replace it, stage a reviewed three-way transition rather than replacing live files immediately:

```sh
corepack pnpm dev -- switch <new-top-overlay-url> --target ~/layerdots-sandbox
corepack pnpm dev -- status --target ~/layerdots-sandbox
corepack pnpm dev -- diff --target ~/layerdots-sandbox
corepack pnpm dev -- switch apply --target ~/layerdots-sandbox
```

`switch` leaves the target and active stack unchanged until `switch apply`. Conflicts are isolated outside the target. A completed switch removes its transient staged snapshot, preserves unmanaged files and non-conflicting target edits through the three-way merge, and retains managed repository clones for later reuse.

Capture a target edit into the active overlay, review it, then commit and publish it:

```sh
corepack pnpm dev -- status --target ~/layerdots-sandbox
corepack pnpm dev -- assign .gitconfig --layer overlay --interactive --target ~/layerdots-sandbox
corepack pnpm dev -- diff --target ~/layerdots-sandbox
corepack pnpm dev -- commit --message "Update work Git identity" --target ~/layerdots-sandbox
corepack pnpm dev -- push --target ~/layerdots-sandbox
```

The selector offers each hunk as `y` (stage), `n` (skip), `l` (choose changed lines), or `q` (cancel). Non-interactive use can select hunk numbers with `--select 1,2` or changed edit numbers with `--select 1:2.3`; numbering is one-based. A selected addition inserts that line and a selected removal deletes that line, so either side of a replacement can be staged independently. `status` and `diff` display the staged transaction and its remaining target difference. Read-only `inspect`, `status`, and `diff` accept `--json`; `inspect` and `diff` accept `--color always|auto|never` and honor `NO_COLOR` in auto mode.

A staged transaction can hold more than one assignment before it is committed: distinct hunks of the same path can be routed to different layers across separate `assign` calls, and `assign` and `move` can be combined, as long as each call still has an unassigned or movable change to route.

To move already stored content between layers, stage an explicit delete-and-readd transaction, review it, then commit:

```sh
corepack pnpm dev -- move .gitconfig --from base --to overlay --target ~/layerdots-sandbox
corepack pnpm dev -- diff --target ~/layerdots-sandbox
corepack pnpm dev -- commit --message "Move Git identity to work layer" --target ~/layerdots-sandbox
```

Moves preserve the effective target content. Moving private material to the base is an explicit assignment and may publish it when pushed.

To abandon a staged assignment, move, or stack switch before it is committed or applied, run `corepack pnpm dev -- discard --target ~/layerdots-sandbox`. It removes only the staged transaction or stack switch state; the target, the active stack, and every managed clone are left untouched.

Before committing local changes after a remote update, run `corepack pnpm dev -- sync --target ~/layerdots-sandbox`. Synchronization fetches every layer, rejects divergence, and stages non-conflicting parent rebases. Conflicts are written below XDG state while the live target and active stack remain unchanged. If synchronization is interrupted while it temporarily checks out a remote commit, run `corepack pnpm dev -- sync recover --target ~/layerdots-sandbox` before retrying.

For development and explicit local repository testing, repositories can still be supplied directly:

```sh
corepack pnpm dev -- inspect --base ./base --overlay ./overlay --color never
```

An optional `--target` points to a sandbox directory containing a literal `home/` tree. Only composed managed paths are read.

Implementation progress and the next resume point are recorded in [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

<https://stevenocchipinti.github.io/layerdots/>
