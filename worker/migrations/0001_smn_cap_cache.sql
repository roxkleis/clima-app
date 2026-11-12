CREATE TABLE IF NOT EXISTS smn_cap_documents (
  url TEXT PRIMARY KEY,
  alerts TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS smn_cap_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  resume_at INTEGER NOT NULL
);
