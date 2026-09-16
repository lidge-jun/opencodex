# Self-Hosted OpenPost Deployment for Pao-hubPro

Phase 20.60 integrates Pao-hubPro with OpenPost (`https://github.com/getopenpost/openpost`), an AGPL-3.0-licensed open-source multi-platform social media publishing suite.

## Architecture Boundary

Pao-hubPro and OpenPost run as separated services communicating via HTTP REST API and MCP:
- **Pao-hubPro**: Orchestration, policy evaluation, human approval workflow, master content briefs, rendition planning, audit logging, and cross-platform analytics.
- **OpenPost**: Provider OAuth connections, provider token storage, delivery execution, and social network API interaction (X, Mastodon, Bluesky, LinkedIn, Threads, Instagram, TikTok, YouTube, Discord).

## Quick Start

```bash
cd deploy/openpost
cp .env.openpost.example .env
# Edit .env with your secrets
docker compose -f docker-compose.openpost.yml up -d
```

Verify service health:
```bash
curl http://localhost:8080/api/v1/health
```

Register instance in Pao-hubPro:
```bash
ocx social instances register --name "Production OpenPost" --url "http://localhost:8080"
```

