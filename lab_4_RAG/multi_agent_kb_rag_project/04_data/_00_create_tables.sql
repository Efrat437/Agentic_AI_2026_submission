-- Robust, generalized table creation for RAG pipeline
CREATE TABLE IF NOT EXISTS nodes (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  embedding VECTOR(384),
  properties JSONB
);

CREATE TABLE IF NOT EXISTS relationships (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL,
  target_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  properties JSONB
);

CREATE TABLE IF NOT EXISTS attributes (
  id BIGSERIAL PRIMARY KEY,
  node_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  properties JSONB
);
