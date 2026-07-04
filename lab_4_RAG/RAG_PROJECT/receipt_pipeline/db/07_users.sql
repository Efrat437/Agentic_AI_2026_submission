CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL    PRIMARY KEY,
  user_id       TEXT         UNIQUE NOT NULL,
  first_name    TEXT         NOT NULL,
  last_name     TEXT         NOT NULL,
  username      TEXT         UNIQUE NOT NULL,
  password_hash TEXT         NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_user_id  ON users (user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);