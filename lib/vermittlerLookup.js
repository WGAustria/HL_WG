// Loest die Vermittlernummer ueber die "MA Liste" auf: Report-Spalte E
// (vknr) entspricht der Spalte "Mitarbeiter" in MA Liste, dort steht in
// Spalte "Vermittler Nr" der gesuchte Wert. Fallback: Abgleich per
// Verkaeufername (Report Spalte AD / "vk_name" gegen MA Liste "Name").
function buildVermittlerLookup(maListeWorksheet) {
  const byMitarbeiter = new Map();
  const byName = new Map();

  maListeWorksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = row.getCell(1).value;
    const mitarbeiter = row.getCell(2).value;
    const vermittlerNr = row.getCell(3).value;
    if (mitarbeiter !== null && mitarbeiter !== undefined) {
      byMitarbeiter.set(Number(mitarbeiter), vermittlerNr);
    }
    if (name) {
      byName.set(String(name).trim().toLowerCase(), vermittlerNr);
    }
  });

  return function lookupVermittlerNr(vknr, vkName) {
    if (vknr !== null && vknr !== undefined && byMitarbeiter.has(Number(vknr))) {
      return byMitarbeiter.get(Number(vknr));
    }
    if (vkName && byName.has(String(vkName).trim().toLowerCase())) {
      return byName.get(String(vkName).trim().toLowerCase());
    }
    return null;
  };
}

module.exports = { buildVermittlerLookup };
