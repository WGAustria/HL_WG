// Fallback-Loesung fuer AKP (Vermittlernummer), wenn die Personalnummer
// keinen Treffer in "MA Liste" hat: die Filialnummer wird ueber
// lib/geschaefteLookup.js in eine FH Nummer aufgeloest, und aus dem Blatt
// "Partnerliste AKP" der Vorlage wird die ERSTE dort gelistete AKP-Nummer
// fuer diese FH Nummer genommen (Reihenfolge wie in der Original-Liste,
// keine weitere Auswahllogik - so vom Kunden vorgegeben).
function buildAkpFallbackLookup(partnerlisteSheet) {
  const firstAkpByFh = new Map();
  partnerlisteSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const akp = row.getCell(1).value;
    const fh = row.getCell(2).value;
    if (typeof akp !== 'number' || typeof fh !== 'number') return;
    if (!firstAkpByFh.has(fh)) firstAkpByFh.set(fh, akp);
  });

  return function lookupAkpFallback(fhNummer) {
    if (fhNummer === null || fhNummer === undefined) return null;
    return firstAkpByFh.get(Number(fhNummer)) ?? null;
  };
}

module.exports = { buildAkpFallbackLookup };
