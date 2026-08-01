import type { PlatformConfig } from "./config";

export interface TunnelResource {
  id: string;
  token: string;
}

export interface CloudflareProvider {
  createTunnel(name: string): Promise<TunnelResource>;
  createPrivateDnsRecord(hostname: string, originIp: string): Promise<string>;
  createCidrActivationRoute(tunnelId: string, originIp: string): Promise<string>;
  createPrivateHostnameRoute(tunnelId: string, hostname: string): Promise<string>;
  listActiveConnections(tunnelId: string): Promise<number>;
  getTunnelToken(tunnelId: string): Promise<string>;
  cleanupTunnelConnections(tunnelId: string): Promise<void>;
  disablePrivateHostnameRoute(routeId: string): Promise<void>;
  deleteCidrActivationRoute(routeId: string): Promise<void>;
  deletePrivateDnsRecord(recordId: string): Promise<void>;
  deleteTunnel(tunnelId: string): Promise<void>;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

export class CloudflareApi implements CloudflareProvider {
  constructor(private readonly config: PlatformConfig) {
    if (!config.cloudflareApiToken || !config.CLOUDFLARE_ACCOUNT_ID || !config.CLOUDFLARE_ZONE_ID) {
      throw new Error("Cloudflare API credential, account id, and zone id are required");
    }
  }

  private authenticationHeaders(): Record<string, string> {
    return this.config.cloudflareAuthEmail
      ? {
          "x-auth-email": this.config.cloudflareAuthEmail,
          "x-auth-key": this.config.cloudflareApiToken!,
        }
      : { authorization: `Bearer ${this.config.cloudflareApiToken}` };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.CLOUDFLARE_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...this.authenticationHeaders(),
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = await response.json() as CloudflareEnvelope<T>;
    if (!response.ok || !body.success) {
      throw new Error(`Cloudflare API ${response.status}: ${body.errors?.map(error => error.message).join(", ") || "request failed"}`);
    }
    return body.result;
  }

  createTunnel(name: string): Promise<TunnelResource> {
    return this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name, config_src: "cloudflare" }),
    });
  }

  async createPrivateDnsRecord(hostname: string, originIp: string): Promise<string> {
    const record = await this.request<{ id: string }>(
      `/zones/${this.config.CLOUDFLARE_ZONE_ID}/dns_records`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "A",
          name: hostname,
          content: originIp,
          ttl: 60,
          proxied: false,
          comment: "OpenCodex Remote private origin resolver target",
        }),
      },
    );
    return record.id;
  }

  async createCidrActivationRoute(tunnelId: string, originIp: string): Promise<string> {
    const route = await this.request<{ id: string }>(
      `/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/teamnet/routes`,
      {
        method: "POST",
        body: JSON.stringify({
          network: `${originIp}/32`,
          tunnel_id: tunnelId,
          comment: "OpenCodex Remote private-flow activation",
        }),
      },
    );
    return route.id;
  }

  async createPrivateHostnameRoute(tunnelId: string, hostname: string): Promise<string> {
    const route = await this.request<{ id: string }>(
      `/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/zerotrust/routes/hostname`,
      { method: "POST", body: JSON.stringify({ hostname, tunnel_id: tunnelId, comment: "OpenCodex Remote private instance" }) },
    );
    return route.id;
  }

  async listActiveConnections(tunnelId: string): Promise<number> {
    const clients = await this.request<Array<{ conns?: Array<{ is_pending_reconnect?: boolean }> }>>(
      `/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/connections`,
    );
    return clients.flatMap(client => client.conns ?? []).filter(connection => !connection.is_pending_reconnect).length;
  }

  getTunnelToken(tunnelId: string): Promise<string> {
    return this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);
  }

  async cleanupTunnelConnections(tunnelId: string): Promise<void> {
    await this.request(
      `/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/connections`,
      { method: "DELETE" },
    );
  }

  async disablePrivateHostnameRoute(routeId: string): Promise<void> {
    await this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/zerotrust/routes/hostname/${routeId}`, { method: "DELETE" });
  }

  async deleteCidrActivationRoute(routeId: string): Promise<void> {
    await this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/teamnet/routes/${routeId}`, { method: "DELETE" });
  }

  async deletePrivateDnsRecord(recordId: string): Promise<void> {
    await this.request(`/zones/${this.config.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`, { method: "DELETE" });
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, { method: "DELETE" });
  }
}

/** Deterministic provider for unit tests and local UI development only. */
export class FakeCloudflareProvider implements CloudflareProvider {
  readonly tunnels = new Map<string, { token: string; connections: number }>();
  readonly routes = new Map<string, { tunnelId: string; hostname: string }>();
  readonly dnsRecords = new Map<string, { hostname: string; originIp: string }>();
  readonly cidrRoutes = new Map<string, { tunnelId: string; originIp: string }>();

  async createTunnel(): Promise<TunnelResource> {
    const id = crypto.randomUUID();
    const token = `fake.${crypto.randomUUID()}`;
    this.tunnels.set(id, { token, connections: 0 });
    return { id, token };
  }
  async createPrivateHostnameRoute(tunnelId: string, hostname: string): Promise<string> {
    const id = crypto.randomUUID();
    this.routes.set(id, { tunnelId, hostname });
    return id;
  }
  async createPrivateDnsRecord(hostname: string, originIp: string): Promise<string> {
    const id = crypto.randomUUID();
    this.dnsRecords.set(id, { hostname, originIp });
    return id;
  }
  async createCidrActivationRoute(tunnelId: string, originIp: string): Promise<string> {
    const id = crypto.randomUUID();
    this.cidrRoutes.set(id, { tunnelId, originIp });
    return id;
  }
  async listActiveConnections(tunnelId: string): Promise<number> {
    return this.tunnels.get(tunnelId)?.connections ?? 0;
  }
  async getTunnelToken(tunnelId: string): Promise<string> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) throw new Error("tunnel not found");
    return tunnel.token;
  }
  async cleanupTunnelConnections(tunnelId: string): Promise<void> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) throw new Error("tunnel not found");
    tunnel.connections = 0;
  }
  async disablePrivateHostnameRoute(routeId: string): Promise<void> { this.routes.delete(routeId); }
  async deleteCidrActivationRoute(routeId: string): Promise<void> { this.cidrRoutes.delete(routeId); }
  async deletePrivateDnsRecord(recordId: string): Promise<void> { this.dnsRecords.delete(recordId); }
  async deleteTunnel(tunnelId: string): Promise<void> { this.tunnels.delete(tunnelId); }
}
