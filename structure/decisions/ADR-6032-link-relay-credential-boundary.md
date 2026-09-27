# ADR-6032 — Child link relay credential boundary

- Contract owner: [Remote Link](../remote-link.md)

## Decision record

- Purpose and intent: Ensure a Child sends only its link admission key across the machine tunnel, never a caller's provider credential.
- Existing implementation and constraints: The relay already removed Bearer, `x-api-key`, OpenCodex, account and cookie credentials before attaching the link key. Built-in Azure and Google adapters use the independent `api-key` and `x-goog-api-key` forms, which were not in that denylist and therefore survived ordinary end-to-end header forwarding.
- Alternatives considered: Strip every header containing `key` or `token`; reuse the broad log-redaction regex; extend the relay's explicit list with the provider credential forms it actually supports.
- Chosen approach: Add `api-key` and `x-goog-api-key` to the case-insensitive explicit relay denylist and exercise them through both header construction and the actual fetch boundary.
- Why this approach: A broad name heuristic could remove legitimate protocol headers such as `idempotency-key`. The explicit list closes the proven built-in adapter paths while preserving ordinary request metadata and the existing link-key wire contract.
- Benefits, costs and impact: Azure and Google caller keys remain on the Child, matching the existing Anthropic/OpenAI behavior. Custom credential header names still require deliberate review before they become supported provider authentication forms.
