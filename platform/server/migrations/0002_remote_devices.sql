BEGIN;

CREATE TABLE remote_access_profiles (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text,
  password_set_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remote_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL,
  public_key bytea NOT NULL,
  instance_id uuid REFERENCES instances(id) ON DELETE SET NULL,
  token_hash bytea UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(user_id, public_key)
);
CREATE INDEX remote_devices_user_id_idx ON remote_devices(user_id);

CREATE TABLE device_authorization_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_secret_hash bytea NOT NULL UNIQUE,
  user_code text NOT NULL,
  device_name text NOT NULL,
  platform text NOT NULL,
  public_key bytea NOT NULL,
  network_hmac text NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_by text REFERENCES users(id) ON DELETE CASCADE,
  approved_at timestamptz,
  device_id uuid REFERENCES remote_devices(id) ON DELETE SET NULL,
  encrypted_device_token bytea,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_authorization_requests_expires_idx ON device_authorization_requests(expires_at);
CREATE INDEX device_authorization_requests_network_idx ON device_authorization_requests(network_hmac,created_at);

-- [Decision Log]
-- - 목적과 의도: 로컬 `ocx gui`가 GitHub 자격증명을 직접 받지 않고 중앙 OAuth 결과에 자기 장치 공개키를 연결하게 한다.
-- - 기존 구현 및 제약 조건: 기존 플랫폼은 웹 dashboard session과 별도 Rust Agent pairing만 있었고 npm OCX GUI가 중앙 계정에 연결되는 장치 승인 상태가 없었다.
-- - 검토한 주요 대안: GitHub token을 localhost callback으로 전달, 장기 API token을 URL에 포함, polling secret이 분리된 일회용 device authorization.
-- - 선택한 방식: 10분 device authorization request, 브라우저에는 UUID와 확인 코드만 표시하고 polling secret은 로컬 OCX만 보유한다. 승인 후 장치 token은 암호화해 ACK 전까지만 보관한다.
-- - 다른 대안 대신 이 방식을 선택한 이유: GitHub token과 장기 장치 token이 브라우저 URL·history·central frontend에 노출되지 않고 proxy 재시작 중에도 승인을 재개할 수 있다.
-- - 장점, 단점 및 영향: 일반 사용자의 시작점이 로컬 GUI가 되며 장치별 폐기가 가능하다. 대신 만료 요청 청소와 장치 token lifecycle을 중앙에서 운영해야 한다.

COMMIT;
