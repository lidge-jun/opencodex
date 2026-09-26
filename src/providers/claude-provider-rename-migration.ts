/**
 * Rename the retired `claude-cli` provider id to `claude-agent-sdk`.
 *
 * 2.65.0 shipped the row as `claude-cli`: a hand-built `claude -p` turn that pushed each request
 * through a one-shot CLI invocation with the harness prompt replaced. The row now drives
 * Anthropic's Claude Agent SDK, where the harness owns the session, so the retired id names the
 * transport it used to be rather than the one it uses. The old name also collided with
 * `src/providers/claude-cli-identity.ts`, which forges a `claude-cli/<ver>` user agent for the
 * Messages-API rows — the opposite mechanism, and a reader had to disambiguate the two by hand.
 *
 * Only config state moves. The row stores no credential (`keyOptional`: the harness keeps the
 * sign-in in its own store), so unlike the devin merge there is no auth.json half and no rekey, and
 * the shared startup pass owns persistence.
 *
 * Posture: the projection refuses and warns when `claude-agent-sdk` already exists, because two
 * rows can describe two different sign-in setups and choosing a survivor is not this migration's
 * call. `DEPRECATED_PROVIDER_ALIASES` in `./deprecated-provider-aliases` keeps the retired id resolvable meanwhile,
 * so a refused row stays reachable instead of dangling.
 */
import { rewriteProviderReferences } from "./provider-id-rewrite";
import type { OcxConfig } from "../types";

export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-agent-sdk";
export const CLAUDE_CLI_PROVIDER_ID = "claude-cli";

export interface ClaudeProviderRenameProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

export function projectClaudeProviderRename(config: OcxConfig): ClaudeProviderRenameProjection {
  const providers = config.providers;
  const legacyRow = providers?.[CLAUDE_CLI_PROVIDER_ID];
  // Only the row the retired preset seeded moves. A seeded row names the adapter outright and a row
  // that omits it inherits the registry entry, so both describe this mechanism. A row that carries
  // the retired NAME on some other adapter belongs to the operator - the name is plausible for an
  // `anthropic` row, since `claude-cli-identity.ts` uses the same term - and it keeps its name, its
  // transport and its billing. Nothing then rewrites a reference that points at it.
  const foreignLegacyRow = legacyRow !== undefined
    && legacyRow.adapter !== undefined
    && legacyRow.adapter !== CLAUDE_CLI_PROVIDER_ID;
  const hasLegacyRow = legacyRow !== undefined && !foreignLegacyRow;
  const customRows = Object.entries(providers ?? {}).filter(
    ([name, row]) => name !== CLAUDE_CLI_PROVIDER_ID && row?.adapter === CLAUDE_CLI_PROVIDER_ID,
  );

  // Project onto a clone. The rewriter is not transactional — earlier sites are already rewritten
  // by the time it finds a collision — so a later refusal has to discard the whole projection
  // instead of returning a half-renamed config.
  const projected = structuredClone(config);

  if (hasLegacyRow) {
    if (projected.providers?.[CLAUDE_AGENT_SDK_PROVIDER_ID]) {
      return {
        config,
        changed: false,
        warnings: [
          `provider "${CLAUDE_CLI_PROVIDER_ID}" was renamed to "${CLAUDE_AGENT_SDK_PROVIDER_ID}", but "`
          + `${CLAUDE_AGENT_SDK_PROVIDER_ID}" already exists. Both were left untouched: two rows can `
          + "describe two different sign-in setups, which is not a decision this migration can make. "
          + `Move any ${CLAUDE_CLI_PROVIDER_ID}-only settings onto "${CLAUDE_AGENT_SDK_PROVIDER_ID}" `
          + "and delete the unused entry, then restart.",
        ],
      };
    }
    const moved = projected.providers![CLAUDE_CLI_PROVIDER_ID]!;
    delete projected.providers![CLAUDE_CLI_PROVIDER_ID];
    moved.adapter = CLAUDE_AGENT_SDK_PROVIDER_ID;
    projected.providers![CLAUDE_AGENT_SDK_PROVIDER_ID] = moved;
  }

  const rewritten = foreignLegacyRow
    ? { changed: 0, collisions: [] as string[] }
    : rewriteProviderReferences(projected, CLAUDE_CLI_PROVIDER_ID, CLAUDE_AGENT_SDK_PROVIDER_ID);
  if (rewritten.collisions.length > 0) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${CLAUDE_CLI_PROVIDER_ID}" was renamed to "${CLAUDE_AGENT_SDK_PROVIDER_ID}", but `
        + `${rewritten.collisions.join(", ")} already hold values for the destination. Nothing was `
        + "changed: choosing which value survives is not a decision this migration can make. "
        + "Resolve those entries and restart.",
      ],
    };
  }

  // A custom-named row may name the retired adapter directly. Its own name is the operator's, so
  // only the adapter string moves; the row keeps pointing at this mechanism either way.
  let adapterRewrites = 0;
  for (const row of Object.values(projected.providers ?? {})) {
    if (row?.adapter === CLAUDE_CLI_PROVIDER_ID) {
      row.adapter = CLAUDE_AGENT_SDK_PROVIDER_ID;
      adapterRewrites += 1;
    }
  }

  const changed = hasLegacyRow || adapterRewrites > 0 || rewritten.changed > 0;
  if (!changed && !foreignLegacyRow) return { config, changed: false, warnings: [] };

  const warnings: string[] = [];
  if (foreignLegacyRow) {
    warnings.push(
      `left provider "${CLAUDE_CLI_PROVIDER_ID}" and every reference to it untouched: the row runs `
      + `adapter "${legacyRow!.adapter}", not the retired preset, so it is your provider rather than `
      + `this rename and keeps its own transport. The id "${CLAUDE_CLI_PROVIDER_ID}" now resolves to `
      + `"${CLAUDE_AGENT_SDK_PROVIDER_ID}" in registry lookups, so rename the row if it was meant `
      + `to be the subscription mechanism.`,
    );
  }
  if (hasLegacyRow) {
    warnings.push(
      `moved provider "${CLAUDE_CLI_PROVIDER_ID}" to "${CLAUDE_AGENT_SDK_PROVIDER_ID}": the row now `
      + "drives Anthropic's Claude Agent SDK, and the retired id survives as a lookup alias. "
      + `${rewritten.changed} reference(s) were re-pointed.`,
    );
  }
  if (adapterRewrites > 0) {
    warnings.push(
      `rewrote the adapter id on ${adapterRewrites} custom provider row(s): "${CLAUDE_CLI_PROVIDER_ID}" `
      + `is registered as "${CLAUDE_AGENT_SDK_PROVIDER_ID}".`,
    );
  }
  if (!hasLegacyRow && customRows.length === 0 && rewritten.changed > 0) {
    warnings.push(
      `re-pointed ${rewritten.changed} reference(s) from "${CLAUDE_CLI_PROVIDER_ID}" to "`
      + `${CLAUDE_AGENT_SDK_PROVIDER_ID}"; no provider row carried the retired id.`,
    );
  }

  if (!changed) return { config, changed: false, warnings };
  return { config: projected, changed: true, warnings };
}

