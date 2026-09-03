const ExcelJS = require('exceljs');
const {
  readReportRows,
  groupByBon,
  pairBonGroup,
  applyStornoNetting
} = require('./reportPipelineV1');
const { deriveHersteller, isNetzbetreiberGeraet } = require('./brandMatchV1');
const { resolveBrandsViaLlm } = require('./brandLlmFallback');
const { buildVermittlerLookup } = require('./vermittlerLookup');
const { buildGeschaefteLookup } = require('./geschaefteLookup');
const { buildKategorieLookup } = require('./kategorieLookup');
const { buildAkpFallbackLookup } = require('./akpFallbackLookup');

// Zielspalten in "GS Basis"/"GS Komfort u. Plus" (1-indiziert) - siehe
// lib/outputBuilder.js fuer die ausfuehrliche Begruendung der Zuordnung.
// Spalten 4,5,16,18,19,28 sind reine "<Tag>"-Strukturspalten und bleiben leer.
const TARGET_COLS = {
  fhNummer: 1,
  akp: 2,
  personalnummer: 3,
  anrede: 6,
  filialnr: 7,
  bonnummerLabel: 8,
  kassenbonnummer: 9,
  zusatz: 10,
  strasse: 11,
  hausnummer: 12,
  laenderkennzeichen: 13,
  plz: 14,
  ort: 15,
  email: 17,
  hersteller: 20,
  kategorie: 21,
  typ: 22,
  geraetekennzeichen: 23,
  seriennummer: 24,
  baujahr: 25,
  kaufdatum: 26,
  kaufpreis: 27,
  policentyp: 29,
  produkttyp: 30,
  inkassoart: 31,
  zahlungsweise: 32
};
const SHEET_LAST_COL = 32;

function wgProduktInfo(wgArtikelbezeichnung) {
  const s = String(wgArtikelbezeichnung || '');
  if (/komfort/i.test(s)) {
    return { sheetName: 'GS Komfort u. Plus', produkttyp: 'Geräteschutz Komfort', policentyp: 'GERAETESCHUTZ' };
  }
  if (/plus/i.test(s)) {
    return { sheetName: 'GS Komfort u. Plus', produkttyp: 'Geräteschutz Plus', policentyp: 'GERAETESCHUTZ' };
  }
  return { sheetName: 'GS Basis', produkttyp: 'Geräteschutz Basis', policentyp: 'GARANTIEVERLAENGERUNG' };
}

function wgProdukttyp(wgArtikelbezeichnung) {
  return wgProduktInfo(wgArtikelbezeichnung).produkttyp;
}

