# opencodex on Cloudflare

Runs the root `Dockerfile` image as a Cloudflare Container behind a Worker, with state kept in R2
between container runs. Setup, client configuration, and limits:
[Cloudflare Deployment](https://opencodex.me/guides/cloudflare/)
(source: `docs-site/src/content/docs/guides/cloudflare.md`).

```bash
bun install
npx wrangler r2 bucket create opencodex-state
openssl rand -hex 32 | npx wrangler secret put OPENCODEX_API_AUTH_TOKEN
npx wrangler deploy
```

| File | Role |
|---|---|
| `src/index.ts` | Worker entry, `OpencodexHub` container class, outbound state host |
| `src/lease.ts` | Single-writer lease kept in the Durable Object |
| `src/state-routes.ts` | Snapshot and lease endpoints the container calls at `http://state.ocx.internal` |
| `../../docker/cloudflare-supervisor.ts` | Container entrypoint: lease, restore, run `ocx`, snapshot |

Local run: copy `.dev.vars.example` to `.dev.vars`, fill in the token, and run `npx wrangler dev`
with Docker running. Tests: `bun test tests/service/cloudflare-deploy.test.ts` from the repository
root.
