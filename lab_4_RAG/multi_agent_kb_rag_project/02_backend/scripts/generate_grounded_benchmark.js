import fs from 'fs';
import path from 'path';
import readline from 'readline';

const PROJECT_ROOT = process.cwd();
const ATTRIBUTES_SQL_PATH = path.resolve(PROJECT_ROOT, '04_data', 'attributes.sql');
const RELATIONSHIPS_SQL_PATH = path.resolve(PROJECT_ROOT, '04_data', 'relationships.sql');
const OUTPUT_DATASET_PATH = path.resolve(PROJECT_ROOT, '02_backend', 'eval', 'langgraph_eval_dataset.json');

const TARGET_PARENT_ATTRIBUTE_KEYS = [
  'rent_pcnt',
  'age_median',
  'academiccert_pcnt',
  'employeesannual_medwage',
  'vehicle2up_pcnt',
];

function unescapeSqlString(value = '') {
  return String(value || '').replace(/''/g, "'");
}

function parseArgs(argv = []) {
  const out = {
    output: OUTPUT_DATASET_PATH,
    lookupLimit: 10,
    graphLimit: 8,
    hybridLimit: 5,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    const next = i + 1 < argv.length ? String(argv[i + 1] || '').trim() : '';

    if (token === '--output' && next) {
      out.output = path.resolve(PROJECT_ROOT, next);
      i += 1;
      continue;
    }
    if (token === '--lookup-limit' && next) {
      out.lookupLimit = Math.max(1, Number(next) || out.lookupLimit);
      i += 1;
      continue;
    }
    if (token === '--graph-limit' && next) {
      out.graphLimit = Math.max(1, Number(next) || out.graphLimit);
      i += 1;
      continue;
    }
    if (token === '--hybrid-limit' && next) {
      out.hybridLimit = Math.max(1, Number(next) || out.hybridLimit);
      i += 1;
      continue;
    }
  }

  return out;
}

async function readAttributes(attributePath) {
  const attributeMap = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(attributePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const attrRegex = /VALUES\s*\('(?:[^']|'')*',\s*'(?:[^']|'')*',\s*'(?:[^']|'')*',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'/i;

  for await (const line of rl) {
    if (!line.startsWith('INSERT INTO attributes')) continue;
    const match = line.match(attrRegex);
    if (!match) continue;

    const nodeId = unescapeSqlString(match[2]).toLowerCase();
    const attributeKey = unescapeSqlString(match[3]).toLowerCase();
    const attributeValue = unescapeSqlString(match[5]);
    if (!nodeId || !attributeKey || !attributeValue) continue;

    if (!attributeMap.has(nodeId)) attributeMap.set(nodeId, new Map());
    const nodeAttributes = attributeMap.get(nodeId);
    if (!nodeAttributes.has(attributeKey)) {
      nodeAttributes.set(attributeKey, attributeValue);
    }
  }

  return attributeMap;
}

async function readBelongsToEdges(relationshipPath) {
  const edges = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(relationshipPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const relRegex = /VALUES\s*\('(?:[^']|'')*',\s*'(?:[^']|'')*',\s*'(?:[^']|'')*',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'/i;

  for await (const line of rl) {
    if (!line.startsWith('INSERT INTO relationships')) continue;
    const match = line.match(relRegex);
    if (!match) continue;

    const fromNode = unescapeSqlString(match[2]).toLowerCase();
    const toNode = unescapeSqlString(match[4]).toLowerCase();
    const relationType = unescapeSqlString(match[5]).toLowerCase();

    if (relationType !== 'belongs_to') continue;
    if (!fromNode || !toNode) continue;
    if (!/^((?:e|statistical)_[a-z0-9_]+)$/i.test(fromNode)) continue;
    if (!/^((?:e|statistical)_[a-z0-9_]+)$/i.test(toNode)) continue;
    if (edges.has(fromNode)) continue;

    edges.set(fromNode, toNode);
  }

  return Array.from(edges.entries())
    .map(([child, parent]) => ({ child, parent }))
    .sort((a, b) => a.child.localeCompare(b.child));
}

function chooseParentAttribute(parentId, attributesByNode) {
  const parentAttributes = attributesByNode.get(parentId);
  if (!parentAttributes) return null;

  for (const key of TARGET_PARENT_ATTRIBUTE_KEYS) {
    if (parentAttributes.has(key)) {
      return { key, value: parentAttributes.get(key) };
    }
  }

  for (const [key, value] of parentAttributes.entries()) {
    if (!value) continue;
    if (key === 'name' || key === 'title' || key === 'description') continue;
    return { key, value };
  }

  return null;
}

