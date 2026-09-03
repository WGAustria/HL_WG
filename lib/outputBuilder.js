const ExcelJS = require('exceljs');
const {
  readReportRows,
  groupByBon,
  pairBonGroup,
  applyStornoNetting
} = require('./reportPipeline');
const { deriveHersteller, isNetzbetreiberGeraet } = require('./brandMatch');
const { resolveBrandsViaLlm } = require('./brandLlmFallback');
const { buildVermittlerLookup } = require('./vermittlerLookup');
const { buildGeschaefteLookup } = require('./geschaefteLookup');
const { buildKategorieLookup } = require('./kategorieLookup');

// Zielspalten in "GS Basis"/"GS Komfort u. Plus" (1-indiziert, identischer
// Spaltenaufbau in beiden Blaettern - nur Policentyp/Produkttyp-Vorgabewerte
// unterscheiden sich). Reale Praxis laut Vorlage: KEINE Kundendaten
// (Anrede/EmailPrivat bleiben leer), stattdessen Filialnummer + Bonnummer
// zur internen Zuordnung und die GESCHAEFTSADRESSE statt der Kundenadresse.
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

// Ordnet einen WG-Artikel dem Zielblatt und den zugehoerigen Konstanten zu
// (Schritt: Komfort/Plus -> "GS Komfort u. Plus", sonst "GS Basis" - siehe
// Vorlage fuer die jeweiligen Policentyp/Produkttyp-Vorgabewerte).
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

// Legacy-Alias fuer den alten, codierten Produkttyp-String - wird nur noch
// fuer die (optionale) Vorschau in der Web-Oberflaeche verwendet.
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

// Fuehrt die komplette taegliche Aufbereitung durch: Reportfile lesen,
// filtern, paaren, Hersteller/AKP/FH-Nummer/Kategorie aufloesen,
// Ausgabezeilen fuer "GS Basis"/"GS Komfort u. Plus" sowie eine Pruefdatei
// erzeugen. Die Referenztabellen (MA Liste, Geschäfte Liste, Geraetekennzeichen
// Wertgarantie) stammen aus der VORLAGE, nicht aus dem taeglichen Report.
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

    const akp = lookupVermittlerNr(device.vknr, device.vkName);
    const geschaeft = lookupGeschaeft(device.filialnr);
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

    // Filtersystem: nur Zeilen, bei denen WIRKLICH alle Parameter vorhanden
    // sind, werden in die Einspieldatei uebernommen. Fehlt etwas (oder ist
    // es ein Netzbetreiber-Geraet, das bewusst nicht automatisch verarbeitet
    // werden soll), geht die komplette Zeile stattdessen NUR in die
    // Pruefdatei - dort im selben Spaltenformat wie die Zielblaetter, damit
    // sie nach Ergaenzung/Pruefung 1:1 in die Einspieldatei kopiert werden kann.
    const missingReasons = [];
    if (akp === null || akp === undefined) {
      missingReasons.push({ reason: 'akp-nicht-gefunden', missingField: 'akp' });
    }
    if (!geschaeft) {
      missingReasons.push({ reason: 'fh-nummer-nicht-gefunden', missingField: 'fhNummer' });
    }
    if (isNetzbetreiberGeraet(device.artikelbezeichnung)) {
      missingReasons.push({ reason: 'netzbetreiber-geraet', missingField: null });
    }

    if (missingReasons.length === 0) {
      outputRows.push(outputRow);
    } else {
      missingReasons.forEach(({ reason, missingField }) => {
        review.push({ reason, rows: [device], outputRow, missingField });
      });
    }
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

// WICHTIG: bei jedem Aufruf ein NEUES Objekt zurueckgeben. ExcelJS teilt
// Style-Objekte fuer frisch angelegte Zeilen intern per Referenz - wird
// dieselbe Objektinstanz an mehrere Zellen zugewiesen, faerbt eine spaetere
// Aenderung faelschlich auch alle anderen Zellen ein, die noch auf dieselbe
// Instanz zeigen (siehe Bugreport: ab Zeile ~50 waren ploetzlich alle Zeilen
// rot statt nur die Storno-Zeilen).
function noFill() {
  return { type: 'pattern', pattern: 'none' };
}
function stornoFill() {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
}

