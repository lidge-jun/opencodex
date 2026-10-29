---
title: Microsoft 365 Copilot
description: Sign in to Microsoft 365 Copilot and discover your account's live chat models through OpenCodex.
---

Microsoft 365 Copilot is an experimental native provider, separate from GitHub Copilot. It connects directly to Microsoft's private ChatHub WebSocket service. It requires a work or school account with access to Microsoft 365 Copilot Chat; personal Microsoft accounts are not supported. Availability and quotas remain controlled by Microsoft.

The repository owner granted the built-in preset a canonical-provider policy exception; the independent maintainer security re-review passed on implementation head `359a57431b` (October 28, 2026). Exact-head CI status is tracked separately on the pull request. The private endpoints described below are observed behavior, not a Microsoft-published API contract.

## Sign in

In Providers, add **Microsoft 365 Copilot** and select its sign-in action. Alternatively, run:

```sh
ocx login m365-copilot
```

OpenCodex detects the default supported browser (Firefox, Chrome or Edge) and opens one isolated sign-in window. Complete Microsoft's sign-in and MFA there, and keep it open while the Copilot model picker loads. Moving its URL to another browser prevents local callback capture. OpenCodex captures the code and account-matched Copilot web session locally, closes the temporary window and stores them through its normal protected OAuth account store. No callback URL or password needs to be pasted into OpenCodex or a chat.

This window does not reuse your regular browser profile. Microsoft's existing M365 Chat Client registration rejects OpenCodex's ordinary localhost redirect with `AADSTS50011`; the captured native-client callback is used instead. The account retains cached access and refresh tokens, so later requests normally refresh silently. A local desktop and a supported installed browser are required for interactive sign-in. Headless code-display login is not supported.

## Models and requests

ChatHub inference honors provider HTTP(S) proxies and bypass settings, including inherited global proxy settings. SOCKS proxies and custom provider fetch executors are unsupported for this WebSocket transport and stop the turn with a configuration error before dialing. An opaque request-scoped fetch executor is refused before preparing or uploading images; only the built-in executor's explicit socket route can authorize native dialing. Use an HTTP(S) proxy, or explicitly configure direct access or a matching bypass rule if your network policy allows it.

The provider reads available model choices directly from your account's Microsoft Copilot chat picker, including Claude/GPT submenus. The Live models switch enables refresh through the shared five-minute catalog cache. New choices follow OpenCodex's existing new-model policy and your saved selections; a new Microsoft selector does not require an OpenCodex release. The default selector is `Magic` (Auto). Quota-disabled choices can remain listed because Microsoft still grants access after the quota resets.

Existing installs must sign in again once to capture the web session and enable Live models. Old request aliases still work, but discovery lists Microsoft's native selector IDs. Discovery requires a valid Copilot web session independently of the chat access token. If Microsoft expires that session, OpenCodex retains the last successfully fetched list and requires sign-in again to refresh it. No static alias list is presented as account discovery. Microsoft does not publish context windows in this picker metadata.

Use the provider namespace when selecting a model:

```text
m365-copilot/Magic
m365-copilot/Claude_Sonnet
m365-copilot/Gpt_61_Sol_Reasoning
```

Text streams and client-executed tools travel through OpenCodex's existing request interfaces. Tool calls are prompt-emulated: the model emits a fenced call, OpenCodex translates it into the client's tool format, and the client executes it under its own permissions. Conversations are scoped to the Microsoft account, model, client session and tool set. Temporary chats keep their live conversation context without adding a persistent Copilot history entry.

Every ChatHub turn also includes Microsoft's built-in `BingWebSearch` tool in the upstream request. It is sent regardless of whether client tools are enabled, and the model may use web search on its own; OpenCodex does not control that server-side capability.

In a failover combo, a Copilot quota refusal before any output advances to the next eligible model or provider when fallback is enabled. Empty thinking placeholders do not count as output. A refusal after real reasoning, text or a tool call stays with that model to avoid replaying a committed turn.

The provider accepts text and images, including screenshots returned by client tools. Microsoft's model picker supplies no per-model image flag, so OpenCodex declares text + image for all discovered chat choices using the shared Copilot image attachment protocol. PNG, JPEG, GIF and WebP inputs are supported, with at most four new images per turn and 5 MiB per image. Images upload to Microsoft for the conversation; failed uploads stop the request instead of silently losing the attachment. Public HTTPS image URLs are downloaded without credentials or redirects, with local/private destinations refused. Older images stay in the conversation without repeated uploads.