function inDateRange(dateVal, from, to) {
  if (!dateVal) return false;
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// Fuehrt die komplette taegliche Aufbereitung durch - bisherige Logik:
// Preisstaffel-Zuordnung bei mehreren Kandidaten aktiv (reportPipelineV1.js),
// Zeilen mit fehlender AKP/FH-Nummer werden TROTZDEM (mit Luecke) in die
// Einspieldatei uebernommen. Nur Netzbetreiber-Geraete werden ausgeschlossen.
async function buildOutput(reportWorkbook, { anthropic, model, dateFrom, dateTo, templateWorkbook } = {}) {
  const reportSheet = reportWorkbook.getWorksheet('Reportfile');
  const maListeSheet = reportWorkbook.getWorksheet('MA Liste');
  if (!reportSheet) throw new Error('Blatt "Reportfile" nicht gefunden.');
  if (!maListeSheet) throw new Error('Blatt "MA Liste" nicht gefunden.');

  if (!templateWorkbook) throw new Error('Vorlage (fuer Geschäfte Liste/Geraetekennzeichen) fehlt.');
  const geschaefteSheet = templateWorkbook.getWorksheet('Geschäfte Liste');
  const gkzSheet = templateWorkbook.getWorksheet('Geraetekennzeichen Wertgarantie');
  if (!geschaefteSheet) throw new Error('Blatt "Geschäfte Liste" in der Vorlage nicht gefunden.');
  if (!gkzSheet) throw new Error('Blatt "Geraetekennzeichen Wertgarantie" in der Vorlage nicht gefunden.');
  const lookupGeschaeft = buildGeschaefteLookup(geschaefteSheet);
  const lookupKategorie = buildKategorieLookup(gkzSheet);
  // "Partnerliste AKP" ist optional - falls (noch) nicht in der Vorlage
  // vorhanden, faellt der AKP-Fallback ueber die Filialnummer einfach weg.
  const partnerlisteSheet = templateWorkbook.getWorksheet('Partnerliste AKP');
  const lookupAkpFallback = partnerlisteSheet ? buildAkpFallbackLookup(partnerlisteSheet) : () => null;

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
  // Bleibt der Hersteller auch nach Markenliste + LLM-Fallback unbekannt,
  // wird laut Vorgabe "sonstige" eingetragen statt die Zeile zurueckzuhalten.
  for (const pair of pairs) {
    if (!pair.hersteller) pair.hersteller = 'sonstige';
  }

  const lookupVermittlerNr = buildVermittlerLookup(maListeSheet);

  const now = new Date();
  const currentYear = now.getFullYear();
  const outputRows = [];

  for (const pair of pairs) {
    const { device, wg, isStorno } = pair;

    const geschaeft = lookupGeschaeft(device.filialnr);
    // AKP primaer ueber Personalnummer/Name in "MA Liste"; findet sich dort
    // kein Treffer, ersatzweise die erste AKP-Nummer aus "Partnerliste AKP"
    // fuer die (ueber die Filialnummer aufgeloeste) FH Nummer der Filiale.
    const akpPrimary = lookupVermittlerNr(device.vknr, device.vkName);
    const akp = akpPrimary ?? lookupAkpFallback(geschaeft ? geschaeft.fhNummer : null);
    const produktInfo = wgProduktInfo(wg.artikelbezeichnung);

    const outputRow = {
      bonnummer: device.bonnummer,
      fhNummer: geschaeft ? geschaeft.fhNummer : '',
      akp: akp ?? '',
      personalnummer: device.vknr ?? '',
      anrede: '',
      filialnr: device.filialnr ?? '',
      kassenbonnummer: device.bonnummer,
      strasse: geschaeft ? geschaeft.strasse : '',
      hausnummer: geschaeft ? geschaeft.hausnummer : '',
      laenderkennzeichen: 'AT',
      plz: geschaeft ? geschaeft.plz : '',
      ort: geschaeft ? geschaeft.ort : '',
      email: '',
      hersteller: pair.hersteller || '',
      kategorie: lookupKategorie(device.gkz),
      typ: device.artikelbezeichnung,
      geraetekennzeichen: device.gkz,
      seriennummer: device.seriennr || wg.seriennr || '',
      baujahr: currentYear,
      kaufdatum: device.datum,
      kaufpreis: device.umsatz,
      policentyp: produktInfo.policentyp,
      produkttyp: produktInfo.produkttyp,
      inkassoart: 'Fachhaendler',
      zahlungsweise: 0,
      sheetName: produktInfo.sheetName,
      isStorno
    };

    // Fehlende AKP/FH-Nummer: die Zeile ist bereits (mit Luecke) in der
    // Einspieldatei enthalten - die Pruefliste referenziert dieselbe
    // Zeilendaten, damit sie 1:1 wiedergefunden und ergaenzt werden kann.
    if (akp === null || akp === undefined) {
      review.push({ reason: 'akp-nicht-gefunden', rows: [device], outputRow, missingField: 'akp' });
    }
    if (!geschaeft) {
      review.push({ reason: 'fh-nummer-nicht-gefunden', rows: [device], outputRow, missingField: 'fhNummer' });
    }

    // Netzbetreiber-Geraet: anders als bei fehlender AKP/FH-Nummer wird
    // diese Zeile bewusst NICHT in die Einspieldatei uebernommen, sondern
    // geht ausschliesslich in die Pruefliste (siehe lib/brandMatchV1.js).
    if (isNetzbetreiberGeraet(device.artikelbezeichnung)) {
      review.push({ reason: 'netzbetreiber-geraet', rows: [device], outputRow, missingField: null });
      continue;
    }

    outputRows.push(outputRow);
  }

  return {
    outputRows,
    review,
    stats: {
      totalRows: allRows.length,
      filteredRows: rows.length,
      bonGroups: groups.size,
      pairsCreated: pairs.length,
      einspieldateiRows: outputRows.length,
      pruefdateiRows: pairs.length - outputRows.length,
      stornoCount: outputRows.filter((r) => r.isStorno).length,
      reviewRowCount: review.reduce((sum, r) => sum + r.rows.length, 0)
    }
  };
}

const DATE_FORMAT = 'dd.mm.yyyy';

// WICHTIG: bei jedem Aufruf ein NEUES Objekt zurueckgeben - siehe
// lib/outputBuilder.js fuer die Begruendung (ExcelJS teilt Style-Objekte
// fuer frisch angelegte Zeilen intern per Referenz).
function noFill() {
  return { type: 'pattern', pattern: 'none' };
}
function stornoFill() {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
}

function writeRowsToSheet(sheet, rowsForSheet) {
  let startRow = 3;
  while (sheet.getRow(startRow).actualCellCount > 0) startRow++;

  rowsForSheet.forEach((data, i) => {
    const row = sheet.getRow(startRow + i);
    row.getCell(TARGET_COLS.fhNummer).value = data.fhNummer;
    row.getCell(TARGET_COLS.akp).value = data.akp;
    row.getCell(TARGET_COLS.personalnummer).value = data.personalnummer;
    row.getCell(TARGET_COLS.anrede).value = data.anrede;
    row.getCell(TARGET_COLS.filialnr).value = data.filialnr;
    row.getCell(TARGET_COLS.bonnummerLabel).value = 'Bonnummer';
    row.getCell(TARGET_COLS.kassenbonnummer).value = data.kassenbonnummer;
    row.getCell(TARGET_COLS.zusatz).value = 'Hartlauer';
    row.getCell(TARGET_COLS.strasse).value = data.strasse;
    row.getCell(TARGET_COLS.hausnummer).value = data.hausnummer;
    row.getCell(TARGET_COLS.laenderkennzeichen).value = data.laenderkennzeichen;
    row.getCell(TARGET_COLS.plz).value = data.plz;
    row.getCell(TARGET_COLS.ort).value = data.ort;
    row.getCell(TARGET_COLS.email).value = data.email;
    row.getCell(TARGET_COLS.hersteller).value = data.hersteller;
    row.getCell(TARGET_COLS.kategorie).value = data.kategorie;
    row.getCell(TARGET_COLS.typ).value = data.typ;
    row.getCell(TARGET_COLS.geraetekennzeichen).value = data.geraetekennzeichen;
    row.getCell(TARGET_COLS.seriennummer).value = data.seriennummer;
    row.getCell(TARGET_COLS.baujahr).value = data.baujahr;
    row.getCell(TARGET_COLS.kaufdatum).value = data.kaufdatum;
    row.getCell(TARGET_COLS.kaufdatum).numFmt = DATE_FORMAT;
    row.getCell(TARGET_COLS.kaufpreis).value = data.kaufpreis;
    row.getCell(TARGET_COLS.policentyp).value = data.policentyp;
    row.getCell(TARGET_COLS.produkttyp).value = data.produkttyp;
    row.getCell(TARGET_COLS.inkassoart).value = data.inkassoart;
    row.getCell(TARGET_COLS.zahlungsweise).value = data.zahlungsweise;

    for (let c = 1; c <= SHEET_LAST_COL; c++) {
      row.getCell(c).fill = data.isStorno ? stornoFill() : noFill();
    }
    row.commit();
  });
}

// Schreibt die Ausgabezeilen in "GS Basis" bzw. "GS Komfort u. Plus".
function writeOutputToTemplate(templateWorkbook, outputRows) {
  const sheets = {
    'GS Basis': templateWorkbook.getWorksheet('GS Basis'),
    'GS Komfort u. Plus': templateWorkbook.getWorksheet('GS Komfort u. Plus')
  };
  if (!sheets['GS Basis']) throw new Error('Blatt "GS Basis" in der Vorlage nicht gefunden.');
  if (!sheets['GS Komfort u. Plus']) throw new Error('Blatt "GS Komfort u. Plus" in der Vorlage nicht gefunden.');

  writeRowsToSheet(sheets['GS Basis'], outputRows.filter((r) => r.sheetName === 'GS Basis'));
  writeRowsToSheet(sheets['GS Komfort u. Plus'], outputRows.filter((r) => r.sheetName === 'GS Komfort u. Plus'));

  for (const sheet of templateWorkbook.worksheets) {
    for (const name of Object.keys(sheet.tables || {})) sheet.removeTable(name);
    sheet.autoFilter = undefined;
  }
  const definedNames = templateWorkbook.definedNames;
  if (definedNames && definedNames.matrixMap) {
    delete definedNames.matrixMap['_xlnm._FilterDatabase'];
  }
}

const REVIEW_REASON_LABELS = {
  'mehrere-kandidaten-preis-seriennummer-pruefen': 'Mehrere Geräte/WG-Artikel im Bon - Zuordnung unklar',
  'wg-ohne-geraet': 'WG-Artikel ohne Gerät (-> Gebraucht Nachtrag)',
  'wg-gs-unklar': '"Wertgarantie GS" - kein GKZ-Treffer in PG Matching',
  'akp-nicht-gefunden': 'AKP nicht in MA Liste gefunden (Personalnummer unbekannt)',
  'fh-nummer-nicht-gefunden': 'Filiale nicht in Geschäfte Liste gefunden (FH Nummer/Adresse fehlt)',
  'netzbetreiber-geraet': 'Netzbetreiber-Gerät (Mobilfunk-Vorwahl erkannt) - nicht automatisch übernommen'
};

// Baut eine EIGENSTAENDIGE, flache Arbeitsmappe mit allen Zeilen, die nicht
// automatisch verarbeitet werden konnten - die aeltere der beiden V1-Formate
// (Legacy-Download zum Vergleich mit der tabellierten Version).
function buildReviewWorkbook(review) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Prüfliste');
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
  sheet.columns.forEach((col) => { col.width = 28; });
  return workbook;
}

