// Erzeugt eine Platzhalter-Vorlage unter templates/vorlage.xlsx, passend zu
// templates/mapping.json. Wird nur benoetigt, bis die echte Excel-Vorlage
// geliefert wird - dann einfach templates/vorlage.xlsx (und mapping.json)
// ersetzen und dieses Script ignorieren.
const path = require('path');
const ExcelJS = require('exceljs');
const mapping = require('../templates/mapping.json');

async function main() {
  const workbook = new ExcelJS.Workbook();
  const sheetNames = [...new Set(mapping.fields.map((f) => f.sheet))];
  const sheets = {};
  sheetNames.forEach((name) => {
    sheets[name] = workbook.addWorksheet(name);
  });

  mapping.fields.forEach(({ field, sheet, cell }) => {
    const ws = sheets[sheet];
    const col = cell.replace(/[0-9]/g, '');
    const row = cell.replace(/[A-Za-z]/g, '');
    const labelCol = String.fromCharCode(col.charCodeAt(0) - 1);
    if (labelCol >= 'A') {
      ws.getCell(`${labelCol}${row}`).value = field;
    }
  });

  const outPath = path.join(__dirname, '..', 'templates', 'vorlage.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log('Platzhalter-Vorlage geschrieben:', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
