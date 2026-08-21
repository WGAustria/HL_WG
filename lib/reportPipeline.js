// Kernlogik der taeglichen Wertgarantie-Geraeteschutz-Aufbereitung.
// Bildet die Schritte 3-20 der Anleitung deterministisch nach (Filtern,
// Paerchen bilden, Herstellername/GKZ ableiten). Schritte, die externe
// Systeme (Salesforce/AX) oder fehlende Referenzdaten (Listenpreise,
// Wertgarantie-Produktcodes) benoetigen, werden NICHT geraten, sondern
// als "needsReview"-Eintrag ausgegeben.

const REPORT_COLS = {
  vknr: 5,
  kundend: 6,
  filialnr: 7,
  nachname: 8,
  bonnummer: 9,
  email: 10,
  adresse: 11,
  strasse: 12,
  plz: 13,
  ort: 14,
  laenderkennzeichen: 15,
  adresse2: 16,
  kundendaten: 17,
  pgr: 18,
  anzahl: 19,
  hersteller: 20,
  gkz: 21,
  artikelbezeichnung: 22,
  seriennr: 23,
  datum: 24,
  umsatz: 25,
  baujahr: 26,
  anrede: 27,
  objektdaten: 28,
  fil_bezeichnung: 29,
  vk_name: 30,
  lcnr: 31,
  produktgruppe_id: 32,
  wert_produktgruppe: 33,
  artikelnr: 34,
  vorname: 35
};

function cellValue(row, col) {
  const v = row.getCell(col).value;
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result;
    if ('text' in v) return v.text;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
  }
  return v === undefined ? null : v;
}

function isErrorValue(v) {
  return v && typeof v === 'object' && 'error' in v;
}

// Liest alle Datenzeilen aus dem "Reportfile"-Blatt (oder einem Blatt mit
// derselben Spaltenstruktur, z.B. "Gebraucht Nachtrag") in einfache Objekte.
function readReportRows(worksheet) {
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const bonnummer = cellValue(row, REPORT_COLS.bonnummer);
    if (bonnummer === null) return;
    const gkzRaw = row.getCell(REPORT_COLS.gkz).value;
    const gkz = isErrorValue(gkzRaw) ? null : cellValue(row, REPORT_COLS.gkz);

    rows.push({
      rowNumber,
      vknr: cellValue(row, REPORT_COLS.vknr),
      kundend: cellValue(row, REPORT_COLS.kundend),
      filialnr: cellValue(row, REPORT_COLS.filialnr),
      nachname: cellValue(row, REPORT_COLS.nachname),
      bonnummer: String(bonnummer),
      email: cellValue(row, REPORT_COLS.email),
      strasse: cellValue(row, REPORT_COLS.strasse),
      plz: cellValue(row, REPORT_COLS.plz),
      ort: cellValue(row, REPORT_COLS.ort),
      pgr: cellValue(row, REPORT_COLS.pgr),
      anzahl: Number(cellValue(row, REPORT_COLS.anzahl) ?? 0),
      hersteller: cellValue(row, REPORT_COLS.hersteller),
      gkz,
      artikelbezeichnung: cellValue(row, REPORT_COLS.artikelbezeichnung),
      seriennr: cellValue(row, REPORT_COLS.seriennr),
      datum: cellValue(row, REPORT_COLS.datum),
      umsatz: Number(cellValue(row, REPORT_COLS.umsatz) ?? 0),
      anrede: cellValue(row, REPORT_COLS.anrede),
      vorname: cellValue(row, REPORT_COLS.vorname),
      produktgruppeId: cellValue(row, REPORT_COLS.produktgruppe_id)
    });
  });
  return rows;
}

// Klassifiziert eine Zeile anhand des in der Report-Datei bereits berechneten
// Gerätekennzeichen-VLOOKUP (Spalte U): numerischer Code -> Geraet,
// PGR_Bezeichnung "Wertgarantie" -> WG-Artikel, sonst irrelevant (Zubehoer,
// Dienstleistungen, Gutscheine, ...). "Wertgarantie GS" hat in der PG-Matching
// Tabelle keinen Treffer (#N/A) und wird daher separat zur Pruefung markiert.
function classifyRow(row) {
  if (row.pgr === 'Wertgarantie') return 'wg';
  if (row.pgr === 'Wertgarantie GS') return 'wg-review';
  if (typeof row.gkz === 'number') return 'device';
  return 'other';
}

function groupByBon(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.bonnummer)) groups.set(row.bonnummer, []);
    groups.get(row.bonnummer).push(row);
  }
  return groups;
}

