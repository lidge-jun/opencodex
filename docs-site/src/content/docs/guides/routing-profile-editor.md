---
title: Routing Profile Editor
description: Create, edit, validate, dry-run, and remove routing policy profiles from the OpenCodex dashboard.
---

The **Models → Routing** tab in the OpenCodex dashboard can manage `config.routingProfiles` without editing `config.json` by hand.

## Create a profile

1. Open **Routing** in the dashboard.
2. Select **Create profile**.
3. Enter an `id`. The canonical model id is `policy/<id>`.
4. Add one or more explicit provider/model candidates.
5. Configure optional requirements, scoring weights, cost limits (`maxEstimatedCostUsd`, optional `onUnknownCost`), and unknown-evidence behavior.
6. Save the profile.

Profile ids are immutable after creation. To use a different id, create a new profile and remove the old one after updating callers.

## Route every prompt automatically

Enable **Automatic prompt routing** when one picker entry should choose a different candidate for
each request. Assign every candidate one or more task tiers:

- **Fast** for greetings, short rewrites, translations, and other lightweight requests.
- **Balanced** for ordinary questions and general work.
- **Powerful** for implementation, debugging, architecture, security, multi-step work, and other
  complex requests.

All three tiers must be covered before the profile can be saved. A candidate may serve more than one
tier, so the same model can be used for both balanced and powerful requests.

After saving, select the profile's alias (for example `ocx/auto`) in Codex once. OpenCodex
reclassifies the latest user prompt on **every request**, so a simple follow-up can use the fast
candidate and the next complex coding request can use the powerful candidate without changing the
picker again.

Classification is local and deterministic: it does not make a separate model request and does not
persist the raw prompt as routing metadata. Capability requirements, health, quota, cost limits, and
the profile's normal scoring rules still apply after the task-tier filter. The selected provider,
model, tier reason, and exclusions are available in the route-decision trace and
`ocx logs explain`; OpenCodex does not modify the assistant response with a routing footer.

Prompt routing is provider-agnostic. Any model already configured in OpenCodex can be assigned to a
tier, including DeepSeek, Qwen, Kimi, GLM, and other OpenAI-compatible or native providers. The
provider and model ids in the example below are illustrative.

## Validation and persistence

The dashboard sends the same profile object used by `config.routingProfiles` to the management API. The server validates the complete candidate before writing it:

- ids and aliases must follow the routing-profile naming and collision rules;
- every candidate provider must exist and be enabled;
- duplicate candidates are rejected;
- numeric limits and requirements must stay inside their supported ranges; and
- at least one optimization weight must be positive.

A successful save persists the profile through the normal config writer, reconciles live state, and refreshes the model catalog. Validation failures leave the previous configuration unchanged and are shown in the editor.

When `limits.maxEstimatedCostUsd` is configured, `limits.onUnknownCost` defaults to `"allow"`: an unknown cost estimate does not get a
cap-specific exclusion, and dry-run / live route-decision traces stamp
`cost.capOutcome: "unknown-allowed"` so operators can tell the cap was not proven. Set `"exclude"`
when the ceiling must fail closed (`cost-limit-unknown`, with
`cost.capOutcome: "unknown-excluded"`). Configuring `onUnknownCost` alone is inert and does not emit a cap outcome. This is separate from
`unknownEvidence.cost`, which can still exclude or penalize unknown prices independently of the
cap outcome.

## Dry-run a saved profile

Select a saved profile and use **Dry-run evaluation** to add request evidence such as context-window size, tool use, image input, or structured output. Dry-run evaluates eligibility and scoring but never sends an upstream model request.

Unsaved edits are not used by dry-run. Save the profile first so the displayed revision and evaluation refer to the same configuration.

## Management API

The editor uses these endpoints:

- `GET /api/routing-profiles` lists normalized profiles and revisions.
- `PUT /api/routing-profiles` creates or updates one profile. Send `mode: "create"` or `mode: "update"`; create mode refuses to overwrite an existing id.
- `DELETE /api/routing-profiles?id=<id>` removes one profile.
- `POST /api/routing-profiles/dry-run` evaluates a saved profile without dispatching upstream.

Example save payload:

```json
{
  "id": "smart",
  "mode": "create",
  "profile": {
    "alias": "ocx/auto",
    "promptRouting": { "enabled": true },
    "candidates": [
      {
        "provider": "deepseek",
        "model": "deepseek-chat",
        "taskTiers": ["fast", "balanced"]
      },
      {
        "provider": "openai",
        "model": "gpt-5.6",
        "taskTiers": ["powerful"]
      }
    ],
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```
