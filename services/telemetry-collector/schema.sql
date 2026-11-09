CREATE TABLE IF NOT EXISTS daily_installs (
  day TEXT NOT NULL,
  install_day_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  release_channel TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  install_channel TEXT NOT NULL,
  new_install INTEGER NOT NULL,
  active_minutes INTEGER NOT NULL,
  PRIMARY KEY (day, install_day_hash)
);

CREATE TABLE IF NOT EXISTS daily_totals (
  day TEXT NOT NULL PRIMARY KEY,
  reports INTEGER NOT NULL DEFAULT 0,
  new_installs INTEGER NOT NULL DEFAULT 0,
  active_minutes INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,
  aborted INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_models (
  day TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model_family TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider_kind, model_family)
);

-- Distinct installs per (day, provider_kind) and per (day, model_family): each report adds at most 1
-- to each row, unlike summing daily_models rows, which counts one install once per family/provider.
CREATE TABLE IF NOT EXISTS daily_provider_installs (
  day TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider_kind)
);

CREATE TABLE IF NOT EXISTS daily_family_installs (
  day TEXT NOT NULL,
  model_family TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model_family)
);

CREATE TABLE IF NOT EXISTS daily_errors (
  day TEXT NOT NULL,
  cause TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, cause)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_hour TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hour, ip_hash)
);