function pushDatasetRecord(records, record) {
  records.push(record);
}

function buildDataset({ attributesByNode, belongsToEdges, lookupLimit, graphLimit, hybridLimit }) {
  const records = [];

  const populationLookups = [];
  for (const [nodeId, attrs] of attributesByNode.entries()) {
    const population = attrs.get('population_approx') || attrs.get('population');
    if (!population) continue;
    populationLookups.push({ nodeId, key: attrs.has('population_approx') ? 'population_approx' : 'population', value: population });
  }

  populationLookups.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const chosenLookups = populationLookups.slice(0, lookupLimit);

  chosenLookups.forEach((item, index) => {
    pushDatasetRecord(records, {
      id: `lookup-${String(index + 1).padStart(3, '0')}`,
      category: 'simple_lookup',
      query: `What is the ${item.key} for ${item.nodeId}?`,
      ground_truth_answer: `The ${item.key} for ${item.nodeId} is ${item.value}.`,
      ground_truth_context: [
        `attributes.sql: ${item.nodeId} has ${item.key} ${item.value}.`,
      ],
      notes: 'Deterministic lookup generated from SQL artifacts.',
    });
  });

  const chosenGraph = belongsToEdges.slice(0, graphLimit);
  chosenGraph.forEach((edge, index) => {
    pushDatasetRecord(records, {
      id: `graph-${String(index + 1).padStart(3, '0')}`,
      category: 'graph_traversal',
      query: `Which parent does ${edge.child} belong to?`,
      ground_truth_answer: `${edge.child} belongs to ${edge.parent}.`,
      ground_truth_context: [
        `relationships.sql: ${edge.child} belongs_to ${edge.parent}.`,
      ],
      notes: 'Deterministic belongs_to edge generated from SQL artifacts.',
    });
  });

  const chosenDistrict = belongsToEdges.slice(0, Math.min(graphLimit, 4));
  chosenDistrict.forEach((edge, index) => {
    pushDatasetRecord(records, {
      id: `graph-district-${String(index + 1).padStart(3, '0')}`,
      category: 'graph_traversal',
      query: `Which district does ${edge.child} belong to?`,
      ground_truth_answer: `${edge.child} belongs to ${edge.parent}.`,
      ground_truth_context: [
        `relationships.sql: ${edge.child} belongs_to ${edge.parent}.`,
      ],
      notes: 'District phrasing variant mapped to belongs_to parent lookup.',
    });
  });

  let hybridIndex = 1;
  for (const edge of belongsToEdges) {
    if (hybridIndex > hybridLimit) break;
    const parentAttr = chooseParentAttribute(edge.parent, attributesByNode);
    if (!parentAttr) continue;

    pushDatasetRecord(records, {
      id: `hybrid-${String(hybridIndex).padStart(3, '0')}`,
      category: 'hybrid',
      query: `Which district does ${edge.child} belong to, and what is that district's ${parentAttr.key}?`,
      ground_truth_answer: `${edge.child} belongs to ${edge.parent}, and ${edge.parent} has ${parentAttr.key} ${parentAttr.value}.`,
      ground_truth_context: [
        `relationships.sql: ${edge.child} belongs_to ${edge.parent}.`,
        `attributes.sql: ${edge.parent} has ${parentAttr.key} ${parentAttr.value}.`,
      ],
      notes: 'District wording + parent attribute hybrid query from grounded SQL artifacts.',
    });
    hybridIndex += 1;
  }

  return records;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(ATTRIBUTES_SQL_PATH)) {
    throw new Error(`Missing attributes SQL at ${ATTRIBUTES_SQL_PATH}`);
  }
  if (!fs.existsSync(RELATIONSHIPS_SQL_PATH)) {
    throw new Error(`Missing relationships SQL at ${RELATIONSHIPS_SQL_PATH}`);
  }

  const attributesByNode = await readAttributes(ATTRIBUTES_SQL_PATH);
  const belongsToEdges = await readBelongsToEdges(RELATIONSHIPS_SQL_PATH);

  const dataset = buildDataset({
    attributesByNode,
    belongsToEdges,
    lookupLimit: args.lookupLimit,
    graphLimit: args.graphLimit,
    hybridLimit: args.hybridLimit,
  });

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(dataset, null, 2), 'utf8');

  console.log(JSON.stringify({
    output: args.output,
    records: dataset.length,
    lookup: dataset.filter((r) => r.category === 'simple_lookup').length,
    graph: dataset.filter((r) => r.category === 'graph_traversal').length,
    hybrid: dataset.filter((r) => r.category === 'hybrid').length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
