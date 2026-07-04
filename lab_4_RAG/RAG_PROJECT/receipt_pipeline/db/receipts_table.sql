-- Table for storing receipts (already present, but provided for clarity)
CREATE TABLE IF NOT EXISTS receipts (
    id SERIAL PRIMARY KEY,
    date DATE,
    total NUMERIC,
    currency TEXT,
    category TEXT,
    items JSONB,
    raw_json JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    meta JSONB,
    CONSTRAINT unique_receipt UNIQUE (date, total, category, meta)
);
