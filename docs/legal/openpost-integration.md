# Legal and Licensing Boundary — OpenPost Integration

**Upstream Project:** OpenPost (`https://github.com/getopenpost/openpost`)  
**License:** AGPL-3.0-only  
**Integration Boundary:** Network Service Boundary (HTTP API / MCP)

## Engineering Policy

1. **No Code Merging:** OpenPost source code is not copied, vendored, or compiled into Pao-hubPro core repositories.
2. **Network Protocol Boundary:** All interactions between Pao-hubPro and OpenPost occur across a network protocol boundary via standard HTTP REST requests and Model Context Protocol (MCP) tool executions.
3. **Deployment Separation:** OpenPost is deployed as an independent container or service process. Pao-hubPro acts solely as a client orchestrator.
4. **Secret Isolation:** Social media provider credentials (OAuth tokens, refresh tokens, client secrets) are stored exclusively in OpenPost's persistent storage and are never exposed or synchronized to Pao-hubPro databases or agent context.

