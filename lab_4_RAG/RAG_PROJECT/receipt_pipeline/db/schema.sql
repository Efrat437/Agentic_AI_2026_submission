CREATE TABLE receipts (
  id SERIAL PRIMARY KEY,
  date DATE,
  total NUMERIC,
  category TEXT,
  items JSONB,
  raw_json JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  meta JSONB,
  CONSTRAINT unique_receipt UNIQUE (date, total, category, meta)
);
