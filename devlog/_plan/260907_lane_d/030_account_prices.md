# 030 Account price identity
MODIFY src/usage/user-cost-overlays.ts registry refresh and signature/version.
Before: configured provider set and overlay rows only.
After: exact account identifiers/log labels from config mapped to established provider
identity. Include mapping in signature for memo and aggregate cache invalidation.
MODIFY src/usage/cost.ts resolveMatchedPrice: exact configured namespace and exact
user overlay precede account identity; unresolved suffix is never guessed/stripped.
MODIFY tests/usage/usage-cost.test.ts or existing provider-overlay tests: custom account
id, qualified id, stable log label, configured collision, unrelated hyphenated provider,
account rename/removal invalidation. Account aliases never become identity authority.
Audit determines precise supported historical labels from actual producer evidence.

Verification: NOT RUN locally by user instruction; focused tests execute in final top-head Cross-platform CI.

Astra Ohm audit corrections: config-only identity mapping supports selectable Codex
accounts, effective codexAccountLogLabel, exact ID compatibility aliases, and built-in
main/__main__. Generic OAuth stores are separate and excluded; no free-form inference.
Use exact configured provider before canonical account identity, exact override first.
Apply same namespace for context/priority/lower-bound modifiers, preserving attribution.
Include sorted mapping in version signature, but aliases/plan/reordering stay no-ops.

Implementation: exact selectable account IDs, effective labels and main forms are resolved
from config at overlay refresh. Only identity changes bump cache versions. Exact configured
providers and explicit user rows remain isolated; context/Fast/lower-bound use the selected
price namespace while request attribution is unchanged. Existing memo fast path is retained.
Regression fixtures cover mappings, collisions, ignored aliases/invalid rows, add/remove/
label invalidation, presentation no-ops, estimate/attempt/combo and tier parity.
