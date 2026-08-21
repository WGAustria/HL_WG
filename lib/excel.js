const ExcelJS = require('exceljs');

const MAX_ROWS_PER_SHEET = 500;

// Liest eine Excel-Datei (Buffer) und wandelt sie in eine kompakte JSON-Form
// um, die dem LLM als Kontext mitgegeben wird.
async function readSourceWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheets = [];
  workbook.eachSheet((worksheet) => {
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > MAX_ROWS_PER_SHEET) return;
      const values = row.values.slice(1).map((v) => {
        if (v && typeof v === 'object' && 'text' in v) return v.text;
        if (v && typeof v === 'object' && v.result !== undefined) return v.result;
        return v === undefined ? null : v;
      });
      rows.push(values);
    });
    sheets.push({ name: worksheet.name, rows });
  });

  return { sheets };
}

async function loadTemplateWorkbook(templatePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  return workbook;
}

// Traegt die vom LLM gelieferten Werte gemaess mapping.json in die Vorlage ein.
function applyMapping(workbook, mapping, values) {
  mapping.fields.forEach(({ field, sheet, cell }) => {
    const worksheet = workbook.getWorksheet(sheet);
    if (!worksheet) return;
    const value = values ? values[field] : undefined;
    worksheet.getCell(cell).value = value === undefined ? '' : value;
  });
}

module.exports = { readSourceWorkbook, loadTemplateWorkbook, applyMapping };
