# Deferral oracle taxonomy and the Bun-dependent surface

ADR-0008 requires the flip to a single Go binary to happen only at "100% differential parity". Reproduction evidence (`devlog/_plan/260908_go_flip_restore_uninstall_boundary/010_boundary_record.md`) shows several TypeScript-owned surfaces are structurally incapable of byte parity: interactive OAuth (login/setup), OS service-manager lifecycle (service/tray), network self-replace (update), coordinator writes with non-deterministic bytes (restore/uninstall/recover-history), and launchers whose env depends on live auth subsystems (claude/opencode). Applied literally, the 100%-parity clause makes the delegation seam permanent and the standalone-artifact acceptance (spec #7 story 4) unreachable, so every flip chases an unattainable end state.

We decided (owner, 2026-09-08):

1. **Oracle taxonomy.** An oracle may be T1 byte parity (the existing harness), T2 masked parity (same wall-clock window, with explicitly declared volatile fields masked), T3 golden fixture (offline stubbed server / fixed home / pinned catalog), T4 platform lane (a per-OS test lane), or T5 interactive subset (the non-interactive branches of an interactive command). Non-T1 acceptance is per-surface, explicit, and recorded in the deferral ledger's track — never a default.
2. **Completion definition.** "100% differential parity" means every oracle-able surface passes its oracle. Surfaces that cannot be oracle-able form an explicit Bun-dependent list — the accepted end state, not an accident. The seam-removal target (#55) is re-scoped to shrink the ledger down to that list.
3. **Deferral reasons must be cross-checked against the TypeScript code.** The v2 deferral claimed a byte-exact TOML reader/writer was needed; the code writes config.toml only through the upstream `codex features` CLI, so the writer half was overstated. A deferral reason that names a missing primitive must cite the TS-side evidence it was derived from.

**Status**: accepted — supersedes the literal reading of ADR-0008's parity clause. A flip still never lands without its oracle; the difference is which oracle shapes qualify.
