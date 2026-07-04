-- Align government request logging with autonomous booking revisions
-- by storing structured metadata as JSONB for queryability.

CREATE TABLE IF NOT EXISTS government_requests (
  id bigserial PRIMARY KEY,
  user_id text,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  notes jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'government_requests'
      AND column_name = 'notes'
      AND udt_name = 'text'
  ) THEN
    ALTER TABLE government_requests
      ALTER COLUMN notes TYPE jsonb
      USING CASE
        WHEN notes IS NULL OR btrim(notes) = '' THEN NULL
        ELSE to_jsonb(notes)
      END;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_government_requests_status_created
  ON government_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_government_requests_notes_gin
  ON government_requests USING gin (notes);
