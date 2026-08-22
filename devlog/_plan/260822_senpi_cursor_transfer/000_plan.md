# 260822 — senpi Cursor transfer investigation

Docs-only research unit. No production patches in this cycle.
Session `01a02665-e4c1-75a3-9660-c71284a1bba2`. Goalplan `investigate-whether-opencodex-can-adopt-any-curs`.

## Loop spec

- Loop archetype: satisfy-spec research (inventory + classify). Not an optimization loop.
- Trigger: user asked whether OpenCodex can take Cursor-runtime mechanisms from senpi, with unlimited explorer dispatch, no model-name overrides.
- Goal: evidence-bearing transfer verdict in this unit. Every comparison row cites OpenCodex `path:line` and senpi GitHub blob/commit.
- Non-goals: production `src/` edits; copying senpi protobuf wholesale; starring repos; live Cursor account mutation; spawning `cursor-agent` CLI; extracting secrets.
- Verifier: files exist under this unit; `git status` shows no production `src/` diffs from this loop; 090 table rows have both-codebase citations.
- Stop: 090 locked and wp0 criteria captured. Implementation is a later appended work-phase, not this cycle.
- Memory artifact: this directory.
- Terminal: DONE (research lock) / NOOP (no residual gaps) / NEEDS_HUMAN (ToS) / UNSAFE (native-app patching).
- Escalation: live Cursor probes, ToS/product-policy, or proto-regen risk.

## Sources

- OpenCodex tree: local checkout (explorers also cited `dev` `a228ed74` / GitHub `lidge-jun/opencodex`).
- senpi: `code-yeongyu/senpi` `main` SHA `a5eed44536f3024c5740dc3dfff4ffe0bb08b717` (2026-08-21), files also fetched as current default-branch blobs.
- Explorer lanes (inherit parent model; no model field): Helmholtz (protocol), Planck (auth/catalog), Hypatia (exec), Leibniz (stream/usage), Pasteur (senpi protocol), Archimedes (senpi auth/catalog), Plato (exec-bridge + CLI), Ohm (overflow/RE).

## Docs

- 000 (this file) — unit map + later-implementation slice order.
- 001 — OpenCodex Cursor inventory.
- 002 — senpi Cursor inventory.
- 003 — protocol / transport compare.
- 004 — auth / catalog / effort / max-mode.
- 005 — exec / interactionQuery / tool pairing.
- 006 — stream completion / usage / overflow / rotation.
- 007 — CLI fallback lane.
- 090 — transfer verdict (ADOPT / ADAPT / REJECT / ALREADY-HAVE / NEEDS_HUMAN).

## Work-phase map (dependency order, not effort)

1. **wp0 (this cycle, docs-only):** inventories + 090 lock. Independent of later code.
2. **wp1 (010, later):** Cursor error mapping + 0-token `resource_exhausted` surface. Owner: `src/adapters/cursor/cursor-errors.ts`, `src/lib/errors.ts`, `src/adapters/cursor/transport-retry.ts`.
3. **wp2 (020, later):** `turnEnded` as application-complete + adapter stream-health. Owner: `src/adapters/cursor/live-transport.ts`, `src/adapters/cursor/protobuf-events.ts`.
4. **wp3 (030, later):** unknown-exec typed reply (`ExecClientThrow` + stream-close) and optional newer exec oneofs as refusals. Owner: `src/adapters/cursor/native-exec.ts`. Do not regenerate protobuf in the same cycle as error mapping.
5. **wp4 (040, later, optional):** live `GetUsableModels.maxMode` + richer catalog decode. Owner: `src/adapters/cursor/live-models.ts`, `src/adapters/cursor/protobuf-request.ts`, `src/adapters/cursor/discovery.ts`.

Do not implement two slices in one B. Do not start wp1 until this research cycle D-locks 090.

## IN / OUT

IN: this `devlog/_plan/260822_senpi_cursor_transfer/` directory.
OUT: `src/`, `tests/`, `gui/`, `docs-site/`; senpi vendored proto copy; CLI spawn of `cursor-agent`.

## Already-have headline

OpenCodex is not missing a Cursor provider. It already speaks `agent.v1.AgentService/Run` over Connect, answers `interactionQuery`, owns HTTP/1 `RunSSE` fallback, conversation-keyed `usedTokens` accounting, native-exec policy, and Responses-tool suspend. senpi's newer work is mostly overflow classification, turn-end close, exec-frame completeness, and a CLI fallback lane that OpenCodex deliberately does not have.

