import type { OcxConfig, OcxClaudeCodeConfig } from "../../types";
import { isAnthropicInstanceId, type AnthropicInstanceId } from "../../providers/anthropic-instance-id";
import { jsonResponse } from "../auth-cors";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Validate request shape and build only a candidate; callers rebuild within admission before publishing. */
export function prepareClaudeCodePatch(config: OcxConfig, body: Record<string, unknown>) {
  for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
    const section = body[field];
    if (section === undefined || section === null) continue;
    if (!isPlainObject(section)) return jsonResponse({ error: `${field} must be an object or null` }, 400);
    if (section.enabled !== undefined && typeof section.enabled !== "boolean") {
      return jsonResponse({ error: `${field}.enabled must be a boolean` }, 400);
    }
    // Both overrides now speak their full unions (roadmap 060 web, 170
    // vision revised). Vision's third arm is "routed" (loopback through the
    // proxy's own router), never exa: exa is not an LLM, and accepting an
    // unknown literal would persist a backend the vision resolver reads as
    // unset (review F1's failure mode).
    const allowedBackends = field === "webSearchSidecar"
      ? ["openai", "anthropic", "xai", "gemini", "exa"]
      : ["openai", "anthropic", "routed"];
    if (section.backend !== undefined && section.backend !== null
      && !allowedBackends.includes(section.backend as string)) {
      return jsonResponse({ error: `${field}.backend must be ${allowedBackends.join(", ")}, or null` }, 400);
    }
    if (section.model !== undefined && typeof section.model !== "string") {
      return jsonResponse({ error: `${field}.model must be a string` }, 400);
    }

  }
  const next = { ...(config.claudeCode ?? {}) };
  for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
    const section = body[field];
    if (section === undefined) continue;
    if (section === null || Object.keys(section as Record<string, unknown>).length === 0) {
      delete next[field];
      continue;
    }
    // The per-field validation above guarantees vision only ever carries the two-member
    // union; the cast is the loop's shared-shape compromise, not a wider write path.
    const requested = section as { enabled?: boolean; backend?: "openai" | "anthropic" | "xai" | "gemini" | "exa" | null; model?: string; anthropicInstance?: AnthropicInstanceId | null };
    const override = { ...next[field] } as NonNullable<OcxClaudeCodeConfig[typeof field]>;
    if (requested.enabled !== undefined) override.enabled = requested.enabled;
    if (requested.anthropicInstance === null) delete override.anthropicInstance;
    else if (isAnthropicInstanceId(requested.anthropicInstance)) override.anthropicInstance = requested.anthropicInstance;
    if (requested.backend === null) delete override.backend;
    else if (requested.backend !== undefined) override.backend = requested.backend as never;
    if (requested.model === "") delete override.model;
    else if (requested.model !== undefined) override.model = requested.model;
    // Indexed write across the field union collapses to an intersection; runtime
    // validation above already guarantees the per-field shape.
    if (Object.keys(override).length > 0) next[field] = override as never;
    else delete next[field];
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled must be a boolean" }, 400);
    next.enabled = body.enabled;
  }
  if (body.authMode !== undefined) {
    // Three-state intent: "proxy" and "subscription" are stored literally and stick
    // forever; "auto" DELETES the key so the mode is resolved from detected Claude
    // auth on every launch. The 260720 round-trip contract survives as a superset —
    // storing "subscription" literally is also backward-safe, since older readers
    // only ever recognised "proxy".
    if (body.authMode !== "proxy" && body.authMode !== "subscription" && body.authMode !== "auto") {
      return jsonResponse({ error: "authMode must be \"auto\", \"proxy\", or \"subscription\"" }, 400);
    }
    if (body.authMode === "auto") delete next.authMode;
    else next.authMode = body.authMode;
  }
  if (body.systemEnv !== undefined) {
    if (typeof body.systemEnv !== "boolean") return jsonResponse({ error: "systemEnv must be a boolean" }, 400);
    next.systemEnv = body.systemEnv;
  }
  if (body.alwaysEnableEffort !== undefined) {
    if (typeof body.alwaysEnableEffort !== "boolean") return jsonResponse({ error: "alwaysEnableEffort must be a boolean" }, 400);
    if (body.alwaysEnableEffort) next.alwaysEnableEffort = true;
    else delete next.alwaysEnableEffort;
  }
  if (body.maxContextTokens !== undefined) {
    // CONFIG-ONLY back-compat (GUI control removed — superseded by auto-context):
    // null clears; otherwise a positive integer (devlog 136 B6).
    if (body.maxContextTokens === null) {
      delete next.maxContextTokens;
    } else if (typeof body.maxContextTokens !== "number" || !Number.isInteger(body.maxContextTokens) || body.maxContextTokens <= 0) {
      return jsonResponse({ error: "maxContextTokens must be a positive integer or null" }, 400);
    } else {
      next.maxContextTokens = body.maxContextTokens;
    }
  }
  if (body.autoContext !== undefined) {
    // Default-on boolean (devlog 260712 020): true = drop the key, false = store.
    if (typeof body.autoContext !== "boolean") return jsonResponse({ error: "autoContext must be a boolean" }, 400);
    if (body.autoContext) delete next.autoContext;
    else next.autoContext = false;
  }
  if (body.contextAccounting !== undefined) {
    // Sparse like autoContext (devlog/_plan/261009_claude_1m_default/030): "1m" is the default
    // and drops the key; "200k" is the only stored value.
    if (body.contextAccounting !== "1m" && body.contextAccounting !== "200k") {
      return jsonResponse({ error: "contextAccounting must be \"1m\" or \"200k\"" }, 400);
    }
    if (body.contextAccounting === "200k") next.contextAccounting = "200k";
    else delete next.contextAccounting;
  }
  if (body.injectAgents !== undefined) {
    // Default-on boolean (devlog 260712 070): true = drop the key, false = store.
    if (typeof body.injectAgents !== "boolean") return jsonResponse({ error: "injectAgents must be a boolean" }, 400);
    if (body.injectAgents) delete next.injectAgents;
    else next.injectAgents = false;
  }
  if (body.autoCompactWindow !== undefined) {
    // null resets to the 350k default; otherwise the binary-accepted range
    // 100_000..1_000_000 (2.1.207 pSo/yDs — audit 021 #1).
    if (body.autoCompactWindow === null) {
      delete next.autoCompactWindow;
    } else if (typeof body.autoCompactWindow !== "number" || !Number.isInteger(body.autoCompactWindow) || body.autoCompactWindow < 100_000 || body.autoCompactWindow > 1_000_000) {
      return jsonResponse({ error: "autoCompactWindow must be an integer between 100000 and 1000000, or null" }, 400);
    } else {
      next.autoCompactWindow = body.autoCompactWindow;
    }
  }
  if (body.blockedSkills !== undefined) {
    // null resets to the default (["claude-api"]); an array (possibly empty = off)
    // must contain non-empty strings (devlog 060).
    if (body.blockedSkills === null) {
      delete next.blockedSkills;
    } else if (!Array.isArray(body.blockedSkills) || body.blockedSkills.some(s => typeof s !== "string" || s.trim() === "")) {
      return jsonResponse({ error: "blockedSkills must be an array of non-empty strings, or null" }, 400);
    } else {
      next.blockedSkills = (body.blockedSkills as string[]).map(s => s.trim());
    }
  }
  if (body.tierModels !== undefined) {
    // Family defaults also serve third-party callers that request native tier aliases.
    if (body.tierModels === null) {
      delete next.tierModels;
    } else if (!isPlainObject(body.tierModels)) {
      return jsonResponse({ error: "tierModels must be an object with string values, or null" }, 400);
    } else {
      for (const [tier, value] of Object.entries(body.tierModels)) {
        if (typeof value !== "string") return jsonResponse({ error: `tierModels.${tier} must be a string` }, 400);
      }
      const tierModels = body.tierModels as Record<string, string>;
      const tiers: Record<string, string> = {};
      for (const tier of ["opus", "sonnet", "haiku", "fable"] as const) {
        const value = tierModels[tier];
        if (value !== undefined && value.trim() !== "") tiers[tier] = value.trim();
      }
      if (Object.keys(tiers).length > 0) next.tierModels = tiers;
      else delete next.tierModels;
    }
  }
  let nextFastMode = config.fastMode;
  if (body.fastMode !== undefined) {
    if (body.fastMode !== true && body.fastMode !== false && body.fastMode !== null) {
      return jsonResponse({ error: "fastMode must be true, false, or null" }, 400);
    }
    nextFastMode = body.fastMode === null ? undefined : body.fastMode;
  }
  for (const field of ["model", "smallFastModel", "classifierModel"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return jsonResponse({ error: `${field} must be a string` }, 400);
    if (value.trim() === "") delete next[field];
    else next[field] = value.trim();
  }
  if (body.classifierFallbacks !== undefined) {
    if (body.classifierFallbacks === null) {
      delete next.classifierFallbacks;
    } else {
      if (!Array.isArray(body.classifierFallbacks)) {
        return jsonResponse({ error: "classifierFallbacks must be an array of strings, or null" }, 400);
      }
      const list: string[] = [];
      for (const entry of body.classifierFallbacks) {
        if (typeof entry !== "string" || entry.trim() === "") {
          return jsonResponse({ error: "classifierFallbacks entries must be non-empty strings" }, 400);
        }
        list.push(entry.trim());
      }
      if (list.length > 0) next.classifierFallbacks = list;
      else delete next.classifierFallbacks;
    }
  }
  if (body.modelMap !== undefined) {
    if (body.modelMap === null) {
      delete next.modelMap;
    } else {
      if (!isPlainObject(body.modelMap)) {
        return jsonResponse({ error: "modelMap must be an object of string->string, or null" }, 400);
      }
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.modelMap)) {
        if (typeof v !== "string" || k.trim() === "" || v.trim() === "") {
          return jsonResponse({ error: "modelMap entries must be non-empty strings" }, 400);
        }
        map[k.trim()] = v.trim();
      }
      if (Object.keys(map).length > 0) next.modelMap = map;
      else delete next.modelMap;
    }
  }

  return { next, nextFastMode };
}
