---
title: "Google Vertex AI"
description: How a Vertex AI provider discovers its models, which credential discovery uses, and how Gemini 4 models handle tool images.
---

This page covers behavior specific to the Google Vertex AI provider (`google-vertex`, or any
Google provider with `googleMode: "vertex"`). Setup and credentials are described in
[Providers](/guides/providers/).

## Model discovery

A Vertex AI provider with live models lists Google's publisher models and follows every page of
the listing. It shows Gemini and Gemma chat models and leaves out embedding, speech, Live API,
Imagen and Veo models, and image-output Gemini models such as `gemini-3.1-flash-image`, whose
model cards list function calling as unsupported.

Discovery uses the provider's own credential: a `gcp-sa:` service account, a key, or with neither
configured, `GOOGLE_CLOUD_API_KEY` and then Application Default Credentials. If a configured
`keychain:` or `$VARIABLE` key cannot be read, discovery stops instead of trying another
credential, the same way requests refuse to start. When the listing cannot be read completely,
OpenCodex keeps the previous or configured models rather than publishing part of the list.

Reasoning levels follow the preset: Gemini 4 Hydrogen offers low, medium, high (the default) and
xhigh; Gemini 4 Carbon and Argon offer low, medium and high. A model the preset gives no levels
to, such as `gemini-3-pro`, shows none, because requests to it carry no thinking level.

## Tool images on Gemini 4

On Vertex AI, `gemini-4-argon`, `gemini-4-carbon` and `gemini-4-hydrogen` receive images
returned by tools, such as screenshots, inside the matching function response. On Argon this
avoids the upstream 400 error "Requests ending with a model turn are not supported" after an
image-producing tool call; Carbon and Hydrogen use the same documented function-response form,
though that error was not reproduced on them. Images from duplicate results or results
without a matching call are preserved in a separate message after the tool responses, with a
marker explaining that they could not be paired. No configuration change is needed; this handling
is specific to these Gemini 4 models on Vertex.
