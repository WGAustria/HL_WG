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
  // Bleibt der Hersteller auch nach Markenliste + LLM-Fallback unbekannt,
  // wird laut Vorgabe "sonstige" eingetragen statt die Zeile zurueckzuhalten.
  for (const pair of pairs) {
    if (!pair.hersteller) pair.hersteller = 'sonstige';
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

    const outputRow = {
      bonnummer: device.bonnummer,
      antragsdatum: device.datum,
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
    };

    // Filtersystem: nur Zeilen, bei denen WIRKLICH alle Parameter vorhanden
    // sind, werden in die Einspieldatei uebernommen. Fehlt etwas (oder ist
    // es ein Netzbetreiber-Geraet, das bewusst nicht automatisch verarbeitet
    // werden soll), geht die komplette Zeile stattdessen NUR in die
    // Pruefdatei - dort im selben Spaltenformat wie das "Daten"-Blatt, damit
    // sie nach Ergaenzung/Pruefung 1:1 in die Einspieldatei kopiert werden kann.
    const missingReasons = [];
    if (vermittlerNr === null || vermittlerNr === undefined) {
      missingReasons.push({ reason: 'vermittlernummer-nicht-gefunden', missingField: 'vermittlernummer' });
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
    row.getCell(TARGET_COLS.antragsdatum).numFmt = DATE_FORMAT;
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
    row.getCell(TARGET_COLS.kaufdatum).numFmt = DATE_FORMAT;
    row.getCell(TARGET_COLS.kaufpreis).value = data.kaufpreis;
    row.getCell(TARGET_COLS.baujahr).value = data.baujahr;
    row.getCell(TARGET_COLS.antragskodierung).value = data.antragskodierung;
    row.getCell(TARGET_COLS.produkttyp).value = data.produkttyp;

    // Fuer JEDE Zeile explizit setzen (nicht nur fuer Storno-Zeilen) - siehe
    // Kommentar oben, warum ein "nichts tun" bei Nicht-Storno-Zeilen nicht sicher ist.
    for (let c = 1; c <= 33; c++) {
      row.getCell(c).fill = data.isStorno ? stornoFill() : noFill();
    }
    row.commit();
  });

  // Die Vorlage enthaelt eine interne Excel-"Tabelle" (AutoFilter-Bereich),
  // die fest an die urspruenglichen 41 Zeilen gebunden ist. Da wir weit
  // darueber hinaus schreiben, meldet Excel sonst "Problem mit Inhalten"
  // beim Oeffnen, weil der Tabellenbereich nicht mehr zur Blattgroesse
  // passt. Wird hier entfernt, da sie fuer eine Import-Datei nicht gebraucht
  // wird (nur ein AutoFilter-Artefakt aus der Vorlagen-Erstellung).
  for (const name of Object.keys(sheet.tables || {})) {
    sheet.removeTable(name);
  }

  // Das Entfernen der Tabelle allein reicht nicht: Excel speichert den
  // AutoFilter-Bereich zusaetzlich als eigenstaendigen "definedName"
  // (_xlnm._FilterDatabase) auf Workbook-Ebene, unabhaengig von der
  // Tabellen-Definition. Bleibt der stehen, verweist er weiterhin auf den
  // alten $A$1:$AG$41-Bereich und Excel meldet trotzdem einen
  // Inhaltsfehler beim Oeffnen. Deshalb hier ebenfalls entfernen.
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
  'vermittlernummer-nicht-gefunden': 'Vermittlernummer nicht in MA Liste gefunden',
  'netzbetreiber-geraet': 'Netzbetreiber-Gerät (Mobilfunk-Vorwahl erkannt) - nicht automatisch übernommen'
};

