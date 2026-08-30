# WebMCP Tools

| Tool | Risk | Read-only | Shared surface |
|---|---:|---:|---|
| get_workspace_status | R0 | yes | projects, tasks, approvals |
| create_stock_project | R2 | no | project registry |
| generate_stock_ideas | R1 | yes | deterministic demo service |
| generate_video_prompt | R1 | yes | deterministic prompt service |
| start_render_job | R3 | no | task queue and approval reference |
| get_render_status | R0 | yes | task API |
| review_asset | R1 | yes | deterministic review adapter |
| generate_stock_metadata | R1 | yes | deterministic metadata adapter |
| prepare_stock_export | R3 | no | manifest-only export with approval |

All tools declare JSON input schemas, WebMCP annotations and risk tiers.
Runtime validation rejects missing or oversized values, unsupported enums and
path traversal strings before any service call.

Every execution posts a safe audit record to /api/agent-os/audit. The server
stores an SHA-256 input digest and a redacted summary, not raw credentials.
