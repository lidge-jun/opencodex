BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE user_status AS ENUM ('pending_invite', 'active', 'suspended');
CREATE TYPE instance_status AS ENUM (
  'pending', 'provisioning', 'awaiting_agent', 'connecting', 'online',
  'degraded', 'offline', 'suspending', 'suspended', 'deleting', 'delete_failed', 'deleted'
);
CREATE TYPE job_status AS ENUM ('queued', 'running', 'retry', 'completed', 'failed');
CREATE TYPE health_signal AS ENUM ('agent', 'tunnel', 'gateway');

-- Better Auth owns these four tables. Security-sensitive authorization fields
-- stay server-owned; GitHub profile mapping may write only github_numeric_id.
CREATE TABLE users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  github_numeric_id text UNIQUE,
  role user_role NOT NULL DEFAULT 'user',
  status user_status NOT NULL DEFAULT 'pending_invite',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE TABLE accounts (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_user_id_idx ON accounts(user_id);
CREATE TABLE verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES users(id),
  expected_github_numeric_id text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL REFERENCES users(id),
  name text NOT NULL,
  slug text NOT NULL,
  private_hostname text NOT NULL UNIQUE,
  private_origin_ip inet NOT NULL UNIQUE,
  status instance_status NOT NULL DEFAULT 'pending',
  suspended_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX instances_live_slug_idx ON instances(slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX instances_one_live_per_user_idx ON instances(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE slug_tombstones (
  slug text PRIMARY KEY,
  instance_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL UNIQUE REFERENCES instances(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  status text NOT NULL DEFAULT 'paired',
  challenge_hash bytea,
  challenge_expires_at timestamptz,
  auth_token_hash bytea,
  auth_token_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  token_hint text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instance_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE instance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provisioning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  kind text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status job_status NOT NULL DEFAULT 'queued',
  step text NOT NULL DEFAULT 'start',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provisioning_jobs_claim_idx ON provisioning_jobs(status, available_at);

CREATE TABLE cloudflare_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  external_id text NOT NULL,
  encrypted_secret bytea,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  disabled_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(instance_id, resource_type)
);

CREATE TABLE health_observations (
  id bigserial PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  signal health_signal NOT NULL,
  healthy boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX health_observations_latest_idx ON health_observations(instance_id, signal, observed_at DESC);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id text REFERENCES users(id),
  action text NOT NULL,
  instance_id uuid REFERENCES instances(id),
  result text NOT NULL,
  request_id uuid NOT NULL,
  network_hmac text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_retention_idx ON audit_logs(created_at);

CREATE TABLE abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid REFERENCES instances(id),
  reporter_contact text,
  category text NOT NULL,
  details text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

COMMIT;
