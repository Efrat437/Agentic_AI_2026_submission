-- receipts.sql: Seed the receipts table with a single unique receipt
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
