CREATE TABLE IF NOT EXISTS subreddits (
  name TEXT PRIMARY KEY,
  name_lower TEXT NOT NULL,
  related TEXT NOT NULL,
  commenter_count INTEGER NOT NULL DEFAULT 0,
  size_bucket INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_name_lower ON subreddits(name_lower);