// Spalten in exakt der Reihenfolge der Zielblaetter (nur die echten
// Datenfelder, ohne die leeren "<Tag>"-Strukturspalten).
const DATEN_HEADER = [
  'FH Nummer', 'AKP', 'Personalnummer', 'Anrede', 'Filialnummer', 'Bonnummer',
  'Kassenbonnummer', 'Zusatz', 'Strasse', 'Hausnummer', 'Laenderkennzeichen',
  'Plz', 'Ort', 'EMail', 'Hersteller', 'Kategorie', 'Typ', 'Geraetekennzeichen',
  'Seriennummer', 'Baujahr', 'Kaufdatum', 'Kaufpreis', 'Policentyp', 'Produkttyp',
  'Inkassoart', 'Zahlungsweise'
];
const DATEN_COL = {};
DATEN_HEADER.forEach((name, i) => { DATEN_COL[name] = i + 1; });

function highlightFill() {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2AE' } };
}

function outputRowToDatenCells(outputRow) {
  return [
    outputRow.fhNummer, outputRow.akp, outputRow.personalnummer, outputRow.anrede,
    outputRow.filialnr, 'Bonnummer', outputRow.kassenbonnummer, 'Hartlauer',
    outputRow.strasse, outputRow.hausnummer, outputRow.laenderkennzeichen,
    outputRow.plz, outputRow.ort, outputRow.email, outputRow.hersteller,
    outputRow.kategorie, outputRow.typ, outputRow.geraetekennzeichen,
    outputRow.seriennummer, outputRow.baujahr, outputRow.kaufdatum, outputRow.kaufpreis,
    outputRow.policentyp, outputRow.produkttyp, outputRow.inkassoart, outputRow.zahlungsweise
  ];
}

