# ADR 0003: Rebase Layers and Targets with Three-Way Merges

- Status: Accepted
- Date: 2026-08-21

## Context

Changes can originate in the target home directory, in the public repository on another machine, or in a private overlay. Updating one source must preserve independent changes without allowing silent overwrites.

Fuzzy patch application alone cannot reliably distinguish intended overlay changes from new parent changes.

## Decision

Use explicit three-way operations.

For an overlay update:

- merge base: old parent composition;
- ours: old overlay result;
- theirs: new parent composition;
- result: new overlay result and regenerated patch.

For target synchronization:

- merge base: last successfully applied composition;
- ours: current target with unassigned edits;
- theirs: new composed stack.

Conflicts are written to a dedicated workspace. The last valid target remains active until resolution and explicit apply.

Multi-path apply operations validate first, use a journal, and roll back on failure. Type replacements require explicit approval.

## Consequences

- Non-overlapping base, overlay, and target changes can coexist.
- Conflicts have a meaningful common ancestor and can be explained clearly.
- Layerdots must retain last-applied snapshots and old pinned parent compositions.
- Local state can contain private derived content and must be excluded from management.
- Apply logic is more involved than copying files but avoids partial configuration states.

## Alternatives Considered

### Refuse updates while the target is dirty

This is simpler but interrupts the normal multi-machine workflow and forces every local edit to be assigned before synchronization.

### Preserve the exact old composed output

This would make overlays cancel unrelated parent updates, hiding desired public changes.

### Fuzzy patch application

Context matching is useful within patch application but is not a substitute for a known merge base when both sides evolve.

### Write conflict markers into the target

This matches common Git behavior but can break shells, editors, and applications that consume live configuration.