// Spalten in exakt der Reihenfolge des "Daten"-Blatts (nur die echten
// Datenfelder, ohne die leeren "<Tag>"-Strukturspalten) - so kann dieser
// Block 1:1 in die Einspieldatei kopiert werden.
const DATEN_HEADER = [
  'Antragsdatum', 'Vermittlernummer', 'Anrede', 'Vorname', 'Nachname', 'EmailPrivat',
  'Strasse', 'PLZ', 'Ort', 'Laenderkennzeichen', 'Position', 'Hersteller',
  'Geraetekennzeichen', 'Modellbezeichnung', 'Seriennummer', 'Kaufdatum', 'Kaufpreis',
  'Baujahr', 'Antragskodierung', 'Produkttyp'
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
    outputRow.antragsdatum, outputRow.vermittlernummer, outputRow.anrede, outputRow.vorname,
    outputRow.nachname, outputRow.email, outputRow.strasse, outputRow.plz, outputRow.ort,
    outputRow.laenderkennzeichen, outputRow.position, outputRow.hersteller,
    outputRow.geraetekennzeichen, outputRow.modellbezeichnung, outputRow.seriennummer,
    outputRow.kaufdatum, outputRow.kaufpreis, outputRow.baujahr, outputRow.antragskodierung,
    outputRow.produkttyp
  ];
}

