---
title: TRAE CN (ACP)
description: Connect OpenCodex to the signed-in official TRAE CN CLI.
---

The experimental `trae-cn` adapter can be configured manually through `custom`. Its directory
entry is reference-only; canonical promotion awaits a maintenance owner, vendor discovery and
forwarding evidence, and security review. It uses the signed-in official CLI through `traecli acp serve`.
OpenCodex does not read desktop tokens, private IDE endpoints, or Ferry.

```json
{
  "providers": {
    "trae-cn": {
      "adapter": "trae-cn",
      "baseUrl": "https://www.trae.cn",
      "keyOptional": true
    }
  }
}
```

- **Prerequisites:** Install and sign in to [TRAE CN](https://www.trae.cn/) and its official CLI
  on the host running the OpenCodex proxy. A remote dashboard uses that host's CLI session.
  The CLI owns authentication and token refresh; the provider needs no API key.
  OpenCodex preserves the default `~/.trae` CLI directory while isolating HOME. Set `TRAE_HOME`
  before starting OpenCodex to select a different signed-in CLI directory.
- **Model discovery:** The tested signed-in CLI returned model IDs through `session/new` →
  `models.availableModels[].modelId`. This is observed CLI behavior. The [vendor ACP documentation](https://docs.trae.cn/cli_agent-client-protocol)
  does not document these discovery fields or guarantee their account scope.
  Successful discovery is cached by the normal provider catalog mechanism, with the last good
  catalog and explicitly configured models as degraded fallbacks.
  Read-only catalog gathers and management admission use cached evidence; they never start the CLI or refresh its sign-in.
  The automatic refresh worker prepares CLI evidence before its next catalog convergence, so a slow CLI does not delay unrelated management responses.
  Set `liveModels: false` for a static allowlist; **Test connection** then returns not applicable.
  After switching CLI accounts, enable live discovery and run **Test connection**. It
  replaces the roster and refreshes Codex and connected clients. It reports pending or failed
  publication separately; restart running Codex sessions after publication.
  The probed roster stays available while publishing under memory pressure. If it cannot fit
  the memory budget, the probe reports pending retention; retry after active requests finish.
  A probe overtaken before updating the model cache asks you to retry. Disk-only edits require
  reloading provider configuration and testing again.
- **Transport:** Each turn opens a fresh ACP session for the selected model and streams text and reasoning.
  Conversation history is replayed as labelled text. The limit is 1,000,000 UTF-16 code units
  (JavaScript string length); an emoji may use two units. Oversized replay is rejected.
- **Capability boundary:** This initial provider supports text conversations only. It rejects
  client tools, tool replay, images, audio, video and attached documents. Model capability overrides
  cannot enable native image input or verbosity. Images require the vision sidecar to describe them first.
  Permission requests fail with `trae_client_request_unsupported`; internal tool notifications fail
  with `trae_tool_call_unsupported`. An empty `end_turn` fails with `trae_empty_response`; `max_tokens` without text stays incomplete.
  These completions and refusals retain usage. OpenCodex does not replay a dispatched TRAE prompt on another provider.
  Client cancellation emits no provider error and preserves already-received usage for accounting.
  Cancellation initiated by the CLI returns an incomplete turn.
  Unsafe local spend-ledger files produce the shared `spend_ledger_storage_unavailable`/503
  diagnostic; follow its local-storage recovery instructions before retrying.
  Requests with an output-token limit fail with `unsupported_max_output_tokens` because this
  adapter has no verified ACP field for that limit. ACP `max_turn_requests` returns an incomplete turn with that reason.
- **CLI process:** The CLI uses an empty temporary workspace, no session MCP/skills and a finite tool denylist.
  Shutdown targets the owned POSIX process group or Windows Job Object (Windows 10+, PowerShell 5.1). POSIX descendants
  that detach into another group can survive; this mechanism does not contain untrusted hooks or tools.
  Use a trusted CLI and configuration: its hooks and unlisted tools are outside OpenCodex's
  client-capability controls. Temporary directories and tool denial do not provide an OS sandbox.
- **Destination:** `https://www.trae.cn` identifies this provider; OpenCodex does not call it
  directly. A custom destination is refused. This row is separate from TRAE International and
  from a custom OpenAI-compatible provider named `trae`.
- **Network routing:** The official CLI owns its network route. Provider `proxy` and `noProxy`
  overrides, including `direct` and `null`, are rejected before CLI startup. OpenCodex does not
  change system proxy settings.
