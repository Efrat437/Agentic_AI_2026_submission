import fs from 'fs/promises';
import path from 'path';

const args = process.argv.slice(2);

function getArgValue(name, fallback = '') {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return String(args[index + 1] || '').trim();
  return fallback;
}

async function main() {
  const outputPath = getArgValue(
    '--output',
    path.resolve(process.cwd(), '02_backend', 'eval', 'local_government', 'public-booking-api-validation.json'),
  );

  const ping = await fetch('https://restful-booker.herokuapp.com/ping').then((response) => response.text());
  const createResponse = await fetch('https://restful-booker.herokuapp.com/booking', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      firstname: 'Eval',
      lastname: 'Runner',
      totalprice: 123,
      depositpaid: false,
      bookingdates: {
        checkin: '2026-05-10',
        checkout: '2026-05-11',
      },
      additionalneeds: 'evaluation only',
    }),
  });
  const created = await createResponse.json();
  const bookingId = created?.bookingid ?? null;
  const retrieved = bookingId
    ? await fetch(`https://restful-booker.herokuapp.com/booking/${bookingId}`).then((response) => response.json())
    : null;

  const output = {
    ok: Boolean(bookingId),
    mode: 'public-booking-api-validation',
    provider: 'restful-booker',
    generatedAt: new Date().toISOString(),
    outputPath,
    ping,
    bookingId,
    created: created?.booking || null,
    retrieved,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});