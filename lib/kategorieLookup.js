// Loest das Geraetekennzeichen (GKZ, bereits aus dem Report per VLOOKUP
// bekannt) gegen das Blatt "Geraetekennzeichen Wertgarantie" der Vorlage
// auf und liefert die Beschreibung (z.B. "Tablet-Computer", "Smartwatch")
// fuer die "Kategorie"-Spalte in "GS Basis"/"GS Komfort u. Plus".
function buildKategorieLookup(gkzSheet) {
  const byGkz = new Map();
  gkzSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const gkz = Number(row.getCell(1).value);
    if (Number.isNaN(gkz)) return;
    byGkz.set(gkz, row.getCell(2).value);
  });

  return function lookupKategorie(gkz) {
    const n = Number(gkz);
    if (Number.isNaN(n)) return '';
    return byGkz.get(n) || '';
  };
}

module.exports = { buildKategorieLookup };
