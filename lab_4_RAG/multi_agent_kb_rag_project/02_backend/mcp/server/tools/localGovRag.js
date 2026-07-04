import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadSqlFilesToDb, ingestSqlTablesToRag } from '../../../agents/dbTools.js';
import { ingestLocalGovernmentWebToRag, getLocalGovernmentRagStats, resetLocalGovernmentRagData } from '../../../making_operations/local_government/operations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../../');

const DEFAULT_LOCAL_GOV_URLS = [
  'https://www.ashdod.muni.il/he-il/%d7%90%d7%aa%d7%a8-%d7%94%d7%a2%d7%99%d7%a8/',
  'https://www.tel-aviv.gov.il/pages/homepage.aspx',
];

export async function ingestMunicipalityWebToRag({
  urls = DEFAULT_LOCAL_GOV_URLS,
  truncate = false,
  chunkSize = 1000,
  chunkOverlap = 150,
  maxChunksPerUrl = 40,
  fetchTimeoutMs = 20000,
  minRelevanceScore = 1,
} = {}) {
  const result = await ingestLocalGovernmentWebToRag({
    urls,
    replaceExisting: Boolean(truncate),
    chunkSize,
    chunkOverlap,
    maxChunksPerUrl,
    minRelevanceScore,
    fetchTimeoutMs,
  });

  return {
    ...result,
    source: 'municipality-web',
    totalUrls: Array.isArray(urls) ? urls.length : DEFAULT_LOCAL_GOV_URLS.length,
  };
}

export { getLocalGovernmentRagStats, resetLocalGovernmentRagData };

export async function ingestSqlCorpusToRag({
  truncate = false,
  tables = ['attributes', 'nodes', 'relationships'],
  sqlFiles = [],
} = {}) {
  const sqlRoots = [
    path.join(repoRoot, '04_data'),
    path.join(repoRoot, 'sql'),
  ];
  const resolveSql = (name) => {
    for (const root of sqlRoots) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(repoRoot, 'sql', name);
  };
  const defaultSqlFiles = [
    resolveSql('nodes.sql'),
    resolveSql('attributes.sql'),
    resolveSql('relationships.sql'),
    resolveSql('hybrid_schema.sql'),
  ];

  const selectedSqlFiles = Array.isArray(sqlFiles) && sqlFiles.length > 0 ? sqlFiles : defaultSqlFiles;

  await loadSqlFilesToDb(selectedSqlFiles);
  const ingestRes = await ingestSqlTablesToRag({ tables, truncate });

  return {
    ok: true,
    loadedSqlFiles: selectedSqlFiles,
    ingestedTables: tables,
    inserted: ingestRes.inserted || 0,
  };
}