The provider creates no Copilot Studio agents, installs no browser extension, and needs no standalone Copilot proxy or admin console. Image generation is not advertised. It is not an official Microsoft integration, and Microsoft's private protocol can change. Image reading was verified through OpenCodex with Claude_Sonnet and Gpt_61_Sol_Reasoning on October 27, 2026; individual image capability for every other selector has not been tested.

## Identity and sources

The OAuth client ID is `c0ab8ce9-e9a0-42e7-b064-33d422df41f1`, Microsoft's **M365 Chat Client**, identified in [Microsoft's Entra documentation dictionary](https://github.com/MicrosoftDocs/entra-docs/blob/main/.docutune/dictionaries/known-guids.json). It is a public application identifier, not a secret or an app registered by the proxy author. Your local OpenCodex process receives the authorized tokens; using a Microsoft application ID does not itself establish the safety of third-party software.

Protocol and tool-framing code is adapted from [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy/tree/65905e881d6597040966aff9b087aa9a908b358a), with its MIT notice retained. The service is operated by Microsoft; your organization's Microsoft agreement and [Microsoft 365 product terms](https://www.microsoft.com/licensing/terms/productoffering/Microsoft365/all) govern access. Verification on October 26, 2026 covered real Firefox sign-in, Chrome/Firefox callback capture, streamed text and a client tool-result round-trip with `claude-sonnet`. Other aliases have not been individually live-verified.

## Evidence and admission status

The primary sources below were checked on **October 28, 2026**. They establish Microsoft's service identity and documented API offering; they do not establish support or authorization for this connector's private protocol.

| Requirement | Evidence and remaining gap |
| --- | --- |
| Documented chat endpoint | Microsoft's [Chat API overview](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/chat/overview) and [conversation reference](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/chat/copilotroot-post-conversations) document `POST https://graph.microsoft.com/beta/copilot/conversations`. This connector instead uses `wss://substrate.office.com/m365Copilot/Chathub/{account}`. No Microsoft-published contract for that ChatHub endpoint was found. |
| Authenticated model discovery | This connector reads `GET https://copilot.cloud.microsoft/chat/` using account-bound web cookies and parses the main chat picker's `modelSelectorMetadata` from page bootstrap data. It was live-tested on October 27, 2026. No Microsoft API reference for that bootstrap schema or an authenticated OpenAI-compatible model-list endpoint was found. OpenCodex's local `/v1/models` is not an upstream API contract. |
| Operating entity and terms | The [Copilot API Terms of Use](https://learn.microsoft.com/en-us/legal/m365-copilot-apis/terms-of-use) name **Microsoft Corporation** and define the APIs they cover. The [Microsoft 365 Product Terms](https://www.microsoft.com/licensing/terms/productoffering/Microsoft365/all) and the customer's own Microsoft agreement remain relevant to the service. These links establish the documented offering's terms, not permission for the private endpoints. |
| Model supply and routing authorization | Microsoft's [privacy documentation](https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-privacy), [Anthropic subprocessor documentation](https://learn.microsoft.com/en-us/copilot/microsoft-365/connect-to-ai-subprocessor) and [OpenAI subprocessor documentation](https://learn.microsoft.com/en-us/copilot/microsoft-365/openai-subprocessor) describe model supply and tenant controls. OpenCodex sends directly to Microsoft and does not resell access or send credentials to a third-party gateway. Those sources do not establish authorization to reuse the private ChatHub protocol or first-party app registration. |
| Authentication identity | Microsoft's [Entra application dictionary](https://github.com/MicrosoftDocs/entra-docs/blob/main/.docutune/dictionaries/known-guids.json) identifies the client ID as M365 Chat Client. That proves the name, not permission for this connector to reuse it. The documented Graph Chat API has separate delegated permissions and requires a Copilot add-on license; this PR does not switch to that API or request its broader permissions. |
| Maintenance contact | **@x3M3x**, the PR author, is the proposed connector maintenance contact. Report breakage through the repository's Provider or API compatibility issue form with the connector ID, OpenCodex version, browser and redacted error. The ownership arrangement is proposed pending acceptance; it implies no Microsoft affiliation or support commitment. |

The documented-endpoint and private-protocol-authorization gaps remain. The repository owner's exception permits consideration of this preset under repository policy; it does not establish Microsoft authorization. Successful tests establish functionality only.
