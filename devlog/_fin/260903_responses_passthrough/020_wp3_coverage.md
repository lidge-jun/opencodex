# 020 — wp3: passthrough regression coverage (unknown usage keys survive)

## Goal

Pin the passthrough contract so a future whitelist rebuild cannot silently drop usage extras.

## Tests

- Forward SSE with usage extras reaches the client (terminal block intact when no rewrite fires).
- Non-streaming forward JSON: extras survive.
- WS normalization (ws-upstream): response.done with usage extras → client frame keeps them.
- A usage-less response.completed stays accepted (#37138 adjacency).
- Bridge rebuild keeps extras (wp2 suite).

## Stack

Branch wp3 (codex/responses-usage-coverage) on top of wp2's branch head; PR targets wp2's branch
per DEV-STACK; retarget to dev after the parent merges.

## Close-out (D)

- ab0a19f9e: 4 tests pin unknown usage keys on forward SSE, non-streaming JSON, WS response.done
  normalization; usage-less completed stays accepted.
