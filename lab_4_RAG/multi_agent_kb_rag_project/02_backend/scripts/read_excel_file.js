import { Client } from 'pg';
import ExcelJS from 'exceljs';

try {
  // ----------- READ NODES FILE -----------
  const nodesWorkbook = new ExcelJS.Workbook();
  await nodesWorkbook.xlsx.readFile(
    'C:\\Users\\ADMIN\\Desktop\\Agentic_AI_2026\\lab_4_RAG\\multi_agent_kb_rag_project\\04_data\\nodes.xlsx'
  );
  console.log('Nodes sheets:', nodesWorkbook.worksheets.map((w) => w.name));
  const nodesData = nodesWorkbook.worksheets[0].getSheetValues();
  console.log('First nodes rows (raw):', nodesData.slice(1, 4));


  // ----------- READ RELATIONSHIPS FILE -----------
  const relationshipsWorkbook = new ExcelJS.Workbook();
  await relationshipsWorkbook.xlsx.readFile(
    'C:\\Users\\ADMIN\\Desktop\\Agentic_AI_2026\\lab_4_RAG\\multi_agent_kb_rag_project\\04_data\\relationships.xlsx'
  );
  const relationshipsData = relationshipsWorkbook.worksheets[0].getSheetValues();
  console.log('First relationships rows (raw):', relationshipsData.slice(1, 4));


  // ----------- READ ATTRIBUTES FILE -----------
  const attributesWorkbook = new ExcelJS.Workbook();
  await attributesWorkbook.xlsx.readFile(
    'C:\\Users\\ADMIN\\Desktop\\Agentic_AI_2026\\lab_4_RAG\\multi_agent_kb_rag_project\\04_data\\attributes.xlsx'
  );
  const attributesData = attributesWorkbook.worksheets[0].getSheetValues();
  console.log('First attributes rows (raw):', attributesData.slice(1, 4));
} catch (err) {
  console.error('Error reading Excel:', err.message);
}