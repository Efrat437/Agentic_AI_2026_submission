-- 12_audit_login.sql
-- Login event audit trail: success/failure, IP, user agent.
-- Includes vw_logged_in_users_current_month view for monthly KPI.
-- Depends on: 07_users.sql

CREATE TABLE IF NOT EXISTS audit_login (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  username      TEXT,
  login_success BOOLEAN     NOT NULL,
  failure_reason TEXT,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_login_created_at
  ON audit_login (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_login_user_id
  ON audit_login (user_id);

CREATE INDEX IF NOT EXISTS idx_audit_login_success_created_at
  ON audit_login (login_success, created_at DESC);

-- Monthly KPI view: count of distinct users who logged in successfully this month
CREATE OR REPLACE VIEW vw_logged_in_users_current_month AS
SELECT COUNT(DISTINCT COALESCE(user_id::TEXT, username))::BIGINT
       AS logged_in_users_current_month
FROM audit_login
WHERE login_success = TRUE
  AND created_at >= date_trunc('month', now())
  AND created_at <  date_trunc('month', now()) + INTERVAL '1 month';
