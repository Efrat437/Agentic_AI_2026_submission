// test-full-pipeline.js
import { runFullPipeline } from './agents/orchestrator.js';

async function main() {
  const imagePath = './03_data/common-gas-receipt-writer-supports-for-usa-east-canada-uk.png';
  const context = { userId: 'test-user' };

  // Run the full pipeline
  const result = await runFullPipeline(imagePath, context);
  console.log('Merged pipeline result:', result);

  // Simulate 3 user questions
  const questions = [
    'What is the total amount?',
    'What is the currency?',
    'How many receipts do I have?'
  ];

  // Print answers based on merged result
  for (const q of questions) {
    let answer;
    if (/total amount/i.test(q)) {
      if (result.total !== undefined && result.currency) {
        answer = `The total amount is ${result.total} ${result.currency}.`;
      } else if (result.total !== undefined) {
        answer = `The total amount is ${result.total}.`;
      } else {
        answer = 'No total found.';
      }
    } else if (/currency/i.test(q)) {
      answer = result.currency ? `The currency is ${result.currency}.` : 'No currency found.';
    } else if (/how many receipts/i.test(q)) {
      // For demo, assume 1 receipt processed
      answer = 'I have only one receipt.';
    } else {
      answer = 'No answer.';
    }
    console.log(`Q: ${q}\nA: ${answer}\n`);
  }
}

main().catch(console.error);
