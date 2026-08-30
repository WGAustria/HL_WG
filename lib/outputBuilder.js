const {
  readReportRows,
  groupByBon,
  pairBonGroup,
  applyStornoNetting
} = require('./reportPipeline');
const { deriveHersteller } = require('./brandMatch');
const { resolveBrandsViaLlm } = require('./brandLlmFallback');
const { buildVermittlerLookup } = require('./vermittlerLookup');

// Zielspalten im "Daten"-Blatt der Vorlage (1-indiziert), nach Feldbedeutung
// zugeordnet - siehe README fuer die Begruendung, warum nicht positionsbasiert
// aus dem Report kopiert wird.
const TARGET_COLS = {
  antragsdatum: 2,
  vermittlernummer: 3,
  anrede: 5,
  vorname: 6,
  nachname: 7,
  email: 8,
  strasse: 10,
  plz: 11,
  ort: 12,
  laenderkennzeichen: 13,
  position: 17,
  hersteller: 18,
  geraetekennzeichen: 19,
  modellbezeichnung: 20,
  seriennummer: 21,
  kaufdatum: 22,
  kaufpreis: 23,
  baujahr: 24,
  antragskodierung: 27,
  produkttyp: 28
};

// TODO: sobald bestaetigt/bekannt, hier eintragen (aktuell laut Absprache leer):
// VMRAbrechnung (Spalte 31) und Intervall (Spalte 32).

function wgProdukttyp(wgArtikelbezeichnung) {
  const s = String(wgArtikelbezeichnung || '');
  if (/komfort/i.test(s)) return 'GERAETESCHUTZ_KOMFORT_3_2021';
  if (/plus/i.test(s)) return 'GERAETESCHUTZ_PLUS_24_2021';
  return 'GERAETESCHUTZ_BASIS_5_2021';
}

function inDateRange(dateVal, from, to) {
  if (!dateVal) return false;
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// Fuehrt die komplette taegliche Aufbereitung durch: Reportfile lesen,
// filtern, paaren, Hersteller/Vermittlernummer aufloesen, Ausgabezeilen fuer
// das "Daten"-Blatt der Vorlage sowie eine Pruefliste erzeugen.
async function buildOutput(reportWorkbook, { anthropic, model, dateFrom, dateTo } = {}) {
  const reportSheet = reportWorkbook.getWorksheet('Reportfile');
  const maListeSheet = reportWorkbook.getWorksheet('MA Liste');
  if (!reportSheet) throw new Error('Blatt "Reportfile" nicht gefunden.');
  if (!maListeSheet) throw new Error('Blatt "MA Liste" nicht gefunden.');

  const allRows = readReportRows(reportSheet);
  const rows = dateFrom || dateTo
    ? allRows.filter((r) => inDateRange(r.datum, dateFrom, dateTo))
    : allRows;

  const groups = groupByBon(rows);
  const review = [];
  const pairsByBon = new Map();

  for (const [bon, group] of groups) {
    const { pairs, review: groupReview } = pairBonGroup(group);
    if (pairs.length) pairsByBon.set(bon, pairs);
    review.push(...groupReview);
  }

  const pairs = applyStornoNetting(pairsByBon);

  // Hersteller: erst Musterabgleich, dann gebuendelt per LLM fuer den Rest.
  const unresolvedNames = new Set();
  for (const pair of pairs) {
    pair.hersteller = deriveHersteller(pair.device.artikelbezeichnung, pair.device.pgr);
    if (!pair.hersteller) unresolvedNames.add(pair.device.artikelbezeichnung);
  }
  if (unresolvedNames.size > 0 && anthropic) {
    const resolved = await resolveBrandsViaLlm(anthropic, model, [...unresolvedNames]);
    for (const pair of pairs) {
      if (!pair.hersteller) {
        pair.hersteller = resolved.get(pair.device.artikelbezeichnung) || null;
      }
    }
  }

  const lookupVermittlerNr = buildVermittlerLookup(maListeSheet);

  const now = new Date();
  const currentYear = now.getFullYear();
  const outputRows = [];
  let position = 0;
  let lastBon = null;

  for (const pair of pairs) {
    const { device, wg, isStorno } = pair;
    position = device.bonnummer === lastBon ? position + 1 : 1;
    lastBon = device.bonnummer;

    const vermittlerNr = lookupVermittlerNr(device.vknr, device.vkName);
    if (vermittlerNr === null || vermittlerNr === undefined) {
      review.push({ reason: 'vermittlernummer-nicht-gefunden', rows: [device] });
    }
    if (!pair.hersteller) {
      review.push({ reason: 'hersteller-nicht-erkannt', rows: [device] });
    }

    outputRows.push({
      bonnummer: device.bonnummer,
      antragsdatum: now,
      vermittlernummer: vermittlerNr ?? '',
      anrede: device.anrede || '',
      vorname: device.vorname || '',
      nachname: device.nachname || '',
      email: device.email || '',
      strasse: device.strasse || '',
      plz: device.plz || '',
      ort: device.ort || '',
      laenderkennzeichen: 'AT',
      position,
      hersteller: pair.hersteller || '',
      geraetekennzeichen: device.gkz,
      modellbezeichnung: device.artikelbezeichnung,
      seriennummer: device.seriennr || wg.seriennr || '',
      kaufdatum: device.datum,
      kaufpreis: device.umsatz,
      baujahr: currentYear,
      antragskodierung: isStorno ? 'STORNO' : '',
      produkttyp: wgProdukttyp(wg.artikelbezeichnung),
      isStorno
    });
  }

  return {
    outputRows,
    review,
    stats: {
      totalRows: allRows.length,
      filteredRows: rows.length,
      bonGroups: groups.size,
      pairsCreated: outputRows.length,
      stornoCount: outputRows.filter((r) => r.isStorno).length,
      reviewRowCount: review.reduce((sum, r) => sum + r.rows.length, 0)
    }
  };
}

const STORNO_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFC7CE' }
};