// Schreibt eine outputRow-Zeile in eine der beiden Zielblaetter, beginnend
// in der ersten leeren Zeile nach der Kopf-/Vorgabezeile.
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

    // Fuer JEDE Zeile explizit setzen (nicht nur fuer Storno-Zeilen) - siehe
    // Kommentar oben, warum ein "nichts tun" bei Nicht-Storno-Zeilen nicht sicher ist.
    for (let c = 1; c <= SHEET_LAST_COL; c++) {
      row.getCell(c).fill = data.isStorno ? stornoFill() : noFill();
    }
    row.commit();
  });
}

// Schreibt die Ausgabezeilen in "GS Basis" bzw. "GS Komfort u. Plus" (je
// nach Produkttyp), jeweils beginnend in der ersten leeren Zeile.
function writeOutputToTemplate(templateWorkbook, outputRows) {
  const sheets = {
    'GS Basis': templateWorkbook.getWorksheet('GS Basis'),
    'GS Komfort u. Plus': templateWorkbook.getWorksheet('GS Komfort u. Plus')
  };
  if (!sheets['GS Basis']) throw new Error('Blatt "GS Basis" in der Vorlage nicht gefunden.');
  if (!sheets['GS Komfort u. Plus']) throw new Error('Blatt "GS Komfort u. Plus" in der Vorlage nicht gefunden.');

  writeRowsToSheet(sheets['GS Basis'], outputRows.filter((r) => r.sheetName === 'GS Basis'));
  writeRowsToSheet(sheets['GS Komfort u. Plus'], outputRows.filter((r) => r.sheetName === 'GS Komfort u. Plus'));

  // Die Vorlage kann (je nach Historie) eine interne Excel-"Tabelle" oder
  // einen AutoFilter-Bereich enthalten, der fest an eine aeltere Zeilenzahl
  // gebunden ist. Da wir darueber hinaus schreiben, meldet Excel sonst
  // "Problem mit Inhalten" beim Oeffnen. Zur Sicherheit hier nochmal entfernen
  // (die ausgelieferte Vorlage ist bereits bereinigt, siehe templates/).
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
  'mehrere-storno-kandidaten': 'Mehrere Storno-Kandidaten im Bon - Zuordnung unklar',
  'wg-ohne-geraet': 'WG-Artikel ohne Gerät (-> Gebraucht Nachtrag)',
  'wg-gs-unklar': '"Wertgarantie GS" - kein GKZ-Treffer in PG Matching',
  'akp-nicht-gefunden': 'AKP nicht in MA Liste gefunden (Personalnummer unbekannt)',
  'fh-nummer-nicht-gefunden': 'Filiale nicht in Geschäfte Liste gefunden (FH Nummer/Adresse fehlt)',
  'netzbetreiber-geraet': 'Netzbetreiber-Gerät (Mobilfunk-Vorwahl erkannt) - nicht automatisch übernommen'
};

// Spalten in exakt der Reihenfolge der Zielblaetter (nur die echten
// Datenfelder, ohne die leeren "<Tag>"-Strukturspalten) - so kann dieser
// Block 1:1 in "GS Basis"/"GS Komfort u. Plus" kopiert werden.
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
  // Frisches Objekt bei jedem Aufruf - siehe Kommentar bei stornoFill()/
  // noFill() weiter oben, warum ein geteiltes Objekt hier gefaehrlich waere.
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

// Baut aus einer rohen Report-Zeile (Geraet oder WG-Artikel, noch nicht
// gepaart) eine best-moegliche Zeile im Zielformat - fuer Pruefdatei-Faelle,
// die vor der eigentlichen Paarung/Aufloesung entstehen (wg-ohne-geraet,
// mehrdeutige Paarung, wg-gs-unklar).
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

