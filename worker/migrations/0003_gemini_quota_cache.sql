CREATE TABLE IF NOT EXISTS gemini_daily_quota (
  channel TEXT PRIMARY KEY,
  quota_day TEXT NOT NULL,
  requests INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gemini_response_cache (
  cache_key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS gemini_cache_expiry ON gemini_response_cache (expires_at);
