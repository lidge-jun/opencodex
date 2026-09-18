# Evidence: is the v2 encrypted-task limitation fixed anywhere?

Collected 2026-09-13 with the Aside browser agent against public GitHub, to check that
this unit is not shipping a warning about something already solved.

## Upstream (openai/codex)

| Item | State | What it actually covers |
| --- | --- | --- |
| #35845 Support plaintext collaboration tool messages | merged, 0.147.0-alpha.1 | The receiving half only. It handles plaintext that was already produced, gated on the `encrypted_function_args: []` marker. It does not make an OpenAI parent emit plaintext. |
| #36892 Support leaf models in multi-agent v2 | merged | Fixed the Sol/Terra plus Luna case. Does not touch cross-provider delivery. |
| #36376 OpenAI parent still sends an encrypted v2 task to a non-OpenAI child | open | Reproduced across CLI 0.146 to 0.151 on Windows, macOS and Linux. |
| #37197 Plaintext support does not complete cross-provider delivery | open | The clearest statement that a sending-side policy is the missing piece; the reporter built and validated a local `message_delivery = "plaintext"` policy. |
| #32031 spawn_agent hides model overrides | open | Adjacent; no maintainer response. |

None of the open issues has an official maintainer response or an ETA. So the sending side
is unfixed, and it is the side that matters here.

## Why a proxy cannot paper over it

With an OpenAI parent the value in `encrypted_content` is real Fernet-shaped ciphertext
(`gAAAA...`), not a plaintext assignment behind a marker. A proxy that rewrites the field
has nothing to rewrite it from. The fix has to come from the parent side emitting the
plaintext marker, which is exactly the path #35845 does not open for OpenAI parents.

## Scope of the failure

Affected: v2 with a ChatGPT-native parent and a routed child. Observed with Sol to Grok,
Astra to Grok, Luna and Astra to Claude, DeepSeek, GLM and others. It is not model
specific; no routed child can read backend ciphertext.

Unaffected: v1 in any topology, routed parent to routed child under v2, and native parent
to native child under v2 (the backend can decrypt what it minted).

Already handled here: the mid-thread native-to-routed model switch, fixed by #4135, and
the opt-in `agentTaskRecovery` path, which recovers most fresh spawns but still loses
message-type follow-ups and multipart envelopes (#3661).

## Conclusion for this unit

The warning is accurate and the default change is justified. v1 is the surface maintainers
and users both name as the reliable one for cross-provider delegation, and there is no
upstream commitment that would make this advisory short-lived by accident.
