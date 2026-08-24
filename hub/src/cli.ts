import { HubAuth } from "./auth";
import { loadHubConfig } from "./config";
import { HubDatabase } from "./database";
import { HubService } from "./server";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadHubConfig();
  if (command === "start") {
    const service = new HubService(config);
    const server = service.start();
    console.log(`hubapi hosted edge listening on ${server.url.origin}`);
    const stop = () => {
      service.stop();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "bootstrap-admin") {
    if (!process.argv.includes("--password-stdin")) throw new Error("bootstrap requires --password-stdin; passwords are never accepted in process arguments");
    const email = option("--email");
    const password = (await Bun.stdin.text()).replace(/[\r\n]+$/, "");
    const database = new HubDatabase(config.databasePath);
    try {
      database.assertNoActiveRuntimeLock();
      const auth = new HubAuth(database.db, config.digestSecret, config.sessionTtlSeconds);
      const user = await auth.bootstrapAdmin(email, password);
      console.log(`hubapi administrator bootstrapped: ${user.id}`);
    } finally {
      database.close();
    }
    return;
  }
  throw new Error("usage: bun hub/src/cli.ts <start|bootstrap-admin>");
}

await main();