// Baut die Pruefdatei als EINE Arbeitsmappe/EIN Blatt, im exakt selben
// Spaltenformat wie die Zielblaetter (DATEN_HEADER), mit angehaengter
// Grund-/Bonnummer-/Hinweis-Spalte danach - das ist das "Filtersystem":
// alles, was NICHT alle Parameter hat (oder ein Netzbetreiber-Geraet ist),
// landet ausschliesslich hier statt in der Einspieldatei. Bereits bekannte
// Werte sind vorausgefuellt, das fehlende/unklare Feld ist gelb markiert -
// so kann die Zeile nach Ergaenzung/Pruefung 1:1 kopiert werden.
function buildReviewWorkbook(review, { lookupGeschaeft, lookupKategorie }) {
  const workbook = new ExcelJS.Workbook();
  const extraHeaders = ['Grund', 'Bonnummer', 'Hinweis'];
  const totalCols = DATEN_HEADER.length + extraHeaders.length;
  const sheet = workbook.addWorksheet('Pruefdatei');
  sheet.addRow([
    'Diese Zeilen konnten laut Filtersystem nicht automatisch in "GS Basis"/"GS Komfort ' +
    'u. Plus" übernommen werden (Parameter fehlt oder Netzbetreiber-Gerät). Gelb markierte ' +
    'Felder bitte prüfen/ergänzen, danach die Zeile in das passende Blatt kopieren (siehe Produkttyp).'
  ]);
  sheet.mergeCells(1, 1, 1, totalCols);
  sheet.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
  sheet.getRow(1).alignment = { wrapText: true, vertical: 'top' };
  sheet.getRow(1).height = 32;
  sheet.addRow([...DATEN_HEADER, ...extraHeaders]);
  sheet.getRow(2).font = { bold: true };
  sheet.columns.forEach((col) => { col.width = 20; });

  const byReason = {};
  for (const entry of review) {
    (byReason[entry.reason] = byReason[entry.reason] || []).push(entry);
  }

  function addDatenRow(cells, reason, bonnummer, hinweis, highlightCols) {
    const label = REVIEW_REASON_LABELS[reason] || reason;
    const row = sheet.addRow([...cells, label, bonnummer, hinweis]);
    highlightCols.forEach((c) => { row.getCell(c).fill = highlightFill(); });
    return row;
  }

  // 1) AKP fehlt - Zeile ist inhaltlich bereits vollstaendig, nur die AKP fehlt noch.
  for (const entry of byReason['akp-nicht-gefunden'] || []) {
    addDatenRow(
      outputRowToDatenCells(entry.outputRow),
      entry.reason,
      entry.outputRow.bonnummer,
      'AKP ermitteln (z.B. über MA Liste/Verkäufername) und eintragen.',
      [DATEN_COL.AKP]
    );
  }

  // 2) FH Nummer/Geschaeftsadresse fehlt - Filiale nicht in Geschäfte Liste gefunden.
  for (const entry of byReason['fh-nummer-nicht-gefunden'] || []) {
    addDatenRow(
      outputRowToDatenCells(entry.outputRow),
      entry.reason,
      entry.outputRow.bonnummer,
      'Filialnummer prüfen und FH Nummer/Geschäftsadresse manuell aus der Geschäfte Liste eintragen.',
      [DATEN_COL['FH Nummer'], DATEN_COL.Strasse, DATEN_COL.Hausnummer, DATEN_COL.Plz, DATEN_COL.Ort]
    );
  }

  // 3) Netzbetreiber-Geraet - Zeile ist inhaltlich vollstaendig, wird aber
  //    bewusst nicht automatisch uebernommen (siehe lib/brandMatch.js).
  for (const entry of byReason['netzbetreiber-geraet'] || []) {
    addDatenRow(
      outputRowToDatenCells(entry.outputRow),
      entry.reason,
      entry.outputRow.bonnummer,
      'Mobilfunk-Vorwahl in der Modellbezeichnung erkannt - bitte manuell prüfen, bevor die Zeile übernommen wird.',
      [DATEN_COL.Typ]
    );
  }

  // 4) WG-Artikel ohne Geraet ("Gebraucht Nachtrag") - Zeile existiert noch
  //    NICHT in der Einspieldatei, muss nach Recherche komplett ergaenzt werden.
  for (const entry of byReason['wg-ohne-geraet'] || []) {
    const wg = entry.rows[0];
    const produktInfo = wgProduktInfo(wg.artikelbezeichnung);
    const cells = rawRowToDatenCells(wg, {
      lookupGeschaeft,
      lookupKategorie,
      hersteller: '',
      produkttyp: produktInfo.produkttyp,
      policentyp: produktInfo.policentyp
    });
    addDatenRow(
      cells,
      entry.reason,
      wg.bonnummer,
      `Gerätedaten recherchieren (Salesforce/AX/Rückfrage im Geschäft) - WG-Artikel: "${wg.artikelbezeichnung}", ${wg.umsatz} €.`,
      [
        DATEN_COL.AKP, DATEN_COL.Hersteller, DATEN_COL.Kategorie, DATEN_COL['Geraetekennzeichen'],
        DATEN_COL.Typ, DATEN_COL.Seriennummer, DATEN_COL.Baujahr
      ]
    );
  }

  // 5) Mehrdeutige Paarung - eine auszufuellende Vorlagenzeile je Bon, plus
  //    die Kandidatenzeilen darunter zur Entscheidungshilfe. Wird nicht mehr
  //    per Preisstaffel automatisch geraten (siehe lib/reportPipeline.js).
  const ambiguousReasons = ['mehrere-kandidaten-preis-seriennummer-pruefen', 'mehrere-storno-kandidaten'];
  for (const reason of ambiguousReasons) {
    for (const entry of byReason[reason] || []) {
      const first = entry.rows[0];
      const templateCells = rawRowToDatenCells(first, { lookupGeschaeft, lookupKategorie, hersteller: '', produkttyp: '', policentyp: '' });
      // Geraetespezifische Felder sind bei der Vorlagenzeile noch unklar -
      // bewusst leeren, damit sie nicht faelschlich vom ersten Kandidaten uebernommen werden.
      templateCells[DATEN_COL.Hersteller - 1] = '';
      templateCells[DATEN_COL.Kategorie - 1] = '';
      templateCells[DATEN_COL.Typ - 1] = '';
      templateCells[DATEN_COL['Geraetekennzeichen'] - 1] = '';
      templateCells[DATEN_COL.Seriennummer - 1] = '';
      templateCells[DATEN_COL.Kaufpreis - 1] = '';
      templateCells[DATEN_COL.Produkttyp - 1] = '';
      const templateRow = addDatenRow(
        templateCells,
        reason,
        first.bonnummer,
        'AUSFUELLEN anhand der Kandidat-Zeilen darunter, dann in das passende Blatt kopieren.',
        [
          DATEN_COL.AKP, DATEN_COL.Hersteller, DATEN_COL.Kategorie, DATEN_COL['Geraetekennzeichen'],
          DATEN_COL.Typ, DATEN_COL.Seriennummer, DATEN_COL.Kaufpreis, DATEN_COL.Produkttyp
        ]
      );
      templateRow.font = { bold: true };
      for (const candidate of entry.rows) {
        const candProduktInfo = candidate.pgr === 'Wertgarantie' ? wgProduktInfo(candidate.artikelbezeichnung) : null;
        const candidateCells = rawRowToDatenCells(candidate, {
          lookupGeschaeft,
          lookupKategorie,
          hersteller: candidate.hersteller || '',
          produkttyp: candProduktInfo ? candProduktInfo.produkttyp : '',
          policentyp: candProduktInfo ? candProduktInfo.policentyp : ''
        });
        addDatenRow(candidateCells, reason, candidate.bonnummer, `Kandidat (${candidate.pgr}, Anzahl ${candidate.anzahl}).`, []);
      }
    }
  }

  // 6) "Wertgarantie GS" ohne GKZ-Treffer - seltener Sonderfall.
  for (const entry of byReason['wg-gs-unklar'] || []) {
    const r = entry.rows[0];
    const cells = rawRowToDatenCells(r, { lookupGeschaeft, lookupKategorie, hersteller: r.hersteller || '', produkttyp: '', policentyp: '' });
    addDatenRow(
      cells,
      entry.reason,
      r.bonnummer,
      'Kein GKZ-Treffer in PG Matching - manuell prüfen und passende Zeile in das passende Blatt eintragen.',
      []
    );
  }

  return workbook;
}

module.exports = {
  buildOutput,
  writeOutputToTemplate,
  buildReviewWorkbook,
  TARGET_COLS,
  wgProdukttyp,
  wgProduktInfo,
  REVIEW_REASON_LABELS
};
