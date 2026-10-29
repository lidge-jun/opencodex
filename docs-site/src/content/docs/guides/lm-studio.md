---
title: LM Studio strict chat templates
description: Configure one leading system message for LM Studio Chat models.
---

The **LM Studio (local)** preset enables `singleLeadingSystemMessage: true` for
the `openai-chat` adapter. This combines text-only system/developer instructions
into one leading system message with blank lines between messages. It supports
custom model IDs, including quantization and checkpoint suffixes, without relying
on the model-name compatibility selector.

For an existing renamed/custom LM Studio provider, add this boolean explicitly
in the provider editor. The stored value is independent of the provider name,
hostname, and port. A same-destination save preserves an omitted setting; a POST
that replaces the destination must resubmit it. PATCH accepts a boolean or `null`
to clear the override. Clearing it on the canonical LM Studio provider restores
the preset default.

Set `singleLeadingSystemMessage: false` to disable merging for a template that
accepts chronological instruction messages. Other presets keep their defaults.
`foldDeveloperRoleToSystem` continues to control only the developer role; enabling
single-message compatibility takes precedence over that role choice and the
model-name-based late-instruction workaround.

Hoisting later instructions changes their chronological scope and can invalidate
prompt-cache prefixes. Translated requests preserve IR instruction order: base
system prompts first, followed by timeline developer instructions. The Responses
parser already collects input system items into the base prompt, so their original
positions relative to developer items are not recovered. Direct Chat passthrough
preserves the original relative order of system/developer messages. Both paths
normalize the outbound copy and keep user messages and tool pairs in order.

Non-text system/developer parts in direct Chat fail explicitly rather than being
silently discarded. Translated developer documents keep their file parts in a
user-compatible message at the existing timeline slot while their text joins the
leading system message. Developer image/audio messages keep their existing
user-compatible mapping. No LM Studio runtime is required to configure this flag;
the served model's template still determines which other wire features it accepts.
