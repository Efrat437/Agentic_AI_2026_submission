CREATE TABLE IF NOT EXISTS user_permissions (
  user_id       BIGINT      NOT NULL REFERENCES users       (id) ON DELETE CASCADE,
  permission_id BIGINT      NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  granted_by    TEXT,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id
  ON user_permissions (user_id);

CREATE INDEX IF NOT EXISTS idx_user_permissions_permission_id
  ON user_permissions (permission_id);