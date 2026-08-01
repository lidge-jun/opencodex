BEGIN;

ALTER TABLE remote_access_profiles
  ADD COLUMN auth_version text NOT NULL DEFAULT 'legacy-password-v1',
  ADD COLUMN vault_salt bytea,
  ADD COLUMN vault_nonce bytea,
  ADD COLUMN encrypted_vault_key bytea,
  ADD COLUMN vault_kdf jsonb,
  ADD COLUMN root_public_key bytea;

ALTER TABLE instances
  ADD COLUMN transport_mode text NOT NULL DEFAULT 'mesh-tunnel'
    CHECK (transport_mode IN ('mesh-tunnel', 'outbound-relay'));

ALTER TABLE remote_devices
  ADD COLUMN ecdh_public_key bytea,
  ADD COLUMN relay_token_hash bytea UNIQUE,
  ADD COLUMN relay_connected_at timestamptz,
  ADD COLUMN relay_disconnected_at timestamptz,
  ADD COLUMN agent_version text;

ALTER TABLE device_authorization_requests
  ADD COLUMN ecdh_public_key bytea,
  ADD COLUMN encrypted_relay_token bytea;

-- Earlier private-MVP builds allowed two device keys to reuse a display name.
-- Preserve both devices while making the name stable and unique inside one account.
WITH ranked AS (
  SELECT id,row_number() OVER (PARTITION BY user_id,lower(name) ORDER BY created_at,id) AS position
  FROM remote_devices
  WHERE revoked_at IS NULL
)
UPDATE remote_devices d
SET name=left(d.name,67)||'-'||left(d.id::text,8),updated_at=now()
FROM ranked r
WHERE d.id=r.id AND r.position>1;

CREATE UNIQUE INDEX remote_devices_live_user_name_idx
  ON remote_devices(user_id,lower(name))
  WHERE revoked_at IS NULL;

CREATE TABLE terminal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  browser_token_hash bytea NOT NULL UNIQUE,
  command_profile text NOT NULL CHECK (command_profile IN ('shell','codex','claude')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','connected','closed','expired')),
  expires_at timestamptz NOT NULL,
  connected_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminal_sessions_device_status_idx
  ON terminal_sessions(device_id,status,expires_at);
CREATE INDEX terminal_sessions_user_created_idx
  ON terminal_sessions(user_id,created_at DESC);

-- [Decision Log]
-- - 목적과 의도: 계정 도메인 하나 아래 여러 컴퓨터를 연결하고 중앙 서버가 터미널 평문이나 복호화 키를 보지 않는 outbound relay를 추가한다.
-- - 기존 구현 및 제약 조건: instance는 계정당 하나였고 Agent도 instance당 하나였으며 비밀번호는 중앙 Argon2id 검증용으로만 저장됐다.
-- - 검토한 주요 대안: 기존 agents 테이블 확장, 컴퓨터별 instance 생성, local device identity를 relay node identity로 재사용.
-- - 선택한 방식: instance를 계정 workspace로 유지하고 remote_devices를 다중 relay node로 확장하며 E2EE 봉투와 짧은 terminal session만 추가한다.
-- - 다른 대안 대신 이 방식을 선택한 이유: 기존 도메인·소유권·세션을 보존하면서 인스턴스별 Cloudflare 리소스와 DB-per-frame 처리를 제거할 수 있다.
-- - 장점, 단점 및 영향: 마이그레이션과 롤백이 작고 기존 Mesh 경로가 공존하지만 과도기 동안 instance라는 이름이 workspace 의미도 함께 가진다.

COMMIT;
