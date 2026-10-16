# wp6 audit r1 — synthesis

Reviewer: grok-4.6 subagent (Hume), read-only investigation of #1107 against this tree. Verdict
carried as **near-pass**: the dedicated-provider injector can host the mode; the residual risks are
product, not code.

Findings folded into 060:
1. Catalog rows are slug-based and identical for both forms; the empty picker is Desktop's own
   native-only allowlist (upstream #19694). Documented with the existing `model =` workaround; not
   an injection bug and not solvable here.
2. `requires_openai_auth = false` also darkens ChatGPT-gated Fast/account/usage chrome. Documented
   as an expected cost of the mode.
3. Restore/strip paths already handle the table (`removeOcxSection`, `stripOpencodexConfig`).
   Disable → next inject is Design B again. Threads created while enabled stay tagged
   `opencodex`; the legacy history op (apply/migrate) is reused.
4. Key precedent: flat top-level boolean with `.catch(undefined)`; PATCH on `/api/settings`.
   Subagent suggested no CLI flag; overruled — the user constraint is "opt-in must be easy", so
   `ocx system settings --desktop-authless` is added.
5. Non-loopback must never lose `env_key`: enforced by deriving `desktopAuthless` only when
   `requiresAdmissionToken` is false.

