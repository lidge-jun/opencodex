---
title: Ollama-compatible clients
description: Point tools that speak the Ollama API at opencodex and use your configured provider models.
---

opencodex answers a subset of the Ollama HTTP API, so a tool that only knows how to talk to Ollama
can use the models you already configured in opencodex. Requests are translated onto the Chat
Completions path and sent to the selected provider. opencodex does not download, store or run
models on your machine.

## Connect a client

Use the proxy address as the Ollama host. For a default local install:

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

When the proxy requires an API key (for example on a `0.0.0.0` bind), send it the same way as for
`/v1/chat/completions`, for example `Authorization: Bearer <opencodex key>`. A key with a model
scope only sees and uses the models it is allowed to. The endpoints are served on the main listener
only; the unauthenticated loopback listener, Remote Link and the hub management ingress do not
expose them.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /api/version` | The opencodex version. |
| `GET /api/tags` | Configured provider models as `provider/model` names. |
| `POST /api/show` | `{ "model": "provider/model" }` returns only known facts; no file size, digest, template or license. |
| `POST /api/chat` | Chat with `system`, `user`, `assistant` and `tool` messages. |
| `POST /api/generate` | Single prompt with optional `system`. |

Every other `/api/*` path stays part of the opencodex management API.

## Supported request fields

- `model`: a name from `/api/tags`.
- `stream`: defaults to `true` (newline-delimited JSON). Set `false` for one JSON response.
- `images`: base64 PNG, JPEG, GIF or WebP on user messages (chat) or the request (generate).
- `tools` (chat only): function tools. Send the assistant message back unchanged, including each
  call's `id`; a `tool` result is matched by `tool_call_id` or, failing that, by `tool_name`.
- `options`: `temperature`, `top_p`, `num_predict` and `stop`.
- `format`: `"json"` only.

Each `/api/chat` request accepts at most **1,024 tool calls in total** across all assistant messages,
including calls that already have tool results. Above this limit, the request returns HTTP 400
before reaching a provider. Shorten the conversation history and resend it, keeping each retained
tool result together with its corresponding assistant tool call.

Anything else is rejected with HTTP 400 instead of being ignored. That includes `think`,
`keep_alive`, `suffix`, `raw`, `template`, `context`, other `options`, JSON-schema `format` and image
URLs. Ollama's model-management and embedding endpoints are not provided.

Combos, routing policies, `--fast` or effort aliases, and providers that forward the caller's own
credentials cannot be selected here. Requests for them fail before anything is sent upstream.

## Responses

A finished reply carries `done: true` with `done_reason` set to `stop`, `tool_calls` or `length`.
`prompt_eval_count` and `eval_count` appear when the provider reported usage; duration fields are
not reported. A stream sends exactly one `done: true` line, after the upstream reply has fully
completed.

Errors use the Ollama shape `{ "error": "message" }` and keep the HTTP status, including
`Retry-After` on rate limits and busy refusals. A reply stopped by a content filter or for an unknown
reason is returned as an error, never as a normal stop. If a stream fails after it started, its last
line is an `error` object and no `done: true` line follows.

Requests appear in the dashboard request log like other traffic, and the response header
`x-opencodex-request-id` names the matching row.
