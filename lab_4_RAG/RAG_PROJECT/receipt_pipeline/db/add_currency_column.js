// Script to add 'currency' column to receipts table using Node.js
import { writePool } from './db.js';

(async () => {
  try {
    await writePool.query('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS currency TEXT;');
    console.log('Currency column added to receipts table.');
    process.exit(0);
  } catch (err) {
    console.error('Error adding currency column:', err.message);
    process.exit(1);
  }
})();
