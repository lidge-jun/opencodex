# Phase 15 — PaohupByPaoZa × WebMCP Agent-Native Workspace

PaohupByPaoZa exposes the same Agent OS capabilities to two first-class
interfaces:

- Human interface: the existing React dashboard (#brain and #demo).
- Agent interface: WebMCP tools registered through document.modelContext.

Both paths call the existing /api/agent-os/* application layer. WebMCP handlers
do not duplicate project, task, policy, approval, audit, scanner, or gateway
business logic.

## Runtime architecture

Dashboard UI and WebMCP registry both call the Agent OS management API, which
uses the shared services, policy/approval gateway, audit trail, and SQLite
store.

WebMCP API details are isolated in gui/src/webmcp/capability.ts and
gui/src/webmcp/registry.ts.

When WebMCP is unavailable, the app remains fully usable and displays
WebMCP unavailable with tools hidden.

## Demo route

Open http://127.0.0.1:10100/#demo.

The deterministic Smart Factory scenario shows project state, pending human
approvals, WebMCP tool activity, and the shared Agent OS audit trail.

The demo does not upload to Adobe Stock and does not expose arbitrary shell or
filesystem access.