function rawRowToDatenCells(row, { lookupGeschaeft, lookupKategorie, hersteller, produkttyp, policentyp }) {
  const geschaeft = lookupGeschaeft(row.filialnr);
  return [
    geschaeft ? geschaeft.fhNummer : '', '', row.vknr ?? '', '', row.filialnr ?? '',
    'Bonnummer', row.bonnummer, 'Hartlauer',
    geschaeft ? geschaeft.strasse : '', geschaeft ? geschaeft.hausnummer : '', 'AT',
    geschaeft ? geschaeft.plz : '', geschaeft ? geschaeft.ort : '', '',
    hersteller || '', typeof row.gkz === 'number' ? lookupKategorie(row.gkz) : '',
    row.artikelbezeichnung || '', typeof row.gkz === 'number' ? row.gkz : '',
    row.seriennr || '', '', row.datum, row.umsatz,
    policentyp || '', produkttyp || '', 'Fachhaendler', 0
  ];
}

function setupReviewSheet(workbook, name, instruction, extraHeaders) {
  const sheet = workbook.addWorksheet(name);
  const totalCols = DATEN_HEADER.length + extraHeaders.length;
  sheet.addRow([instruction]);
  sheet.mergeCells(1, 1, 1, totalCols);
  sheet.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
  sheet.getRow(1).alignment = { wrapText: true, vertical: 'top' };
  sheet.getRow(1).height = 32;
  sheet.addRow([...DATEN_HEADER, ...extraHeaders]);
  sheet.getRow(2).font = { bold: true };
  sheet.columns.forEach((col) => { col.width = 20; });
  return sheet;
}

