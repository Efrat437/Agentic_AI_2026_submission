-- db/init_receipts.sql: Combined schema and seed for receipts table

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

INSERT INTO receipts (date, total, currency, category, items, meta)
VALUES (
    '2024-03-25',
    69.07,
    'USD',
    'food',
    '[{"name": "item1", "price": 10.00}, {"name": "item2", "price": 59.07}]',
    '{"resolution": "300dpi", "filetype": "png", "vendor": "Walmart"}'
)
ON CONFLICT ON CONSTRAINT unique_receipt DO NOTHING;
