# Prefix current-dev adaptation

Previous D: reverse native affinity correction reviewed. Parent requested current-dev integration of own prefix branch #4347. Class C2 adaptation; all existing no-local-suites/no-merge restrictions apply. Safe rebase own prefix commit df5853600a onto fetched origin/dev, dropping no product change. Existing roadmap commit already integrated via #4338. Record old/new immutable refs. No other branch/worktree edits.

MODIFY only conflict resolutions in structure/clients/claude-desktop.md, structure/data-planes/inbound-compat.md, structure/runtime.md: preserve latest dev appended helper contract AND prefix opt-in section/link. Runtime prefix delta remains byte-identical. Test layout maps auto-merge retaining both sides' entries. No new implementation.

Independent design/audit: confirm union of append-only docs is correct; compare old base..old tip to new base..new tip by file and range-diff, disclose every changed patch. Existing independent source review at df585 remains valid only for unchanged authored bytes, and conflict interdiff needs a separate inherited reviewer. C text diff check and new exact head hosted CI tracking; no local product tests. Push --force-with-lease tied to old prefix head and --no-verify; parent owns merge.
