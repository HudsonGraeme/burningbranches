CREATE TABLE IF NOT EXISTS repos (
  id                TEXT PRIMARY KEY,
  owner             TEXT NOT NULL,
  name              TEXT NOT NULL,
  branch            TEXT NOT NULL,
  head_sha          TEXT NOT NULL,
  head_committed_at TEXT NOT NULL,
  first_commit_at   TEXT NOT NULL,
  last_scan_at      TEXT NOT NULL,
  scan_count        INTEGER NOT NULL DEFAULT 1,
  plots             INTEGER NOT NULL DEFAULT 0,
  ghosts            INTEGER NOT NULL DEFAULT 0,
  stars             INTEGER NOT NULL DEFAULT 0,
  burning           INTEGER NOT NULL DEFAULT 0,
  canopy_share      REAL    NOT NULL DEFAULT 0,
  oldest_years      REAL    NOT NULL DEFAULT 0,
  views             INTEGER NOT NULL DEFAULT 0,
  manifest_key      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repos_last_scan ON repos (last_scan_at DESC);
CREATE INDEX IF NOT EXISTS idx_repos_head_committed ON repos (head_committed_at DESC);
