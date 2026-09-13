---
title: Why v1 is the default sub-agent surface
description: What the v2 encrypted-task limitation breaks, why OpenCodex now ships v1, and what to do if you still want v2.
---

OpenCodex installs with the sub-agent surface set to **v1**. The Dashboard, Models and Subagents
pages all ask you to confirm before moving to **base** or **v2**, and this page is what that
confirmation links to. The CLI does not prompt.

The reason is narrow and specific: on v2, a task handed from a ChatGPT-native model to a routed
model cannot be read by the routed model. That is the single most common way people delegate —
a GPT parent spawning a Grok, Claude or GLM child — and on v2 it fails every time.

## What you see when it happens

The spawn is rejected rather than silently producing an empty child task:

```json
{
  "error": {
    "code": "unreadable_encrypted_agent_task",
    "message": "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model."
  }
}
```

HTTP 400, and the ciphertext is never echoed back. Failing closed is deliberate: forwarding an
unreadable payload would give the child an empty instruction and a confidently wrong answer.

## Why it happens

![Two lanes compare the same delegation. On v1 a ChatGPT parent sends a plaintext task through OpenCodex, it crosses the provider boundary, and the routed child reads it. On v2 the parent sends encrypted_content minted by the ChatGPT backend; OpenCodex cannot decrypt it, so the task stops at the provider boundary and the request fails with unreadable_encrypted_agent_task.](../../../assets/subagent-v2-encrypted-task.svg)

On v1 the parent emits the child's task as plain text. OpenCodex reads it, routes it, and the
routed child receives something it can act on.

On v2 the parent emits the task as `encrypted_content`, minted by the ChatGPT backend. The key
stays in that backend. OpenCodex never had it, so there is nothing for a proxy to decrypt and
nothing to rewrite — the value really is ciphertext, not plaintext behind a flag. That is why
this is structural rather than a misconfiguration, and why no proxy-side setting can fix it.

Three topologies are unaffected, which is worth stating because it explains the shape of the
failure rather than the failure being mysterious:

| Topology | v1 | v2 |
| --- | --- | --- |
| ChatGPT parent to routed child | works | **fails** |
| Routed parent to routed child | works | works |
| ChatGPT parent to ChatGPT child | works | works — the backend can decrypt what it minted |

The backend can always read its own ciphertext. Only the boundary crossing breaks.

## Is it fixed upstream?

Not yet, and not for the half that matters. Upstream merged
[openai/codex#35845](https://github.com/openai/codex/pull/35845), which added support for
plaintext collaboration messages — but that is the *receiving* side. It handles plaintext that
was already produced; it does not make an OpenAI parent produce it.

The sending side is still open:
[#36376](https://github.com/openai/codex/issues/36376), reproduced across CLI 0.146 to 0.151 on
Windows, macOS and Linux, and [#37197](https://github.com/openai/codex/issues/37197), which
states the missing piece directly — a sending-side delivery policy. Neither has a maintainer
commitment or an ETA.

OpenCodex recorded the consequence as [#92](https://github.com/lidge-jun/opencodex/issues/92),
closed as not planned: nothing in this repository can fix it, so the issue is a pointer to the
upstream work rather than a task waiting on a maintainer here.

## What the three modes do now

| Mode | Surface | When to choose it |
| --- | --- | --- |
| **v1** (default) | Every model advertises the classic namespaced spawn tools. A spawn can name another model directly. | Anyone who delegates across providers. This is the shipped default. |
| **base** | Upstream model pins: Sol and Terra use v2, Luna uses v1, unpinned models follow Codex's own flag. | You want Codex's intended per-model surface and you only delegate within one provider. |
| **v2** | Every model advertises the flat concurrent tools. | You want the newer concurrent session model and your parent and child are on the same side of the boundary. |

base is listed second rather than first because its pins put Sol and Terra — the two models most
people delegate *from* — on v2. base is not a middle setting for this problem; for a
ChatGPT-to-routed spawn it behaves like v2.

## If you already chose base or v2

Nothing was changed for you. Upgrading to a release that ships this default does not rewrite an
existing setting; the dashboard raises the notice once and waits for an answer.

- **Continue** keeps the mode you are on and stops asking.
- **Switch to v1** applies v1 and stops asking.

Either answer is recorded, and the notice does not come back. Dismissing it without answering
leaves it for the next time you open the dashboard.

Mode changes apply to **new** Codex sessions. Start a new session after choosing; if a long-running
App host still shows the old surface, run `ocx sync` and restart that surface.

## If you want v2 anyway

Four routes, in the order most people should try them:

1. **Keep ChatGPT on v1.** Inside v2, the `keepNativeChatGptOnV1` switch leaves Sol and Terra on
   the v1 surface so they can still spawn Grok or Claude, while routed parents get v2. This is the
   closest thing to having both.
2. **Delegate within one provider.** A routed parent spawning a routed child is plaintext on v2
   and works normally.
3. **Trust a direct key-auth Responses relay.** A provider you explicitly mark with
   `allowEncryptedV2AgentTasks: true` receives the opaque payload instead of the 400. Only do this
   for a destination you know can consume it.
4. **Enable `agentTaskRecovery`.** Experimental and off by default. It recovers most fresh spawns
   through the ChatGPT backend, at the cost of quota, latency and a dependency on undocumented
   behavior, and it still loses message-type follow-ups and multipart envelopes.

See [Sub-agent Surface](/guides/sub-agent-surface/) for the full mechanics of each, and
[Agent configuration](/reference/configuration/agents/) for the settings themselves.

## When this page goes away

When an upstream release makes a ChatGPT-native parent emit a routed child's task as plaintext,
the reason for the default disappears with it. At that point the default moves back to base, the
confirmation stops appearing, and this page becomes history rather than advice.

## Changing the mode

Dashboard, Models and Subagents all carry the same v1/base/v2 switch, and all three ask before
base or v2. From the CLI:

```bash
ocx v2 status
ocx v2 mode v1
```

The CLI does not prompt. It is the same setting, so choose it knowing what this page describes.
