import { Client } from 'pg';
import ExcelJS from 'exceljs';
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const HYBRID_SCHEMA_CANDIDATES = [
  path.join(PROJECT_ROOT, '04_data', 'hybrid_schema.sql'),
  path.join(PROJECT_ROOT, 'sql', 'hybrid_schema.sql'),
];
const HYBRID_SCHEMA_PATH = HYBRID_SCHEMA_CANDIDATES.find((p) => fs.existsSync(p)) || HYBRID_SCHEMA_CANDIDATES[1];
const BASE_PATH = fs.existsSync(path.join(process.cwd(), '04_data'))
  ? path.resolve(process.cwd(), '04_data')
  : path.join(PROJECT_ROOT, '04_data');

function normalizeEmbedding(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const out = value.flat(Infinity).map((n) => Number(n)).filter((n) => !Number.isNaN(n));
    return out.length ? out : null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const out = parsed.flat(Infinity).map((n) => Number(n)).filter((n) => !Number.isNaN(n));
      return out.length ? out : null;
    }
  } catch (_) {
    // fall through
  }
  return null;
}

function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

async function readExcel(fileName) {
  const filePath = path.join(BASE_PATH, fileName);
  if (!fs.existsSync(filePath)) {
    console.warn(`Missing file ${filePath} — using sample fallback data for ${fileName}`);
    // Provide minimal sample data for testing
    if (fileName.toLowerCase().includes('node')) return [{ id: 'node-' + randomUUID(), name: 'Sample Node', type: 'sample', description: 'This is a sample node because the Excel file was not provided.' }];
    if (fileName.toLowerCase().includes('relationship')) return [];
    if (fileName.toLowerCase().includes('attribute')) return [];
    return [];
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const ws = workbook.worksheets[0];
  if (!ws) return [];
  const headers = [];
  // normalize header names: trim, toLowerCase, replace spaces with _, remove non-word chars
  ws.getRow(1).eachCell((cell, colNumber) => {
    const raw = String(cell.value || '').trim();
    const norm = raw.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '');
    headers[colNumber] = norm;
  });
  const out = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    row.eachCell((cell, colNumber) => { const key = headers[colNumber] || `col_${colNumber}`; obj[key] = cell.value; });
    if (Object.values(obj).every(v => v === null || v === undefined || v === '')) return;
    out.push(obj);
  });
  return out;
}

const client = new Client({
  user: process.env.DB_USER || 'sso_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sso_db',
  password: process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.DB_PORT || '5433', 10),
});

await client.connect();

async function getTableColumns(tableName) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return new Set(res.rows.map((r) => r.column_name));
}

function pickExisting(columns, candidates) {
  for (const c of candidates) {
    if (columns.has(c)) return c;
  }
  return null;
}

