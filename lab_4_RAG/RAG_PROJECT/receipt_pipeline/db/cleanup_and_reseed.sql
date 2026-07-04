-- cleanup_and_reseed.sql: Truncate, reset, and reseed the receipts table for a clean state
TRUNCATE receipts RESTART IDENTITY CASCADE;
INSERT INTO receipts (date, total, category, items, meta)
VALUES (
    '2024-03-25',
    42.50,
    'food',
    '[{"name": "item1", "price": 10.00}, {"name": "item2", "price": 32.50}]',
    '{"resolution": "300dpi", "filetype": "png", "vendor": "Walmart"}'
)
ON CONFLICT ON CONSTRAINT unique_receipt DO NOTHING;