// Baut die Pruefdatei als EINE Arbeitsmappe/EIN Blatt, im exakt selben
// Spaltenformat wie das "Daten"-Blatt der Einspieldatei (DATEN_HEADER),
// mit angehaengter Grund-/Bonnummer-/Hinweis-Spalte danach - das ist das
// "Filtersystem": alles, was NICHT alle Parameter hat (oder ein
// Netzbetreiber-Geraet ist), landet ausschliesslich hier statt in der
// Einspieldatei. Bereits bekannte Werte sind vorausgefuellt, das
// fehlende/unklare Feld ist gelb markiert - so kann die Zeile nach
// Ergaenzung/Pruefung 1:1 in die Einspieldatei kopiert werden.
function buildReviewWorkbook(review) {
  const workbook = new ExcelJS.Workbook();
  const extraHeaders = ['Grund', 'Bonnummer', 'Hinweis'];
  const totalCols = DATEN_HEADER.length + extraHeaders.length;
  const sheet = workbook.addWorksheet('Pruefdatei');
  sheet.addRow([
    'Diese Zeilen konnten laut Filtersystem nicht automatisch in die Einspieldatei ' +
    'übernommen werden (Parameter fehlt oder Netzbetreiber-Gerät). Gelb markierte ' +
    'Felder bitte prüfen/ergänzen, danach die Zeile in die Einspieldatei kopieren.'
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

  // 1) Vermittlernummer fehlt - Zeile ist inhaltlich bereits vollstaendig,
  //    nur die Vermittlernummer fehlt noch.
  for (const entry of byReason['vermittlernummer-nicht-gefunden'] || []) {
    addDatenRow(
      outputRowToDatenCells(entry.outputRow),
      entry.reason,
      entry.outputRow.bonnummer,
      'Vermittlernummer ermitteln (z.B. über MA Liste/Verkäufername) und eintragen.',
      [DATEN_COL.Vermittlernummer]
    );
  }

  // 2) Netzbetreiber-Geraet - Zeile ist inhaltlich vollstaendig, wird aber
  //    bewusst nicht automatisch uebernommen (siehe lib/brandMatch.js).
  for (const entry of byReason['netzbetreiber-geraet'] || []) {
    addDatenRow(
      outputRowToDatenCells(entry.outputRow),
      entry.reason,
      entry.outputRow.bonnummer,
      'Mobilfunk-Vorwahl in der Modellbezeichnung erkannt - bitte manuell prüfen, bevor die Zeile übernommen wird.',
      [DATEN_COL.Modellbezeichnung]
    );
  }

  // 3) WG-Artikel ohne Geraet ("Gebraucht Nachtrag") - Zeile existiert noch
  //    NICHT in der Einspieldatei, muss nach Recherche komplett ergaenzt werden.
  for (const entry of byReason['wg-ohne-geraet'] || []) {
    const wg = entry.rows[0];
    const cells = [
      wg.datum, '', wg.anrede || '', wg.vorname || '', wg.nachname || '', wg.email || '',
      wg.strasse || '', wg.plz || '', wg.ort || '', 'AT', 1,
      '', '', '', '', wg.datum, '', '', '', wgProdukttyp(wg.artikelbezeichnung)
    ];
    addDatenRow(
      cells,
      entry.reason,
      wg.bonnummer,
      `Gerätedaten recherchieren (Salesforce/AX/Rückfrage im Geschäft) - WG-Artikel: "${wg.artikelbezeichnung}", ${wg.umsatz} €.`,
      [
        DATEN_COL.Vermittlernummer, DATEN_COL.Hersteller, DATEN_COL.Geraetekennzeichen,
        DATEN_COL.Modellbezeichnung, DATEN_COL.Seriennummer, DATEN_COL.Kaufpreis, DATEN_COL.Baujahr
      ]
    );
  }

  // 4) Mehrdeutige Paarung - eine auszufuellende Vorlagenzeile je Bon, plus
  //    die Kandidatenzeilen darunter zur Entscheidungshilfe. Wird nicht mehr
  //    per Preisstaffel automatisch geraten (siehe lib/reportPipeline.js).
  const ambiguousReasons = ['mehrere-kandidaten-preis-seriennummer-pruefen', 'mehrere-storno-kandidaten'];
  for (const reason of ambiguousReasons) {
    for (const entry of byReason[reason] || []) {
      const first = entry.rows[0];
      const templateCells = [
        first.datum, '', first.anrede || '', first.vorname || '', first.nachname || '', first.email || '',
        first.strasse || '', first.plz || '', first.ort || '', 'AT', 1,
        '', '', '', '', first.datum, '', '', '', ''
      ];
      const templateRow = addDatenRow(
        templateCells,
        reason,
        first.bonnummer,
        'AUSFUELLEN anhand der Kandidat-Zeilen darunter, dann in die Einspieldatei kopieren.',
        [
          DATEN_COL.Vermittlernummer, DATEN_COL.Hersteller, DATEN_COL.Geraetekennzeichen,
          DATEN_COL.Modellbezeichnung, DATEN_COL.Seriennummer, DATEN_COL.Kaufpreis,
          DATEN_COL.Baujahr, DATEN_COL.Produkttyp
        ]
      );
      templateRow.font = { bold: true };
      for (const candidate of entry.rows) {
        const candidateCells = [
          candidate.datum, '', candidate.anrede || '', candidate.vorname || '', candidate.nachname || '',
          candidate.email || '', candidate.strasse || '', candidate.plz || '', candidate.ort || '', 'AT', '',
          candidate.hersteller || '', candidate.gkz || '', candidate.artikelbezeichnung, candidate.seriennr || '',
          candidate.datum, candidate.umsatz, '', '', ''
        ];
        addDatenRow(candidateCells, reason, candidate.bonnummer, `Kandidat (${candidate.pgr}, Anzahl ${candidate.anzahl}).`, []);
      }
    }
  }

  // 5) "Wertgarantie GS" ohne GKZ-Treffer - seltener Sonderfall.
  for (const entry of byReason['wg-gs-unklar'] || []) {
    const r = entry.rows[0];
    const cells = [
      r.datum, '', r.anrede || '', r.vorname || '', r.nachname || '', r.email || '',
      r.strasse || '', r.plz || '', r.ort || '', 'AT', '',
      r.hersteller || '', typeof r.gkz === 'number' ? r.gkz : '', r.artikelbezeichnung || '', r.seriennr || '',
      r.datum, r.umsatz, '', '', ''
    ];
    addDatenRow(
      cells,
      entry.reason,
      r.bonnummer,
      'Kein GKZ-Treffer in PG Matching - manuell prüfen und passende Zeile in die Einspieldatei eintragen.',
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
  REVIEW_REASON_LABELS
};