function highlightCells(row, colIndexes) {
  colIndexes.forEach((c) => { row.getCell(c).fill = highlightFill(); });
}

// Baut die "Version 2" der Pruefdatei: ein eigener Tab je Grund, jeweils
// mit denselben Spalten wie die Zielblaetter (damit man den Block direkt
// hineinkopieren kann) und angehaengten Zusatzinfos danach.
function buildReviewWorkbookV2(review, { lookupGeschaeft, lookupKategorie }) {
  const workbook = new ExcelJS.Workbook();

  const byReason = {};
  for (const entry of review) {
    (byReason[entry.reason] = byReason[entry.reason] || []).push(entry);
  }

  // 1) AKP fehlt - Zeile ist bereits in der Einspieldatei, nur das eine Feld
  //    muss dort ergaenzt werden.
  const akpEntries = byReason['akp-nicht-gefunden'] || [];
  if (akpEntries.length) {
    const sheet = setupReviewSheet(
      workbook,
      'AKP fehlt',
      'Diese Zeilen sind bereits in der Einspieldatei enthalten (siehe Bonnummer). Bitte AKP ermitteln (z.B. über die MA Liste/Verkäufername) und dort direkt eintragen.',
      ['Bonnummer']
    );
    for (const entry of akpEntries) {
      const row = sheet.addRow([...outputRowToDatenCells(entry.outputRow), entry.outputRow.bonnummer]);
      highlightCells(row, [DATEN_COL.AKP]);
    }
  }

  // 2) FH Nummer/Geschaeftsadresse fehlt.
  const fhEntries = byReason['fh-nummer-nicht-gefunden'] || [];
  if (fhEntries.length) {
    const sheet = setupReviewSheet(
      workbook,
      'FH Nummer fehlt',
      'Diese Zeilen sind bereits in der Einspieldatei enthalten (siehe Bonnummer). Filialnummer prüfen und FH Nummer/Geschäftsadresse aus der Geschäfte Liste eintragen.',
      ['Bonnummer']
    );
    for (const entry of fhEntries) {
      const row = sheet.addRow([...outputRowToDatenCells(entry.outputRow), entry.outputRow.bonnummer]);
      highlightCells(row, [DATEN_COL['FH Nummer'], DATEN_COL.Strasse, DATEN_COL.Hausnummer, DATEN_COL.Plz, DATEN_COL.Ort]);
    }
  }

  // 3) Netzbetreiber-Geraet - Zeile ist inhaltlich vollstaendig, wird aber
  //    bewusst nicht automatisch uebernommen (siehe lib/brandMatchV1.js).
  const netzbetreiberEntries = byReason['netzbetreiber-geraet'] || [];
  if (netzbetreiberEntries.length) {
    const sheet = setupReviewSheet(
      workbook,
      'Netzbetreiber-Gerät',
      'Mobilfunk-Vorwahl in der Modellbezeichnung erkannt - bitte manuell prüfen, bevor die Zeile übernommen wird.',
      ['Bonnummer']
    );
    for (const entry of netzbetreiberEntries) {
      const row = sheet.addRow([...outputRowToDatenCells(entry.outputRow), entry.outputRow.bonnummer]);
      highlightCells(row, [DATEN_COL.Typ]);
    }
  }

  // 4) WG-Artikel ohne Geraet ("Gebraucht Nachtrag") - Zeile existiert noch
  //    NICHT in der Einspieldatei, muss nach Recherche komplett ergaenzt werden.
  const wgOhneGeraetEntries = byReason['wg-ohne-geraet'] || [];
  if (wgOhneGeraetEntries.length) {
    const sheet = setupReviewSheet(
      workbook,
      'WG ohne Gerät',
      'Für diese Wertgarantie-Artikel wurde kein passendes Gerät gefunden ("Gebraucht Nachtrag" laut Anleitung). Bitte Gerätedaten recherchieren (Salesforce/AX/Rückfrage im Geschäft), gelb markierte Felder ausfüllen und die komplette Zeile einfügen.',
      ['Bonnummer', 'WG-Artikel', 'WG-Preis']
    );
    for (const entry of wgOhneGeraetEntries) {
      const wg = entry.rows[0];
      const produktInfo = wgProduktInfo(wg.artikelbezeichnung);
      const cells = rawRowToDatenCells(wg, {
        lookupGeschaeft, lookupKategorie, hersteller: '',
        produkttyp: produktInfo.produkttyp, policentyp: produktInfo.policentyp
      });
      const row = sheet.addRow([...cells, wg.bonnummer, wg.artikelbezeichnung, wg.umsatz]);
      highlightCells(row, [
        DATEN_COL.AKP, DATEN_COL.Hersteller, DATEN_COL.Kategorie, DATEN_COL['Geraetekennzeichen'],
        DATEN_COL.Typ, DATEN_COL.Seriennummer, DATEN_COL.Baujahr
      ]);
    }
  }

  // 5) Mehrdeutige Paarung - eine auszufuellende Vorlagenzeile je Bon, plus
  //    die Kandidatenzeilen darunter zur Entscheidungshilfe.
  const ambiguousReasons = ['mehrere-kandidaten-preis-seriennummer-pruefen', 'mehrere-storno-kandidaten'];
  const ambiguousEntries = ambiguousReasons.flatMap((r) => byReason[r] || []);
  if (ambiguousEntries.length) {
    const sheet = setupReviewSheet(
      workbook,
      'Mehrdeutige Paarung',
      'Für diese Bons konnte die Zuordnung Gerät <-> Wertgarantie-Artikel nicht eindeutig automatisch bestimmt werden. Bitte anhand der "Kandidat"-Zeilen entscheiden, die "AUSFUELLEN"-Zeile ergänzen und kopieren.',
      ['Typ', 'Bonnummer', 'PGR_Bezeichnung', 'Anzahl']
    );
    for (const entry of ambiguousEntries) {
      const first = entry.rows[0];
      const templateCells = rawRowToDatenCells(first, { lookupGeschaeft, lookupKategorie, hersteller: '', produkttyp: '', policentyp: '' });
      templateCells[DATEN_COL.Hersteller - 1] = '';
      templateCells[DATEN_COL.Kategorie - 1] = '';
      templateCells[DATEN_COL.Typ - 1] = '';
      templateCells[DATEN_COL['Geraetekennzeichen'] - 1] = '';
      templateCells[DATEN_COL.Seriennummer - 1] = '';
      templateCells[DATEN_COL.Kaufpreis - 1] = '';
      templateCells[DATEN_COL.Produkttyp - 1] = '';
      const templateRow = sheet.addRow([...templateCells, 'AUSFUELLEN', first.bonnummer, '', '']);
      templateRow.font = { bold: true };
      highlightCells(templateRow, [
        DATEN_COL.AKP, DATEN_COL.Hersteller, DATEN_COL.Kategorie, DATEN_COL['Geraetekennzeichen'],
        DATEN_COL.Typ, DATEN_COL.Seriennummer, DATEN_COL.Kaufpreis, DATEN_COL.Produkttyp
      ]);
      for (const candidate of entry.rows) {
        const candProduktInfo = candidate.pgr === 'Wertgarantie' ? wgProduktInfo(candidate.artikelbezeichnung) : null;
        const candidateCells = rawRowToDatenCells(candidate, {
          lookupGeschaeft, lookupKategorie, hersteller: candidate.hersteller || '',
          produkttyp: candProduktInfo ? candProduktInfo.produkttyp : '',
          policentyp: candProduktInfo ? candProduktInfo.policentyp : ''
        });
        sheet.addRow([...candidateCells, 'Kandidat', candidate.bonnummer, candidate.pgr, candidate.anzahl]);
      }
    }
  }

  // 6) "Wertgarantie GS" ohne GKZ-Treffer - seltener Sonderfall, flache
  //    Liste (nach Bonnummer sortiert).
  const gsEntries = byReason['wg-gs-unklar'] || [];
  if (gsEntries.length) {
    const sheet = workbook.addWorksheet('Wertgarantie GS unklar');
    sheet.addRow(['Diese Wertgarantie-Variante ("Wertgarantie GS") ist in der PG-Matching-Tabelle nicht hinterlegt, daher konnte kein Gerätekennzeichen ermittelt werden. Bitte manuell prüfen und passende Zeile eintragen.']);
    sheet.mergeCells(1, 1, 1, 8);
    sheet.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
    sheet.getRow(1).alignment = { wrapText: true };
    sheet.addRow(['Bonnummer', 'Typ', 'ArtikelBezeichnung', 'PGR_Bezeichnung', 'Anzahl', 'Umsatz', 'SerienNr', 'Nachname']);
    sheet.getRow(2).font = { bold: true };
    sheet.columns.forEach((col) => { col.width = 22; });
    const flat = gsEntries
      .map((entry) => entry.rows[0])
      .sort((a, b) => String(a.bonnummer).localeCompare(String(b.bonnummer)));
    for (const r of flat) {
      sheet.addRow([r.bonnummer, r.pgr === 'Wertgarantie GS' ? 'WG-GS-Artikel' : 'Gerät', r.artikelbezeichnung, r.pgr, r.anzahl, r.umsatz, r.seriennr, r.nachname]);
    }
  }

  return workbook;
}

module.exports = {
  buildOutput,
  writeOutputToTemplate,
  buildReviewWorkbook,
  buildReviewWorkbookV2,
  TARGET_COLS,
  wgProdukttyp,
  wgProduktInfo,
  REVIEW_REASON_LABELS
};