// Schreibt die Ausgabezeilen in das "Daten"-Blatt der Vorlage, beginnend in
// der ersten leeren Zeile nach der Kopfzeile.
function writeOutputToTemplate(templateWorkbook, outputRows) {
  const sheet = templateWorkbook.getWorksheet('Daten');
  if (!sheet) throw new Error('Blatt "Daten" in der Vorlage nicht gefunden.');

  let startRow = 2;
  while (sheet.getRow(startRow).actualCellCount > 0) startRow++;

  outputRows.forEach((data, i) => {
    const row = sheet.getRow(startRow + i);
    row.getCell(TARGET_COLS.antragsdatum).value = data.antragsdatum;
    row.getCell(TARGET_COLS.vermittlernummer).value = data.vermittlernummer;
    row.getCell(TARGET_COLS.anrede).value = data.anrede;
    row.getCell(TARGET_COLS.vorname).value = data.vorname;
    row.getCell(TARGET_COLS.nachname).value = data.nachname;
    row.getCell(TARGET_COLS.email).value = data.email;
    row.getCell(TARGET_COLS.strasse).value = data.strasse;
    row.getCell(TARGET_COLS.plz).value = data.plz;
    row.getCell(TARGET_COLS.ort).value = data.ort;
    row.getCell(TARGET_COLS.laenderkennzeichen).value = data.laenderkennzeichen;
    row.getCell(TARGET_COLS.position).value = data.position;
    row.getCell(TARGET_COLS.hersteller).value = data.hersteller;
    row.getCell(TARGET_COLS.geraetekennzeichen).value = data.geraetekennzeichen;
    row.getCell(TARGET_COLS.modellbezeichnung).value = data.modellbezeichnung;
    row.getCell(TARGET_COLS.seriennummer).value = data.seriennummer;
    row.getCell(TARGET_COLS.kaufdatum).value = data.kaufdatum;
    row.getCell(TARGET_COLS.kaufpreis).value = data.kaufpreis;
    row.getCell(TARGET_COLS.baujahr).value = data.baujahr;
    row.getCell(TARGET_COLS.antragskodierung).value = data.antragskodierung;
    row.getCell(TARGET_COLS.produkttyp).value = data.produkttyp;

    if (data.isStorno) {
      for (let c = 1; c <= 33; c++) row.getCell(c).fill = STORNO_FILL;
    }
    row.commit();
  });
}

const REVIEW_REASON_LABELS = {
  'mehrere-kandidaten-preis-seriennummer-pruefen': 'Mehrere Geraete/WG-Artikel im Bon - Zuordnung unklar',
  'wg-ohne-geraet': 'WG-Artikel ohne Geraet (-> Gebraucht Nachtrag)',
  'wg-gs-unklar': '"Wertgarantie GS" - kein GKZ-Treffer in PG Matching',
  'vermittlernummer-nicht-gefunden': 'Vermittlernummer nicht in MA Liste gefunden',
  'hersteller-nicht-erkannt': 'Hersteller konnte nicht erkannt werden'
};

// Schreibt eine zusaetzliche "Pruefliste"-Tabelle in die Ausgabedatei mit
// allen Zeilen, die NICHT automatisch verarbeitet werden konnten.
function writeReviewSheet(workbook, review) {
  const sheet = workbook.addWorksheet('Pruefliste');
  sheet.addRow(['Grund', 'Bonnummer', 'ArtikelBezeichnung', 'PGR_Bezeichnung', 'Anzahl', 'Umsatz', 'SerienNr', 'Kunde_Nachname']);
  for (const entry of review) {
    const label = REVIEW_REASON_LABELS[entry.reason] || entry.reason;
    for (const row of entry.rows) {
      sheet.addRow([
        label,
        row.bonnummer,
        row.artikelbezeichnung,
        row.pgr,
        row.anzahl,
        row.umsatz,
        row.seriennr,
        row.nachname
      ]);
    }
  }
  sheet.getRow(1).font = { bold: true };
}

module.exports = {
  buildOutput,
  writeOutputToTemplate,
  writeReviewSheet,
  TARGET_COLS,
  wgProdukttyp,
  REVIEW_REASON_LABELS
};
