---
title: FAB-00 Security Threat Model
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 100 -- Security Threat Model

## 1. Assets

Fabric task DB (`fabric.sqlite`), event hash chain, artifact store (content-addressed), leases/fencing tokens, worktrees (source + reviewer + verify + quarantine), native session refs (opaque), capability manifests, policy snapshots, agent-control credential, handoff packages, the opencodex proxy data plane (must not be coupled), and operator attention/approvals.

## 2. Principals

Human operator; Fabric Supervisor; opencodex request proxy; runtime adapter; native harness (Codex/Claude); model/provider; MCP server; repository content; external content (web/tools); imported task package; future remote worker.

## 3. Trust boundaries

Operator ? Supervisor (IPC, agent-control cred) | Supervisor ? adapter (in-process or RPC) | adapter ? native harness | harness ? model/provider | Supervisor ? MCP | Supervisor ? repository content | imported task package ? Fabric | deferred: remote worker ? A2A.

## 4. Entry points

IPC socket/pipe; CLI (`ocx task ...`); management `/api/*`; handoff import; native event stream; MCP tool results; model/tool output; artifact import; worktree filesystem.

## 5. Credential classes

Agent-control token (scoped, dedicated); provider API keys + OAuth tokens (owned by opencodex, **never** reused for agent control); Codex/ChatGPT account-pool identities; model API keys. Rule: agent-control cred never equals a data-plane or management-plane secret (`090` sec.4).

## 6. Threats

| Threat | Vector | Mitigation |
|---|---|---|
| Repository/workspace attack | malicious repo content in a worktree | sandbox per workspace mode; secret-pattern exclusion default; no auto-merge (`090`) |
| Prompt injection | model output / external content | approval gate on commands; bounded trust_label; reviewer role |
| Malicious repo instructions (`AGENTS.md`/hooks) | repo files read by harness | policy_snapshot pinned; harness permission profile restricts; quarantine on anomaly |
| Tool / MCP attack | malicious MCP server / tool output | MCP namespacing (already in opencodex); tool output is `untrusted` until validated; sandboxed exec |
| Adapter compromise | buggy/hostile adapter | adapter runs in Supervisor boundary; opaque native refs only; conformance gate (`130`) |
| Untrusted model/provider output | model returns malicious instructions | normalize to events; never auto-execute privileged ops without approval |
| Permission escalation | widened effective policy | Tier-3 block on handoff widening (`080`/`090`); permissions never widen without approval event |
| Symlink / path escape | worktree symlinks pointing outside | canonicalize all paths (opencodex already does, `structure/02`); sandbox confines; reject escaped paths |
| Stale owner / zombie process | old writer after lease loss | fencing token monotonic; reject stale mutation; mark `lost`; quarantine (`050`/`090`) |
| Forged acknowledgement | target fakes the ack hash | ack is machine-readable structured (not NL); verified against expected hashes before commit (`080` sec.3) |
| Poisoned capability manifest | false capabilities claimed | only `verified`/accepted-`degraded` satisfy mandatory; probed at runtime (`070`/`130`) |
| Artifact tampering | altered artifact bytes | content-addressed sha256; hash chain; missing artifact = projection fault |
| Multi-run malicious change | two runs collide on a worktree | one writer per worktree; no auto-merge; quarantine on conflict |
| Sensitive-content retention | secrets leaked into artifacts/events | redaction default; secret-pattern exclusion; privacy defaults (`090` sec.6) |

## 7. Deferred remote-worker risks (FAB-08)

A2A is opaque and remote; a remote worker can be a hostile principal. Risks: exfiltration via tool output, denial-of-handoff, forged Agent Card. **Mitigation (deferred to FAB-08):** remote workers are out of scope through FAB-04; when introduced, they get a separate trust boundary, signed Agent Cards, and never receive write authority without explicit operator approval. No remote worker is authorised by this threat model.

## 8. Kill paths

- Operator `ocx task` cancel -> `interrupt` + `closeSession` + lease release + worktree quarantine.
- Supervisor crash -> on restart, reconcile from event log; fencing tokens from DB; `lost` runs quarantined.
- Native harness hang -> heartbeat/stall deadline (opencodex already has 5-min stall, `structure/01`) -> interrupt + mark `failed`/`lost`.
- Forged ack / Tier-3 loss -> handoff blocked; source retains ownership; security observation emitted.

## 9. Recovery paths

- `lost` run -> quarantine ambiguous writes; require explicit reconciliation (no auto-discard).
- Post-commit target failure -> target owns; quarantine target worktree; rescue run or explicit reversal.
- Corrupt hash chain -> stop projection; require repair from a known-good snapshot + replay.
- Disk full / DB busy / artifact failure / worktree failure / network loss / quota exhaustion -> degrade gracefully (opencodex already degrades sidecars to markers, `structure/04`); Fabric emits `RunFailed` with bounded diagnostics, never silent.

## 10. Security acceptance gates

- Fencing token never decreases across any ownership transition (property test, `130`).
- One primary owner invariant holds through every crash point (`090` sec.3).
- No handoff commits with both source and target holding write authority.
- No credential/private content persisted (privacy scan passes -- repo already has `bun run privacy:scan`).
- Acknowledgement hash verified before ownership commit.
- Read-only/quarantine enforcement verified per platform (Linux/macOS/Windows).

## 11. Unresolved high-severity boundaries

None that require `NEEDS_HUMAN` to *complete FAB-00*. The maintainer-authority question (language + product placement, `120`/`170`) is a programme-authority decision, not a security boundary. All security boundaries above have a defined mitigation grounded in existing repo invariants or standard practice.
