import { createPlatformAuth } from "./auth";
import { createControlPlaneApp } from "./app";
import { loadPlatformConfig } from "./config";
import { Database } from "./db";
import { PlatformStore } from "./store";

const config = loadPlatformConfig();
const database = new Database(config.PLATFORM_DATABASE_URL);
const auth = createPlatformAuth(config, database);
const store = new PlatformStore(database, config);
const app = createControlPlaneApp(config, auth, store);

Bun.serve({
  port: config.PLATFORM_CONTROL_PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
});

console.log(`OpenCodex Remote control plane listening on 127.0.0.1:${config.PLATFORM_CONTROL_PORT}`);
