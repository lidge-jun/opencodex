# Cursor Tool Calling Hardening — v2.7.15

## Objective
Improve Cursor tool calling reliability by guiding the model toward Codex
bridge tools (exec_command, apply_patch) when native exec is rejected.

## Research (cxc-search, 2 parallel explorers)
- Cursor forum: tool calling breaks through OpenAI-compatible proxies (format mismatches)
- Cursor Agent sends Responses API format instead of Chat Completions to custom endpoints
- Cursor hardcodes Anthropic-flavored tool schemas (input_schema vs parameters)
- Model-name-based routing hijacks custom endpoints
- Proxies that strip tool_choice/parallel_tool_calls break tool calling silently
- Known Bun issues: zstd corruption (#20053), gzip ShortRead (#8017), CONNECT proxy (#30381)

## Architecture Context
opencodex Cursor adapter has two tool execution paths:
- Path A (Responses Bridge): exec_command/apply_patch as MCP tools — always works
- Path B (Native Exec): read/write/shell/grep/ls/fetch — controlled by nativeLocalExec policy

## Changes (commit 04cb520)

### Rejection message improvements
When nativeLocalExec="off" (default), rejection messages now guide the model
toward bridge tools instead of suggesting config changes:
- native-exec-fs.ts: "Use exec_command (cat/head/ls/rg/grep) + apply_patch"
- native-exec-shell.ts: "Use exec_command to run shell commands"
- native-exec-network.ts: "Use exec_command with curl/wget"

### Tool guidance enhancement
- tool-definitions.ts: Added fallback guidance note to system prompt —
  "If a built-in operation is rejected, use exec_command instead"

### Security decision (sol review)
sol (gpt-5.6-sol) audited the plan and rejected changing the nativeLocalExec
default from "off" to "codex-sandbox":
- Loopback data plane is unauthenticated
- codex-sandbox trusts caller-controlled prose regex
- Path A already works — better fallback guidance solves the problem
- Default stays "off"; codex-sandbox remains an explicit opt-in

### Tests
Updated 3 test files to match new rejection message strings:
- cursor-native-exec.test.ts (7 assertions)
- cursor-native-exec-policy.test.ts (1 assertion)
- 46/46 tests pass, 206 expect() calls

## Release
- Version: v2.7.15
- Tag: v2.7.15 (pushed)
- Branches synced: main = dev = preview = d70971f4
