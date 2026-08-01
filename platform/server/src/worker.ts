import { hostname } from "node:os";
import type { PoolClient } from "pg";
import { CloudflareApi, FakeCloudflareProvider, type CloudflareProvider } from "./cloudflare";
import { loadPlatformConfig } from "./config";
import { Database } from "./db";
import { PlatformStore } from "./store";

interface Job {
  id: string;
  instance_id: string;
  kind: "provision" | "suspend" | "delete";
  step: string;
  attempts: number;
}

const config = loadPlatformConfig();
const database = new Database(config.PLATFORM_DATABASE_URL);
const store = new PlatformStore(database, config);
const cloudflare: CloudflareProvider = config.CLOUDFLARE_MESH_ENABLED === "true"
  ? new CloudflareApi(config)
  : new FakeCloudflareProvider();
const workerId = `${hostname()}:${process.pid}`;

async function claimJob(): Promise<Job | null> {
  return database.transaction(async client => {
    const result = await client.query<Job>(
      `SELECT id,instance_id,kind,step,attempts FROM provisioning_jobs
       WHERE status IN ('queued','retry') AND available_at<=now()
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const job = result.rows[0];
    if (!job) return null;
    await client.query(
      `UPDATE provisioning_jobs SET status='running',locked_at=now(),locked_by=$2,
       attempts=attempts+1,updated_at=now() WHERE id=$1`,
      [job.id, workerId],
    );
    job.attempts += 1;
    return job;
  });
}

async function resource(instanceId: string, type: string): Promise<string | null> {
  const result = await database.query<{ external_id: string }>(
    "SELECT external_id FROM cloudflare_resources WHERE instance_id=$1 AND resource_type=$2 AND deleted_at IS NULL",
    [instanceId, type],
  );
  return result.rows[0]?.external_id ?? null;
}

async function deleteTunnelAndConnections(tunnelId: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // Cloudflare rejects ordinary Tunnel deletion while a connector is live.
    // Cleanup is the documented equivalent of `cloudflared tunnel delete -f`;
    // retrying closes the narrow race where an old-token Agent reconnects.
    await cloudflare.cleanupTunnelConnections(tunnelId);
    try {
      await cloudflare.deleteTunnel(tunnelId);
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.toLowerCase().includes("active connections")) throw error;
      await Bun.sleep(500);
    }
  }
  throw lastError ?? new Error("Tunnel deletion failed after connector cleanup");
}

async function provision(job: Job): Promise<void> {
  await database.query("UPDATE instances SET status='provisioning',updated_at=now() WHERE id=$1", [job.instance_id]);
  let tunnelId = await resource(job.instance_id, "tunnel");
  if (!tunnelId) {
    const tunnel = await cloudflare.createTunnel(`ocxr-${job.instance_id}`);
    await store.saveCloudflareResource(job.instance_id, "tunnel", tunnel.id, tunnel.token);
    tunnelId = tunnel.id;
    await database.query("UPDATE provisioning_jobs SET step='tunnel_created',updated_at=now() WHERE id=$1", [job.id]);
  }
  const instance = await database.query<{ private_hostname: string; private_origin_ip: string }>(
    "SELECT private_hostname,host(private_origin_ip) AS private_origin_ip FROM instances WHERE id=$1",
    [job.instance_id],
  );
  const destination = instance.rows[0];
  if (!destination) throw new Error("instance not found");
  let dnsRecordId = await resource(job.instance_id, "private_dns");
  if (!dnsRecordId) {
    dnsRecordId = await cloudflare.createPrivateDnsRecord(destination.private_hostname, destination.private_origin_ip);
    await store.saveCloudflareResource(job.instance_id, "private_dns", dnsRecordId);
    await database.query("UPDATE provisioning_jobs SET step='dns_created',updated_at=now() WHERE id=$1", [job.id]);
    // Live Phase 0 showed that querying before the zone edge had the new A
    // record could cache NXDOMAIN for the SOA negative TTL. Human pairing is
    // usually slower, but provisioning must also be safe for automated Agents.
    if (config.CLOUDFLARE_MESH_ENABLED === "true") await Bun.sleep(15_000);
  }
  let cidrRouteId = await resource(job.instance_id, "cidr_activation_route");
  if (!cidrRouteId) {
    cidrRouteId = await cloudflare.createCidrActivationRoute(tunnelId, destination.private_origin_ip);
    await store.saveCloudflareResource(job.instance_id, "cidr_activation_route", cidrRouteId);
    await database.query("UPDATE provisioning_jobs SET step='cidr_route_created',updated_at=now() WHERE id=$1", [job.id]);
  }
  let routeId = await resource(job.instance_id, "hostname_route");
  if (!routeId) {
    routeId = await cloudflare.createPrivateHostnameRoute(tunnelId, destination.private_hostname);
    await store.saveCloudflareResource(job.instance_id, "hostname_route", routeId);
    await database.query("UPDATE provisioning_jobs SET step='route_created',updated_at=now() WHERE id=$1", [job.id]);
  }
  await database.query("UPDATE instances SET status='awaiting_agent',updated_at=now() WHERE id=$1", [job.instance_id]);
}

async function deactivateCloudflare(instanceId: string): Promise<void> {
  const routeId = await resource(instanceId, "hostname_route");
  if (routeId) {
    await cloudflare.disablePrivateHostnameRoute(routeId);
    await database.query("UPDATE cloudflare_resources SET disabled_at=now(),deleted_at=now() WHERE instance_id=$1 AND resource_type='hostname_route'", [instanceId]);
  }
  const cidrRouteId = await resource(instanceId, "cidr_activation_route");
  if (cidrRouteId) {
    await cloudflare.deleteCidrActivationRoute(cidrRouteId);
    await database.query("UPDATE cloudflare_resources SET disabled_at=now(),deleted_at=now() WHERE instance_id=$1 AND resource_type='cidr_activation_route'", [instanceId]);
  }
  const dnsRecordId = await resource(instanceId, "private_dns");
  if (dnsRecordId) {
    await cloudflare.deletePrivateDnsRecord(dnsRecordId);
    await database.query("UPDATE cloudflare_resources SET disabled_at=now(),deleted_at=now() WHERE instance_id=$1 AND resource_type='private_dns'", [instanceId]);
  }
  const tunnelId = await resource(instanceId, "tunnel");
  if (tunnelId) {
    // Resume provisions a fresh Tunnel and token. Central connector cleanup
    // ensures suspend does not depend on the Agent being online or cooperative.
    await deleteTunnelAndConnections(tunnelId);
    await database.query("UPDATE cloudflare_resources SET deleted_at=now(),encrypted_secret=NULL WHERE instance_id=$1 AND resource_type='tunnel'", [instanceId]);
  }
}

async function suspend(job: Job): Promise<void> {
  await deactivateCloudflare(job.instance_id);
  await database.query("UPDATE instances SET status='suspended',updated_at=now() WHERE id=$1", [job.instance_id]);
}

async function remove(job: Job): Promise<void> {
  await deactivateCloudflare(job.instance_id);
  await database.transaction(async (client: PoolClient) => {
    const instance = await client.query<{ slug: string }>("SELECT slug FROM instances WHERE id=$1 FOR UPDATE", [job.instance_id]);
    if (!instance.rows[0]) return;
    await client.query(
      `INSERT INTO slug_tombstones(slug,instance_id,expires_at) VALUES($1,$2,now()+interval '30 days')
       ON CONFLICT(slug) DO UPDATE SET instance_id=excluded.instance_id,expires_at=excluded.expires_at`,
      [instance.rows[0].slug, job.instance_id],
    );
    await client.query("UPDATE instances SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1", [job.instance_id]);
  });
}

async function finish(job: Job): Promise<void> {
  await database.query("UPDATE provisioning_jobs SET status='completed',last_error=NULL,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=$1", [job.id]);
}

async function fail(job: Job, error: unknown): Promise<void> {
  const terminal = job.attempts >= 10;
  const message = error instanceof Error ? error.message.slice(0, 500) : "job failed";
  await database.query(
    `UPDATE provisioning_jobs SET status=$2,last_error=$3,available_at=now()+($4 || ' seconds')::interval,
     locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=$1`,
    [job.id, terminal ? "failed" : "retry", message, Math.min(300, 2 ** job.attempts)],
  );
  if (job.kind === "delete") {
    await database.query("UPDATE instances SET status='delete_failed',updated_at=now() WHERE id=$1", [job.instance_id]);
  }
}

async function refreshHealth(): Promise<void> {
  const instances = await database.query<{ id: string; slug: string }>(
    "SELECT id,slug FROM instances WHERE status IN ('connecting','online','degraded','offline') AND deleted_at IS NULL",
  );
  for (const instance of instances.rows) {
    const tunnelId = await resource(instance.id, "tunnel");
    try {
      await store.recordHealth(instance.id, "tunnel", !!tunnelId && await cloudflare.listActiveConnections(tunnelId) > 0);
    } catch { await store.recordHealth(instance.id, "tunnel", false); }
    try {
      const response = await fetch(`https://${instance.slug}.${config.PLATFORM_INSTANCE_DOMAIN}/healthz`, {
        headers: { "x-ocxr-synthetic": config.syntheticHealthToken },
        signal: AbortSignal.timeout(10_000),
      });
      await store.recordHealth(instance.id, "gateway", response.ok);
    } catch { await store.recordHealth(instance.id, "gateway", false); }
    await store.refreshComputedHealth(instance.id);
  }
}

async function loop(): Promise<void> {
  let lastHealth = 0;
  while (true) {
    const job = await claimJob();
    if (job) {
      try {
        if (job.kind === "provision") await provision(job);
        else if (job.kind === "suspend") await suspend(job);
        else await remove(job);
        await finish(job);
      } catch (error) { await fail(job, error); }
      continue;
    }
    if (Date.now() - lastHealth >= 30_000) {
      await refreshHealth();
      lastHealth = Date.now();
    }
    await Bun.sleep(500);
  }
}

console.log(`OpenCodex Remote worker started as ${workerId}`);
await loop();
