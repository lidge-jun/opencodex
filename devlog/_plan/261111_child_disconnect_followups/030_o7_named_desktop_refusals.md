# O7 (rest) — name every desktop_lifecycle_unsafe cause

`inspectRemoteDesktopStore` (src/claude/desktop-remote-store.ts) folds its failure sites into `conflict` / `unsafe`. Thread a reason and path out of each site class and map each to a message with the condition, the path and the fix, ending `(code desktop_lifecycle_unsafe)`.

Classes (to be confirmed against source): store owned by another connection; OpenCodex profile removed or renamed in Claude Desktop; OpenCodex profile edited in Claude Desktop; an unreadable or unsafe store / library file; the folder with no state or receipt (#8529).

Tests: one per class through `disconnectClient`, asserting path, fix and trailing code.
