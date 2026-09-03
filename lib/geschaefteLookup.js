// Loest Filialnummer (Report Spalte G, "GNR" in der Vorlage) gegen das Blatt
// "Geschäfte Liste" der Vorlage auf: liefert FH Nummer ("WG GNr"), PLZ, Ort
// und Strasse/Hausnummer der Filiale. Wird fuer "GS Basis"/"GS Komfort u.
// Plus" gebraucht, wo laut echter Praxis die GESCHAEFTSADRESSE eingetragen
// wird (keine Kundenadresse).
const COLS = { gnr: 2, plz: 5, ort: 6, strasse: 7, fhNummer: 22 };

// Trennt "Prager Straße 56" in Strasse="Prager Straße" und Hausnummer="56"
// (auch Ranges wie "Landstr. 101-103" oder Zusaetze wie "9a").
function splitStrasse(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(.*?)[,]?\s+(\d[\d/\-a-zA-Z]*)$/);
  if (!m) return { strasse: s, hausnummer: '' };
  return { strasse: m[1].trim(), hausnummer: m[2].trim() };
}

function buildGeschaefteLookup(geschaefteListeSheet) {
  const byGnr = new Map();
  geschaefteListeSheet.eachRow({ includeEmpty: false }, (row) => {
    const gnr = row.getCell(COLS.gnr).value;
    if (gnr === null || gnr === undefined || Number.isNaN(Number(gnr))) return;
    byGnr.set(Number(gnr), {
      fhNummer: row.getCell(COLS.fhNummer).value,
      plz: row.getCell(COLS.plz).value,
      ort: row.getCell(COLS.ort).value,
      ...splitStrasse(row.getCell(COLS.strasse).value)
    });
  });

  return function lookupGeschaeft(filialnr) {
    if (filialnr === null || filialnr === undefined) return null;
    return byGnr.get(Number(filialnr)) || null;
  };
}

module.exports = { buildGeschaefteLookup, splitStrasse };
