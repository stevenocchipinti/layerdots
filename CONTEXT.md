# Layerdots Context

Layerdots manages dotfiles as an ordered stack of Git repositories. It is designed for a specific trust boundary: public personal dotfiles form a base, while private work configuration is stored separately and layered over that base without copying private content into the public repository.

This document defines the shared domain language and product invariants. Implementation sequencing belongs in `PLAN.md`; rationale for consequential decisions belongs in `docs/adr/`.

## Core Model

### Layer

A Git repository that contributes managed paths to a stack. Every layer uses the same repository format.

### Base

The first layer in a stack. It has no parent and normally contains plain, human-readable files. A public personal dotfiles repository is the primary use case.

### Overlay

A layer with one immediate parent. Its manifest records the parent's Git URL, tracked branch, and exact commit used to produce its content.

An overlay can:

- introduce a plain file or symlink;
- replace a lower file or symlink completely;
- patch a lower text file;
- delete a lower path with a persistent tombstone.

The private work repository is the primary overlay use case.

### Stack

One base followed by zero or more overlays in deterministic order. The core model supports an arbitrary linear chain, even though the first visual interface will focus on one base and one overlay.

### Target

The directory receiving the composed files. It defaults to the current user's home directory but can be configured explicitly for testing and sandboxed use.

Only one stack may be active for a target at a time.

### Composed State

The effective filesystem produced by evaluating the stack from base to top. Later layers take precedence over earlier layers.

### Applied State

The last composed state successfully written to the target. It is retained locally as the merge base for later synchronization.

### Unassigned Change

A difference between the current target and its last composed state. These changes have not yet been assigned to a layer.

### Assignment

The act of routing an unassigned file or hunk to a chosen layer. Assigning to a lower layer regenerates affected overlays so that the effective target content remains unchanged.

### Staged Transaction

A local, reviewable plan containing assignments, synchronized repository changes, target changes, or conflict resolutions. A staged transaction is not yet committed or pushed.

### Provenance

The layer responsible for effective content. For an overridden line, the primary owner is the overlay that supplies the effective line and the UI also indicates that lower content is being overridden. If correspondence is ambiguous, the UI reports ambiguity instead of inventing ancestry.

## Repository Format

Every repository contains a versioned `layerdots.json` manifest and a literal home-relative tree under `home/`.

The repository role is inferred:

- no parent in the manifest means the repository is a base;
- a pinned parent means the repository is an overlay.

### Base Example

```text
personal-dotfiles/
|-- layerdots.json
`-- home/
    |-- .gitconfig
    `-- .config/
        `-- nvim/
            `-- init.lua
```

### Overlay Example

```text
work-dotfiles/
|-- layerdots.json
`-- home/
    |-- .gitconfig.patch
    |-- .config/
    |   `-- company-tool/
    |       `-- config.json
    `-- .obsolete-personal-config.delete
```

Within an overlay:

- `home/<path>` is a plain addition or an intentional whole-object replacement;
- `home/<path>.patch` is a Git-compatible unified patch for a lower UTF-8 text file;
- `home/<path>.delete` is an empty persistent tombstone for a lower path.

The `.patch` and `.delete` suffixes are reserved in overlay `home/` trees. Contradictory representations of the same effective path are invalid.

## Composition Rules

1. Read the checked-out bytes of the base `home/` tree.
2. Apply each overlay in order.
3. A plain overlay object replaces the complete lower object at that path.
4. A patch transforms the immediate lower composition pinned by the overlay.
5. A tombstone masks the lower path until removed from that overlay.
6. Unmanaged target paths are never part of composition and remain untouched.

Text files are valid UTF-8, including ASCII. Other byte sequences are opaque binaries and support only whole-file operations. Existing LF or CRLF endings and missing final newlines are preserved.

## Synchronization

An overlay patch is a pinned snapshot delta, not a durable instruction such as "append these lines." Line numbers in unified patches are hints; context and the pinned parent establish their meaning.

When a parent advances, Layerdots performs a three-way layer rebase:

```text
old parent composition ---> old overlay result
          |
          v
new parent composition ---> new overlay result
```

The upper-layer change from the old parent to the old overlay result is merged onto the new parent. Non-conflicting parent updates appear in the new result. The overlay patch is regenerated against the new pinned parent. Conflicts are placed in a dedicated workspace while the last valid target files remain active.

When both repositories and the target have changed, the last applied composition is the merge base used to preserve non-conflicting target edits.

## Managed Filesystem Scope

Layerdots manages only explicitly added paths.

Supported objects:

- regular files;
- symbolic links, managed as links rather than followed;
- Git's executable bit.

Not supported:

- templates or conditional content;
- generated scripts or apply hooks;
- encryption and secret-manager integration;
- submodules;
- empty directories;
- sockets, FIFOs, devices, or hardlink relationships;
- full POSIX modes, ownership, ACLs, flags, or extended attributes.

Apply validation rejects:

- absolute and parent-traversal paths;
- NUL bytes in paths;
- writes through a symlinked parent;
- paths that differ only by letter case;
- filesystem type replacement without explicit approval.

Unicode-normalization collisions are not specially handled in the first version.

## Git and Repository Lifecycle

- Layerdots uses installed system Git and existing Git authentication.
- Layer clones are managed under XDG data directories.
- Machine configuration, transactions, and caches use their appropriate XDG directories.
- Layerdots refuses to manage its own config, state, cache, and clone paths.
- Local state respects the user's umask.
- Repository-changing operations require clean layer working trees outside the active Layerdots transaction.
- Commits are coordinated from base upward and honor Git hooks and signing configuration.
- Content commits use the user's message; metadata-only parent-pin commits use generated context.
- An explicit `layerdots push` pushes base first, then overlays, stopping on failure.
- Diverged remotes require a reviewed synchronization; Layerdots never force-pushes.

The configured remote URL is the layer identity. A repository moved to another URL requires an explicit configuration migration.

## Safety Invariants

1. Private overlay content must never be written to or committed in a lower public repository unless the user explicitly assigns that content there.
2. Applying a stack must not modify unmanaged paths.
3. Applying multiple paths is journaled and rolls back on failure.
4. Layer-rebase conflicts do not place conflict markers in live target files.
5. A composed result is reproducible from the recorded checked-out commits under the same Git checkout configuration.
6. A push never publishes an overlay commit before its pinned parent commit is available remotely.
7. Switching stacks is a staged three-way transition, not an immediate replacement.
8. Transient private snapshots are purged after switching away from a private stack; repository clones remain until explicitly removed.

There is no special warning or secret scanning when assigning to a public layer. Public and private layers use the same assignment mechanics.

## Interface Direction

The CLI is the first interface and the source of behavior for future clients.

- Human-readable output is the default.
- Read-only commands provide stable `--json` output.
- Color follows terminal detection, `NO_COLOR`, and `--color=always|auto|never`.
- The interactive assignment flow starts with whole hunks and later supports individual changed lines.
- CLI status focuses on managed and changed paths; it does not browse the entire home directory.

The first TUI targets one base and one overlay with a split pane for each layer plus the target view. It will expose the full target tree, clearly distinguishing managed and unmanaged files. Multi-overlay TUI navigation is deferred; the underlying core remains stack-based.

## Deliberately Deferred

- Directly moving already-stored hunks between layers.
- The exact staged workflow for accomplishing a manual delete-and-re-add move.
- Individual-line assignment in the first vertical slice.
- Multi-overlay TUI layout.
- GitHub-specific APIs.
- Platform, hostname, or environment conditions.
- Literal overlay-managed filenames ending in `.patch` or `.delete`.
