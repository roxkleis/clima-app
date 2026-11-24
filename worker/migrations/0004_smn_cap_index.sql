CREATE TABLE IF NOT EXISTS smn_cap_index (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  urls TEXT NOT NULL,
  complete INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
