-- Add missing actions table for RAG pipeline
CREATE TABLE IF NOT EXISTS actions (
  id SERIAL PRIMARY KEY,
  action_type TEXT,
  payload JSONB,
  agent TEXT,
  user_query TEXT,
  proposed_sql TEXT,
  params JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE actions ADD COLUMN IF NOT EXISTS agent TEXT;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS user_query TEXT;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS proposed_sql TEXT;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS params JSONB;
-- Add missing memories table for RAG pipeline
CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR,
  memory_text TEXT,
  query TEXT,
  response TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE memories ADD COLUMN IF NOT EXISTS query TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS response TEXT;
-- hybrid_schema.sql
-- Non-destructive, idempotent schema setup for nodes/relationships/attributes.
-- This script keeps existing data and only creates missing objects.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nodes (
  node_id VARCHAR PRIMARY KEY,
  id VARCHAR,
  source VARCHAR,
  title TEXT,
  content TEXT,
  name TEXT,
  type TEXT,
  description TEXT,
  metadata JSONB,
  embedding VECTOR(384)
);

CREATE TABLE IF NOT EXISTS relationships (
  rel_id VARCHAR PRIMARY KEY,
  -- Legacy compatibility column retained for older loaders.
  id VARCHAR,
  source VARCHAR,
  source_id VARCHAR,
  from_node VARCHAR NOT NULL,
  target_id VARCHAR,
  to_node VARCHAR NOT NULL,
  relationship_type VARCHAR,
  rel_type VARCHAR,
  -- Legacy compatibility column retained for older loaders.
  type VARCHAR,
  properties JSONB,
  embedding VECTOR(384)
);

CREATE TABLE IF NOT EXISTS attributes (
  attr_id VARCHAR PRIMARY KEY,
  -- Legacy compatibility column retained for older loaders.
  id VARCHAR,
  source VARCHAR,
  entity_id VARCHAR,
  node_id VARCHAR NOT NULL,
  attribute_key TEXT,
  key TEXT,
  attribute_value TEXT,
  value TEXT,
  metadata JSONB,
  embedding VECTOR(384)
);

ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS id VARCHAR,
  ADD COLUMN IF NOT EXISTS source VARCHAR,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS embedding VECTOR(384);

ALTER TABLE relationships
  ADD COLUMN IF NOT EXISTS rel_id VARCHAR,
  ADD COLUMN IF NOT EXISTS id VARCHAR,
  ADD COLUMN IF NOT EXISTS source VARCHAR,
  ADD COLUMN IF NOT EXISTS source_id VARCHAR,
  ADD COLUMN IF NOT EXISTS from_node VARCHAR,
  ADD COLUMN IF NOT EXISTS target_id VARCHAR,
  ADD COLUMN IF NOT EXISTS to_node VARCHAR,
  ADD COLUMN IF NOT EXISTS relationship_type VARCHAR,
  ADD COLUMN IF NOT EXISTS rel_type VARCHAR,
  ADD COLUMN IF NOT EXISTS type VARCHAR,
  ADD COLUMN IF NOT EXISTS properties JSONB,
  ADD COLUMN IF NOT EXISTS embedding VECTOR(384);

ALTER TABLE attributes
  ADD COLUMN IF NOT EXISTS attr_id VARCHAR,
  ADD COLUMN IF NOT EXISTS id VARCHAR,
  ADD COLUMN IF NOT EXISTS source VARCHAR,
  ADD COLUMN IF NOT EXISTS entity_id VARCHAR,
  ADD COLUMN IF NOT EXISTS node_id VARCHAR,
  ADD COLUMN IF NOT EXISTS attribute_key TEXT,
  ADD COLUMN IF NOT EXISTS key TEXT,
  ADD COLUMN IF NOT EXISTS attribute_value TEXT,
  ADD COLUMN IF NOT EXISTS value TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS embedding VECTOR(384);

-- Backfill canonical IDs from legacy IDs when needed.
UPDATE relationships
SET rel_id = id
WHERE rel_id IS NULL AND id IS NOT NULL;

UPDATE attributes
SET attr_id = id
WHERE attr_id IS NULL AND id IS NOT NULL;

-- Backfill legacy compatibility columns from canonical names when needed.
UPDATE relationships
SET id = rel_id
WHERE id IS NULL AND rel_id IS NOT NULL;

UPDATE relationships
SET type = rel_type
WHERE type IS NULL AND rel_type IS NOT NULL;

UPDATE relationships
SET source_id = from_node
WHERE source_id IS NULL AND from_node IS NOT NULL;

UPDATE relationships
SET target_id = to_node
WHERE target_id IS NULL AND to_node IS NOT NULL;

UPDATE relationships
SET relationship_type = rel_type
WHERE relationship_type IS NULL AND rel_type IS NOT NULL;

UPDATE attributes
SET id = attr_id
WHERE id IS NULL AND attr_id IS NOT NULL;

UPDATE attributes
SET entity_id = node_id
WHERE entity_id IS NULL AND node_id IS NOT NULL;

UPDATE attributes
SET attribute_key = key
WHERE attribute_key IS NULL AND key IS NOT NULL;

UPDATE attributes
SET attribute_value = value
WHERE attribute_value IS NULL AND value IS NOT NULL;

-- Ensure canonical IDs are non-null once backfilled.
ALTER TABLE relationships
  ALTER COLUMN rel_id SET NOT NULL,
  ALTER COLUMN from_node SET NOT NULL,
  ALTER COLUMN to_node SET NOT NULL;

ALTER TABLE attributes
  ALTER COLUMN attr_id SET NOT NULL,
  ALTER COLUMN node_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'relationships_pkey'
      AND conrelid = 'relationships'::regclass
  ) THEN
    ALTER TABLE relationships
      ADD CONSTRAINT relationships_pkey PRIMARY KEY (rel_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attributes_pkey'
      AND conrelid = 'attributes'::regclass
  ) THEN
    ALTER TABLE attributes
      ADD CONSTRAINT attributes_pkey PRIMARY KEY (attr_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_id_legacy ON relationships(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attributes_id_legacy ON attributes(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_rel_from'
  ) THEN
    ALTER TABLE relationships
      ADD CONSTRAINT fk_rel_from FOREIGN KEY (from_node)
      REFERENCES nodes(node_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_rel_to'
  ) THEN
    ALTER TABLE relationships
      ADD CONSTRAINT fk_rel_to FOREIGN KEY (to_node)
      REFERENCES nodes(node_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_attr_node'
  ) THEN
    ALTER TABLE attributes
      ADD CONSTRAINT fk_attr_node FOREIGN KEY (node_id)
      REFERENCES nodes(node_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_relationships_from_node ON relationships(from_node);
CREATE INDEX IF NOT EXISTS idx_relationships_to_node ON relationships(to_node);
CREATE INDEX IF NOT EXISTS idx_attributes_node_id_key ON attributes(node_id, key);

-- Hot-path vector indexes for cosine-distance retrieval.
CREATE INDEX IF NOT EXISTS idx_nodes_embedding_cosine ON nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_attributes_embedding_cosine ON attributes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_relationships_embedding_cosine ON relationships USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
