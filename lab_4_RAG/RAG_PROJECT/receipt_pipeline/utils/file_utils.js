import fs from 'fs/promises';
import path from 'path';

export async function saveFile(file, destDir) {
  const fileName = `${Date.now()}_${file.originalname}`;
  const destPath = path.join(destDir, fileName);
  await fs.writeFile(destPath, file.buffer);
  return destPath;
}