async function upsertRow(tableName, pkColumn, rowData) {
  const entries = Object.entries(rowData).filter(([, v]) => v !== undefined);
  if (!pkColumn || entries.length === 0) return;
  const cols = entries.map(([k]) => k);
  const vals = entries.map(([, v]) => v);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols
    .filter((c) => c !== pkColumn)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  const sql = updates
    ? `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${pkColumn}) DO UPDATE SET ${updates}`
    : `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${pkColumn}) DO NOTHING`;

  try {
    await client.query(sql, vals);
  } catch (err) {
    // Legacy DBs may miss a unique index on the conflict target column.
    if (err?.code !== '42P10') throw err;

    const pkValue = rowData[pkColumn];
    if (pkValue === undefined || pkValue === null) throw err;

    const setCols = cols.filter((c) => c !== pkColumn);
    if (setCols.length > 0) {
      const updateSql = `UPDATE ${tableName} SET ${setCols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE ${pkColumn} = $${setCols.length + 1}`;
      const updateVals = [...setCols.map((c) => rowData[c]), pkValue];
      const updateRes = await client.query(updateSql, updateVals);
      if (updateRes.rowCount > 0) return;
    }

    const insertSql = `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
    await client.query(insertSql, vals);
  }
}

try {
  // Keep loader aligned with the canonical SQL schema file.
  if (!fs.existsSync(HYBRID_SCHEMA_PATH)) {
    throw new Error(`Missing required schema file: ${HYBRID_SCHEMA_PATH}`);
  }
  await client.query(fs.readFileSync(HYBRID_SCHEMA_PATH, 'utf8'));

  const nodeCols = await getTableColumns('nodes');
  const relCols = await getTableColumns('relationships');
  const attrCols = await getTableColumns('attributes');

  const nodeIdCol = pickExisting(nodeCols, ['node_id', 'id']);
  const nodeAliasIdCol = pickExisting(nodeCols, ['id']);
  const nodeNameCol = pickExisting(nodeCols, ['name', 'title']);
  const nodeTitleCol = pickExisting(nodeCols, ['title']);
  const nodeTypeCol = pickExisting(nodeCols, ['type']);
  const nodeDescCol = pickExisting(nodeCols, ['description', 'content']);
  const nodeContentCol = pickExisting(nodeCols, ['content']);
  const nodeMetaCol = pickExisting(nodeCols, ['metadata']);
  const nodeSourceCol = pickExisting(nodeCols, ['source']);
  const nodeEmbeddingCol = pickExisting(nodeCols, ['embedding']);
  const nodeEmbeddingsCol = pickExisting(nodeCols, ['embeddings']);

  const relIdCol = pickExisting(relCols, ['rel_id', 'id']);
  const relLegacyIdCol = pickExisting(relCols, ['id']);
  const relTypeCol = pickExisting(relCols, ['rel_type', 'type']);
  const relSourceIdCol = pickExisting(relCols, ['source_id']);
  const relTargetIdCol = pickExisting(relCols, ['target_id']);
  const relRelationshipTypeCol = pickExisting(relCols, ['relationship_type']);
  const relPropsCol = pickExisting(relCols, ['properties']);
  const relSourceCol = pickExisting(relCols, ['source']);
  const relEmbeddingCol = pickExisting(relCols, ['embedding']);
  const relEmbeddingsCol = pickExisting(relCols, ['embeddings']);

  const attrIdCol = pickExisting(attrCols, ['attr_id', 'id']);
  const attrLegacyIdCol = pickExisting(attrCols, ['id']);
  const attrEntityIdCol = pickExisting(attrCols, ['entity_id']);
  const attrAttributeKeyCol = pickExisting(attrCols, ['attribute_key']);
  const attrAttributeValueCol = pickExisting(attrCols, ['attribute_value']);
  const attrMetaCol = pickExisting(attrCols, ['metadata']);
  const attrSourceCol = pickExisting(attrCols, ['source']);
  const attrEmbeddingCol = pickExisting(attrCols, ['embedding']);
  const attrEmbeddingsCol = pickExisting(attrCols, ['embeddings']);

  if (!nodeIdCol || !relIdCol || !attrIdCol) {
    throw new Error('Missing required primary key columns in one or more tables');
  }

  async function ensureNodeExists(nodeId) {
    const row = { [nodeIdCol]: nodeId };
    if (nodeNameCol) row[nodeNameCol] = null;
    if (nodeTypeCol) row[nodeTypeCol] = 'placeholder';
    if (nodeDescCol) row[nodeDescCol] = 'Auto-generated placeholder';
    if (nodeSourceCol) row[nodeSourceCol] = 'load_data.js';
    if (nodeMetaCol) row[nodeMetaCol] = { placeholder: true };
    await upsertRow('nodes', nodeIdCol, row);
  }

  // use filenames the user provided
  const nodesData = await readExcel('nodes.xlsx');
  const relationshipsData = await readExcel('relationships.xlsx');
  const attributesData = await readExcel('attributes.xlsx');

  // Normalize and validate nodes
  let insertedNodes = 0;
  for (const node of nodesData) {
    // ensure node_id (accept either node.node_id or node.id from various sources)
    const rawId = node.node_id || node.id;
    if (!rawId) node.node_id = 'node-' + randomUUID();
    const nodeId = String(node.node_id || rawId).trim();
    const name = node.name ? String(node.name).trim() : null;
    const type = node.type ? String(node.type).trim() : null;
    const description = node.description ? String(node.description).trim() : null;

    const row = { [nodeIdCol]: nodeId };
    if (nodeAliasIdCol) row[nodeAliasIdCol] = nodeId;
    if (nodeNameCol) row[nodeNameCol] = name;
    if (nodeTypeCol) row[nodeTypeCol] = type;
    if (nodeDescCol) row[nodeDescCol] = description;
    if (nodeTitleCol) row[nodeTitleCol] = name;
    if (nodeContentCol) row[nodeContentCol] = description;
    if (nodeSourceCol) row[nodeSourceCol] = 'nodes.xlsx';
    const embedding = normalizeEmbedding(node.embedding || node.embeddings);
    if (nodeEmbeddingCol && embedding) row[nodeEmbeddingCol] = toVectorLiteral(embedding);
    if (nodeEmbeddingsCol && embedding) row[nodeEmbeddingsCol] = toVectorLiteral(embedding);
    if (nodeMetaCol) {
      row[nodeMetaCol] = {
        name,
        type,
        description,
        embedding: embedding || undefined,
      };
    }

    await upsertRow('nodes', nodeIdCol, row);
    insertedNodes++;
  }

  // Fetch existing node IDs to enforce FK relationships
  const existingRes = await client.query(`SELECT ${nodeIdCol} FROM nodes`);
  const existingNodeIds = new Set(existingRes.rows.map((r) => String(r[nodeIdCol]).trim()));

  // Relationships: validate essential fields and generate id if missing
  let insertedRels = 0;
  for (let i = 0; i < relationshipsData.length; i++) {
    const rel = relationshipsData[i];
    // accept multiple possible header names (normalized)
    let from_node = rel.from_node || rel.from || rel.source || rel.source_id || rel.sourceid || rel.sourceid || null;
    let to_node = rel.to_node || rel.to || rel.target || rel.target_id || rel.targetid || null;
    const type = rel.type || rel.relationship_type || rel.rel_type || rel.relation || null;
    if (!from_node || !to_node) {
      console.warn(`Skipping relationship row ${i+1}: missing from_node or to_node — row content: ${JSON.stringify(rel)}`);
      continue;
    }
    from_node = String(from_node).trim();
    to_node = String(to_node).trim();

    // If referenced nodes are missing, insert placeholder nodes to satisfy FK
    if (!existingNodeIds.has(from_node)) {
      console.warn(`Referenced from_node '${from_node}' not found — inserting placeholder node`);
      await ensureNodeExists(from_node);
      existingNodeIds.add(from_node);
    }
    if (!existingNodeIds.has(to_node)) {
      console.warn(`Referenced to_node '${to_node}' not found — inserting placeholder node`);
      await ensureNodeExists(to_node);
      existingNodeIds.add(to_node);
    }

    if (!rel.id) rel.id = `rel-${from_node}-${to_node}-${i}-${randomUUID()}`;
    const relRow = {
      [relIdCol]: String(rel.id),
      from_node: String(from_node),
      to_node: String(to_node),
    };
    if (relLegacyIdCol) relRow[relLegacyIdCol] = String(rel.id);
    if (relSourceIdCol) relRow[relSourceIdCol] = String(from_node);
    if (relTargetIdCol) relRow[relTargetIdCol] = String(to_node);
    if (relTypeCol) relRow[relTypeCol] = type;
    if (relRelationshipTypeCol) relRow[relRelationshipTypeCol] = type;
    if (relSourceCol) relRow[relSourceCol] = 'relationships.xlsx';
    const relEmbedding = normalizeEmbedding(rel.embedding || rel.embeddings);
    if (relEmbeddingCol && relEmbedding) relRow[relEmbeddingCol] = toVectorLiteral(relEmbedding);
    if (relEmbeddingsCol && relEmbedding) relRow[relEmbeddingsCol] = toVectorLiteral(relEmbedding);
    if (relPropsCol) relRow[relPropsCol] = { raw: rel };
    await upsertRow('relationships', relIdCol, relRow);
    insertedRels++;
  }

  // Attributes: robust handling for long-form and wide-form Excel sheets
  let insertedAttrs = 0;
  if (attributesData && attributesData.length > 0) {
    // Detect headers present in the parsed objects
    const sample = attributesData[0] || {};
    const headers = Object.keys(sample).map(h => String(h).toLowerCase());

    // helper: find candidate key in object given possible names
    const findKey = (obj, candidates) => {
      for (const c of candidates) {
        const k = Object.keys(obj).find(x => x.toLowerCase() === c);
        if (k) return { key: k, val: obj[k] };
      }
      return null;
    };

    const nodeIdCandidates = ['node_id','node','nodeid','id','entity','entity_id','subject','subject_id','object','parent','source','source_id','entityid'];
    const keyCandidates = ['key','name','attr','attribute','attribute_key','attributekey','attr_key','attrkey','property','prop','k','attribute_name','attribute'];
    const valueCandidates = ['value','val','v','attribute_value','attributevalue','attr_value','attrvalue','prop_value','content','attribute_val','attributeval'];

    // Determine if sheet is wide-form: contains an id column + many attribute columns
    const hasExplicitKeyValue = headers.some(h => keyCandidates.includes(h)) || headers.some(h => valueCandidates.includes(h));
    const hasIdLike = headers.some(h => nodeIdCandidates.includes(h));
    const wideForm = hasIdLike && !hasExplicitKeyValue;

    if (wideForm) {
      // For each row, take the node id from a candidate column and create attributes for other non-empty columns
      for (let i = 0; i < attributesData.length; i++) {
        const row = attributesData[i];
        const idEntry = findKey(row, nodeIdCandidates);
        const node_id = idEntry ? String(idEntry.val).trim() : null;
        if (!node_id) {
          if (i < 5) console.warn(`Skipping wide-form attribute row ${i+1}: missing node id — row: ${JSON.stringify(row)}`);
          continue;
        }
        // ensure node exists
        if (!existingNodeIds.has(node_id)) {
          await ensureNodeExists(node_id);
          existingNodeIds.add(node_id);
        }
        for (const col of Object.keys(row)) {
          const lower = col.toLowerCase();
          if (nodeIdCandidates.includes(lower)) continue; // skip id column
          const val = row[col];
          // accept empty value (store as empty string) — many attribute files include columns with blank values intentionally
          if (val === undefined || val === null) continue;
          const stringVal = String(val).trim();
          // allow empty string values to be stored
          const attrId = `attr-${node_id}-${lower}-${i}-${randomUUID()}`;
          const attrRow = {
            [attrIdCol]: String(attrId),
            node_id: String(node_id),
            key: lower,
            value: stringVal,
          };
          if (attrLegacyIdCol) attrRow[attrLegacyIdCol] = String(attrId);
          if (attrEntityIdCol) attrRow[attrEntityIdCol] = String(node_id);
          if (attrAttributeKeyCol) attrRow[attrAttributeKeyCol] = lower;
          if (attrAttributeValueCol) attrRow[attrAttributeValueCol] = stringVal;
          if (attrSourceCol) attrRow[attrSourceCol] = 'attributes.xlsx';
          const attrEmbedding = normalizeEmbedding(row.embedding || row.embeddings);
          if (attrEmbeddingCol && attrEmbedding) attrRow[attrEmbeddingCol] = toVectorLiteral(attrEmbedding);
          if (attrEmbeddingsCol && attrEmbedding) attrRow[attrEmbeddingsCol] = toVectorLiteral(attrEmbedding);
          if (attrMetaCol) attrRow[attrMetaCol] = { wideForm: true };
          await upsertRow('attributes', attrIdCol, attrRow);
          insertedAttrs++;
        }
      }
    } else {
      // Long-form rows: try to infer node_id, key and value from possible columns
      // Reduce console spam by collecting a few samples of skipped rows
      const skippedSamples = [];
      for (let i = 0; i < attributesData.length; i++) {
        const attr = attributesData[i];
        // find node_id
        const nid = findKey(attr, nodeIdCandidates);
        let node_id = nid ? String(nid.val).trim() : null;
        // find key
        const kEntry = findKey(attr, keyCandidates);
        const key = kEntry ? String(kEntry.val).trim() : null;
        // find value
        const vEntry = findKey(attr, valueCandidates);
        let value = vEntry ? vEntry.val : null;

        // If key/value stored in single "attribute" column as {key:..., value:...} or as JSON string, try to parse
        let resolvedKey = key;
        let resolvedValue = value;
        if (!resolvedKey && attr.attribute) {
          // attribute may be "name:value" or JSON
          const raw = String(attr.attribute);
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              if (!resolvedKey && parsed.name) resolvedKey = parsed.name;
              if (!resolvedValue && parsed.value) resolvedValue = parsed.value;
            }
          } catch (e) {
            const parts = raw.split(':');
            if (parts.length >= 2) {
              resolvedKey = resolvedKey || parts[0].trim();
              resolvedValue = resolvedValue || parts.slice(1).join(':').trim();
            }
          }
        }

        // If node_id missing but there is an 'id' or similar in the row, use it
        if (!node_id) {
          const idAlt = findKey(attr, ['id','record_id','row_id']);
          if (idAlt) node_id = String(idAlt.val).trim();
        }

        if (!node_id || !resolvedKey) {
          if (skippedSamples.length < 5) skippedSamples.push({ row: i+1, sample: attr });
          continue;
        }

        // ensure node exists
        if (!existingNodeIds.has(node_id)) {
          await ensureNodeExists(node_id);
          existingNodeIds.add(node_id);
        }

        if (!resolvedValue) resolvedValue = '';
        if (!attr.id) attr.id = `attr-${node_id}-${resolvedKey}-${i}-${randomUUID()}`;
        const attrRow = {
          [attrIdCol]: String(attr.id),
          node_id: String(node_id),
          key: resolvedKey,
          value: String(resolvedValue),
        };
        if (attrLegacyIdCol) attrRow[attrLegacyIdCol] = String(attr.id);
        if (attrEntityIdCol) attrRow[attrEntityIdCol] = String(node_id);
        if (attrAttributeKeyCol) attrRow[attrAttributeKeyCol] = String(resolvedKey);
        if (attrAttributeValueCol) attrRow[attrAttributeValueCol] = String(resolvedValue);
        if (attrSourceCol) attrRow[attrSourceCol] = 'attributes.xlsx';
        const attrEmbedding = normalizeEmbedding(attr.embedding || attr.embeddings);
        if (attrEmbeddingCol && attrEmbedding) attrRow[attrEmbeddingCol] = toVectorLiteral(attrEmbedding);
        if (attrEmbeddingsCol && attrEmbedding) attrRow[attrEmbeddingsCol] = toVectorLiteral(attrEmbedding);
        if (attrMetaCol) attrRow[attrMetaCol] = { longForm: true };
        await upsertRow('attributes', attrIdCol, attrRow);
        insertedAttrs++;
      }
      if (skippedSamples.length > 0) {
        console.warn(`Skipped ${skippedSamples.length} attribute rows due to missing node_id or key — samples: ${JSON.stringify(skippedSamples, null, 2)}`);
      }
    }
  } else {
    console.log('No attributes file or empty attributes sheet — nothing to import.');
  }

  // Keep canonical and alias columns synchronized for previously imported rows too.
  await client.query(`
    UPDATE nodes
    SET
      id = COALESCE(id, node_id),
      node_id = COALESCE(node_id, id),
      title = COALESCE(title, name),
      name = COALESCE(name, title),
      content = COALESCE(content, description),
      description = COALESCE(description, content),
      embeddings = COALESCE(embeddings, embedding),
      embedding = COALESCE(embedding, embeddings)
  `);

  await client.query(`
    UPDATE relationships
    SET
      id = COALESCE(id, rel_id),
      rel_id = COALESCE(rel_id, id),
      source_id = COALESCE(source_id, from_node),
      from_node = COALESCE(from_node, source_id),
      target_id = COALESCE(target_id, to_node),
      to_node = COALESCE(to_node, target_id),
      relationship_type = COALESCE(relationship_type, rel_type, type),
      rel_type = COALESCE(rel_type, relationship_type, type),
      type = COALESCE(type, relationship_type, rel_type),
      embeddings = COALESCE(embeddings, embedding),
      embedding = COALESCE(embedding, embeddings)
  `);

  await client.query(`
    UPDATE attributes
    SET
      id = COALESCE(id, attr_id),
      attr_id = COALESCE(attr_id, id),
      entity_id = COALESCE(entity_id, node_id),
      node_id = COALESCE(node_id, entity_id),
      attribute_key = COALESCE(attribute_key, key),
      key = COALESCE(key, attribute_key),
      attribute_value = COALESCE(attribute_value, value),
      value = COALESCE(value, attribute_value),
      embeddings = COALESCE(embeddings, embedding),
      embedding = COALESCE(embedding, embeddings)
  `);

  console.log(`Data imported successfully: nodes=${insertedNodes}, relationships=${insertedRels}, attributes=${insertedAttrs}`);
} catch (err) {
  console.error('Import failed:', err);
  throw err;
} finally {
  await client.end();
}
