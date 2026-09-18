/**
 * Compatibility shim. The rotation primitives moved to `src/oauth/pool-kernel.ts`
 * so every credential kind can share them, not only Codex and Anthropic.
 *
 * This file stays because the move is behaviour-preserving and its importers are
 * spread across files that other work owns right now. Re-exporting keeps
 * `routing.ts`, `auth-api.ts`, `account-priority.ts` and
 * `state-store-registrations.ts` on their existing import path, so the extraction
 * lands without editing any of them.
 */
export * from "../oauth/pool-kernel";
