---
title: "Fallback off"
description: Turn model and provider fallback off per scope, and see what happens on a Remote Link Child when its Home is unreachable.
---

OpenCodex can serve a request from a different model or provider when the one you chose fails: a
[combo](/guides/combos/) moves to its next target, a [routing profile](/guides/routing-profile-editor/)
tries its next candidate, a spawned subagent moves down its model fallback chain, and the main-account
hard lock can reroute to its configured fallback model. All of these stay on by default.

Turn a kind of fallback **off** when you would rather get a clear error than an answer from somewhere
you did not pick.

## What counts as a fallback

A fallback is a hop to a **different model** or a **different provider**:

| Kind | Example | Switch |
|---|---|---|
| Model fallback | `anthropic/claude-opus` fails, `anthropic/claude-sonnet` would answer | `model` |
| Provider fallback | `anthropic/claude-opus` fails, `openai/gpt-6-sol` would answer | `provider` |

Rotation among the accounts or API keys of **one provider pool** for the same model is not a fallback.
It is how a pool absorbs a rate-limited account, and it keeps working whatever you set here. Retrying
the same target, and transport fallbacks that keep the same target, are not fallbacks either.

When a main-account hard lock routes to a combo or profile, it refuses early only when every declared
destination is known to be policy-denied. Otherwise normal selection proceeds without filtering, and
its actual selected destination still follows these switches. Allowing provider fallback does not allow
a different model on the same provider when model fallback is off, even if another candidate is allowed.

## Turn fallback off

```bash
ocx fallback off                               # model and provider fallback, everywhere
ocx fallback off --kind provider               # only cross-provider hops
ocx fallback off --route combo/coding          # one combo, routing profile or model selector
ocx fallback off --provider anthropic          # hops that leave one provider
ocx fallback on --route combo/coding           # an exception under a global off
ocx fallback clear --route combo/coding        # remove an override
ocx fallback status                            # current settings and the last fallback
```

The same switches are on the dashboard: the **Fallback** card at the bottom of the **Dashboard** holds the
global switches, the overrides and the last fallback taken or refused.

### Precedence

1. A **device** set to off always refuses (see [per device](#per-device-settings)). A device setting can
   only refuse; turning it on never reopens a hop another scope refuses.
2. Otherwise the most specific setting wins: **route**, then **provider**, then **global**.
3. Nothing set means allowed, which is today's behavior.

The settings live in `config.json` under `fallback`:

```json
{
  "fallback": {
    "provider": false,
    "routes": { "combo/coding": { "provider": true } },
    "providers": { "anthropic": { "model": false } },
    "devices": { "lnk_0123456789abcdef": { "localFallback": false, "model": false } }
  }
}
```

A malformed leaf is ignored, so policy resolution uses the next applicable scope, and `ocx config`
diagnostics name it. A whole-config write that contains one is refused instead.

## The error you get

A refused fallback answers with the **status of the failure that triggered it**, so a refused 429 is
still a 429 with its `Retry-After`, and with this body:

```json
{
  "error": {
    "type": "fallback_refused",
    "code": "fallback_refused",
    "message": "combo/coding: anthropic/claude-opus failed (rate_limited). Provider fallback to openai/gpt-6-sol is off for route combo/coding, so OpenCodex did not send the request there. To allow it: ocx fallback on --kind provider --route combo/coding",
    "fallback": { "kind": "provider", "scope": "route", "scopeKey": "combo/coding",
                  "from": "anthropic/claude-opus", "to": "openai/gpt-6-sol", "trigger": "rate_limited" }
  }
}
```

The response also carries `x-opencodex-fallback: refused`. When the first target is already known to be
unavailable, the refusal happens before anything is sent, and the fallback target is never contacted.
The status depends on why the first target was skipped:

- A combo's first target cooling down, or with its quota spent: 429.
- A combo's first target disabled or not usable for the request: 503.
- A blocked main account: 429.
- An unavailable subagent model: 503.

After a real upstream failure, the refusal keeps that failure's status.

## Remote Link Children and Hub clients

A Remote Link Child and a Hub client never serve requests from their own local providers. When the
Home is unreachable, a Child answers a retryable `503` (and a Hub client's dashboard relay a `502`) with:

```json
{ "error": "link tunnel unavailable", "code": "home_unreachable", "message": "The Home is unreachable, and OpenCodex did not serve this request from this device's local providers. …" }
```

Nothing is sent to a local provider, and the link key and the request body never leave the device.

### Per-device settings

On the Home, each linked device has two switches, on **Remote Link** or with the CLI:

```bash
ocx fallback local on --device mac-studio      # permission for local fallback while the Home is down
ocx fallback off --device mac-studio           # refuse model and provider fallback for this device's requests
```

`--device` takes a link alias or id from `ocx link status`, or a Hub data key id.

**Local fallback** is a permission that GOAT reads: with it on, GOAT may move that device's work to the
device's own sign-ins while the Home is unreachable. OpenCodex itself still answers `home_unreachable`
and never serves the device locally. It is off unless you turn it on.

## Status

`ocx status --json` includes a `fallback` object (on a Child it is the Home's, read over the link), and
`GET /api/fallback` returns the same `ocx.fallback/1` document: the effective global switches, the
overrides, every device with its local fallback permission, and the last 20 fallbacks taken or refused
with time, route, from, to, trigger and the scope that decided. The list is kept in memory and resets
when the proxy restarts. It never contains request bodies, keys or account identities.

A Home that supports this advertises `fallback-policy/1` in `GET /readyz` `features`.
