# Callback retirement implementation and evidence

Carried #4280 at 1f826d92c7205f31ce174bbd987c04b2b08f7da4 by luvs01. Every callback-listener response uses a closing response helper; state validation, HTML escaping and graceful shutdown stay unchanged. Runtime, xAI and transport inventory ownership docs are updated. Tests retain two fixed-port flow scenarios and add malformed/provider-error response checks; onAuth microtask readiness and per-flow abort/finally cleanup replace polling waits.

Necessity/source search: closingResponse and loopbackBindHostnames in callback-server.ts; no existing response-closing owner found. Reuse existing OAuthCallbackFlow and ManualFallbackFlow. The only new production helper is private and joins two response sites. Local tests/build/typecheck/install: NOT RUN. git diff --check is a whitespace check only. Independent implementation/security read and hosted CI follow publication; no bug-fixed claim until execution evidence exists.

This first delivery includes the accounts roadmap documentation checkpoint; product delta is callback-only. Other features remain unimplemented and their docs describe pending work. Original #4280 stays open for coordinator disposition after integration. No merge is performed here.

Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>
