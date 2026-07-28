# 020 — PR #528 processing plan

Item: PR #528, `fix(images): Codex P2 follow-ups for image bridge (#424)`.

Planned bucket: `needs-human/security + request-changes`.

Audit update:

- Sol review checked head `553e9afc6f16135d83d8ab2d3ab0cb309675b81b`.
- GitHub reported `MERGEABLE/CLEAN` with passed checks, but the tested merge ref used
  an older base than current `origin/dev@7fcaa9119`.
- High blocker: `src/images/plan.ts` accepts credentials associated with
  custom/overridden hosts, then pins the outbound request destination to `api.x.ai`.
  That can disclose a custom proxy/API credential to another origin. The tests
  currently reinforce this path instead of rejecting it.

Scope IN:

- Confirm head `553e9afc`, base `dev`, merge state `MERGEABLE/CLEAN`.
- Compare actual diff and decide whether it can be merged independently.
- Identify paid-provider, download/SSRF, artifact, and routing surfaces.
- Leave a request-changes comment requiring credential-origin binding, negative tests
  for overridden `xai` and `cli-chat-proxy.grok.com`, rebase onto current `dev`, and
  fresh checks.

Scope OUT:

- Do not accept a new image-generation default or paid xAI routing decision.
- Do not merge #424/#528 automatically.
- Do not resolve the #424 vs #355 product choice in this phase.

Verification:

- `gh pr view 528 --json ...`
- independent Sol review verdict
- GitHub comment URL if action is taken
