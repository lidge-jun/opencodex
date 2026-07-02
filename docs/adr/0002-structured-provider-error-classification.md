# ADR 0002: Structured Provider Error Classification

## Status

Accepted

## Context

Routed providers can fail in three different shapes: direct non-2xx HTTP responses, inline error
frames inside a 200 streaming response, and transport/read failures after a stream has started.
The old bridge collapsed most inline adapter errors to a message-only `502 upstream_error`. The
classifier then looked for text such as `rate limit` and could produce `rate_limit_exceeded` even
when the upstream did not return HTTP 429 or a structured rate-limit code.

That was especially risky for compatibility providers such as Umans, where an upstream gateway can
include rate-limit wording in a generic Anthropic-style error while the user's billing/usage limit is
not actually exhausted.

## Decision

Adapters now preserve structured upstream error metadata when it exists:

- `status`: HTTP-like status inferred from provider code/type or explicit numeric fields.
- `code`: provider/OpenAI-style error code such as `rate_limit_exceeded`.
- `errorType`: provider enum/type such as `rate_limit_error`, `RESOURCE_EXHAUSTED`, or
  `ThrottlingException`.

The bridge passes that metadata to the shared classifier. The classifier treats rate-limit as
confirmed only when the actual status is `429` or a structured provider code/type says rate-limit.
Plain message text alone no longer turns a `502` stream failure into `rate_limit_exceeded`.

## Consequences

- False 429/rate-limit reports from message-only compatibility errors are reduced.
- Real provider rate limits still surface as Codex-compatible `rate_limit_exceeded` when upstream
  sends HTTP 429 or structured code/type metadata.
- Stream truncation and read failures are explicitly marked as upstream stream errors rather than
  silently completing or being guessed from provider prose.