// Versucht, Geraete- und WG-Zeilen innerhalb eines Bons zu Paeren zu machen
// (Schritte 5-8). Eindeutige 1:1-Faelle werden automatisch gepaart, alles
// andere (mehrere Kandidaten, ungerade Vorzeichen-Kombination) geht in die
// Pruefliste statt geraten zu werden.
function pairBonGroup(rows) {
  const devices = rows.filter((r) => classifyRow(r) === 'device');
  const wgItems = rows.filter((r) => classifyRow(r) === 'wg');
  const wgReview = rows.filter((r) => classifyRow(r) === 'wg-review');

  const pairs = [];
  const review = [];

  wgReview.forEach((r) =>
    review.push({ reason: 'wg-gs-unklar', rows: [r] })
  );

  if (devices.length === 0 && wgItems.length > 0) {
    wgItems.forEach((r) => review.push({ reason: 'wg-ohne-geraet', rows: [r] }));
    return { pairs, review };
  }
  if (devices.length > 0 && wgItems.length === 0) {
    // Geraet ohne WG-Artikel: laut Anleitung normaler Verkauf, nicht Teil
    // des Wertgarantie-Reportings -> ignorieren.
    return { pairs, review };
  }
  if (devices.length === 0 && wgItems.length === 0) {
    return { pairs, review };
  }

  if (devices.length === 1 && wgItems.length === 1) {
    pairs.push(buildPair(devices[0], wgItems[0]));
    return { pairs, review };
  }

  // Mehrere Kandidaten: Vorzeichen-reine 1:1-Zuordnung nach Betrag der
  // Anzahl versuchen (z.B. 1 normale + 1 Storno-Position je Seite).
  const posDevices = devices.filter((d) => d.anzahl >= 0);
  const negDevices = devices.filter((d) => d.anzahl < 0);
  const posWg = wgItems.filter((w) => w.anzahl >= 0);
  const negWg = wgItems.filter((w) => w.anzahl < 0);

  if (posDevices.length === 1 && posWg.length === 1 && negDevices.length === negWg.length) {
    pairs.push(buildPair(posDevices[0], posWg[0]));
    if (negDevices.length === 1 && negWg.length === 1) {
      pairs.push(buildPair(negDevices[0], negWg[0]));
    } else if (negDevices.length > 1 || negWg.length > 1) {
      review.push({ reason: 'mehrere-storno-kandidaten', rows: [...negDevices, ...negWg] });
    }
    return { pairs, review };
  }

  const posTierPairs = tryTierMatch(posDevices, posWg);
  const negTierPairs = negDevices.length || negWg.length ? tryTierMatch(negDevices, negWg) : [];
  if (posTierPairs && negTierPairs) {
    pairs.push(...posTierPairs, ...negTierPairs);
    return { pairs, review };
  }

  review.push({
    reason: 'mehrere-kandidaten-preis-seriennummer-pruefen',
    rows: [...devices, ...wgItems]
  });
  return { pairs, review };
}

function buildPair(device, wg) {
  return { device, wg, isStorno: device.anzahl < 0 || wg.anzahl < 0 };
}

// Liest die Preisobergrenze aus dem Namen des WG-Artikels, z.B.
// "WG UE Garantie 5J bis 300 €" -> 300, "WG Geräteschutz Plus Handy - 150 €" -> 150.
function wgPriceCeiling(wg) {
  const s = String(wg.artikelbezeichnung || '');
  const m = s.match(/(?:bis|-)\s*([\d.]+)\s*€/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, ''));
}

// Ordnet mehrere Geraete mehreren WG-Artikeln im selben Bon anhand der im
// WG-Artikelnamen enthaltenen Preisobergrenze zu (Schritt 5: "schau auf
// Preis in Spalte Y"). Gibt null zurueck, wenn keine eindeutige Zuordnung
// moeglich ist (dann muss die Bon-Gruppe manuell geprueft werden).
function tryTierMatch(devices, wgItems) {
  if (devices.length !== wgItems.length) return null;
  const wgWithCeiling = wgItems.map((wg) => ({ wg, ceiling: wgPriceCeiling(wg) }));
  if (wgWithCeiling.some((w) => w.ceiling === null)) return null;

  wgWithCeiling.sort((a, b) => a.ceiling - b.ceiling);
  const remainingDevices = [...devices];
  const pairs = [];

  for (const { wg, ceiling } of wgWithCeiling) {
    const candidates = remainingDevices
      .filter((d) => d.umsatz <= ceiling)
      .sort((a, b) => b.umsatz - a.umsatz);
    if (candidates.length === 0) return null;
    const chosen = candidates[0];
    remainingDevices.splice(remainingDevices.indexOf(chosen), 1);
    pairs.push(buildPair(chosen, wg));
  }
  if (remainingDevices.length > 0) return null;
  return pairs;
}

// Schritt 7: Pärchen mit Minus-Position, die sich exakt mit einem
// gegengleichen positiven Pärchen im selben Bon aufheben, werden beidseitig
// entfernt (weder Storno noch normale Zeile).
function nettingKey(pair) {
  return [pair.device.hersteller ?? '', pair.device.artikelbezeichnung, pair.device.umsatz, pair.wg.artikelbezeichnung, pair.wg.umsatz].join('|');
}

function applyStornoNetting(pairsByBon) {
  const kept = [];
  for (const pairs of pairsByBon.values()) {
    const positives = pairs.filter((p) => !p.isStorno);
    const negatives = pairs.filter((p) => p.isStorno);
    const usedNeg = new Set();
    for (const pos of positives) {
      const key = nettingKey(pos);
      const matchIdx = negatives.findIndex((n, i) => !usedNeg.has(i) && nettingKey(n) === key);
      if (matchIdx !== -1) {
        usedNeg.add(matchIdx);
        // beide werden verworfen (heben sich auf)
      } else {
        kept.push(pos);
      }
    }
    negatives.forEach((n, i) => {
      if (!usedNeg.has(i)) kept.push(n); // bleibt als Storno bestehen
    });
  }
  return kept;
}

module.exports = {
  REPORT_COLS,
  readReportRows,
  classifyRow,
  groupByBon,
  pairBonGroup,
  applyStornoNetting,
  wgPriceCeiling
};
