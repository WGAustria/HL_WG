// Leitet den Hersteller aus der kryptisch abgekuerzten ArtikelBezeichnung
// bzw. der PGR_Bezeichnung ab (Schritt 10 der Anleitung). Alles, was hier
// nicht sicher erkannt wird, bleibt null und wird gebuendelt per LLM
// aufgeloest (siehe lib/brandLlmFallback.js), statt geraten zu werden.

// Vollstaendige Markennamen, die manchmal direkt in der PGR_Bezeichnung
// auftauchen (z.B. "Samsung Smartphone", "Smartwatch Garmin").
const PGR_BRANDS = [
  'Samsung', 'Garmin', 'Apple', 'Polar', 'Huawei', 'Xiaomi', 'Emporia',
  'BEA-FON', 'Rollei', 'Canon', 'Sony', 'Nikon', 'Panasonic'
];

// Abkuerzung (erstes Token der ArtikelBezeichnung, kleingeschrieben) -> Marke.
// Aus den haeufigsten Tokens der echten Report-Datei abgeleitet.
const TOKEN_ABBREVIATIONS = {
  sam: 'Samsung',
  samsung: 'Samsung',
  gar: 'Garmin',
  garmin: 'Garmin',
  app: 'Apple',
  apple: 'Apple',
  hp: 'HP',
  jbl: 'JBL',
  xia: 'Xiaomi',
  xiaomi: 'Xiaomi',
  len: 'Lenovo',
  lenovo: 'Lenovo',
  hua: 'Huawei',
  huawei: 'Huawei',
  pol: 'Polar',
  polar: 'Polar',
  fujifilm: 'Fujifilm',
  sony: 'Sony',
  gopro: 'GoPro',
  gop: 'GoPro',
  emp: 'Emporia',
  emporia: 'Emporia',
  canon: 'Canon',
  can: 'Canon',
  dji: 'DJI',
  nikon: 'Nikon',
  nikkor: 'Nikon',
  bea: 'BEA-FON',
  beafon: 'BEA-FON',
  felixx: 'Felixx',
  fel: 'Felixx',
  easypix: 'Easypix',
  withings: 'Withings',
  rol: 'Rollei',
  rollei: 'Rollei',
  san: 'SanDisk',
  sandisk: 'SanDisk',
  beurer: 'Beurer',
  gigaset: 'Gigaset',
  acer: 'Acer',
  pan: 'Panasonic',
  panasonic: 'Panasonic',
  adidas: 'Adidas',
  kod: 'Kodak',
  kodak: 'Kodak',
  om: 'OM System',
  insta360: 'Insta360',
  ins360: 'Insta360',
  polaroid: 'Polaroid',
  hama: 'Hama',
  seagate: 'Seagate',
  xplora: 'Xplora',
  fossil: 'Fossil',
  jlab: 'JLAB',
  sennheiser: 'Sennheiser',
  epson: 'Epson',
  marshall: 'Marshall',
  mar: 'Marshall',
  silva: 'Silva'
};

// Manche ArtikelBezeichnungen beginnen mit einer oesterreichischen
// Mobilfunk-Vorwahl (0660/0664/0676/...) statt der Marke, z.B.
// "0664 Sam A56" - dann zaehlt das zweite Token.
const MOBILE_PREFIX = /^0\d{3}$/;

function tokenize(artikelbezeichnung) {
  return String(artikelbezeichnung || '')
    .split(/[*\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function deriveHersteller(artikelbezeichnung, pgrBezeichnung) {
  const pgr = String(pgrBezeichnung || '');
  for (const brand of PGR_BRANDS) {
    if (pgr.includes(brand)) return brand;
  }

  const tokens = tokenize(artikelbezeichnung);
  let first = tokens[0];
  if (first && MOBILE_PREFIX.test(first)) first = tokens[1];
  if (!first) return null;

  const match = TOKEN_ABBREVIATIONS[first.toLowerCase()];
  return match || null;
}

// Erkennt Netzbetreiber-Geraete: die ArtikelBezeichnung beginnt mit einer
// oesterreichischen Mobilfunk-Vorwahl (0660/0664/0676/...) statt direkt mit
// der Marke - ein Hinweis, dass das Geraet an einen Mobilfunkvertrag
// gebunden ist. Solche Zeilen werden bewusst nicht automatisch in die
// Einspieldatei uebernommen, sondern zur manuellen Pruefung markiert.
function isNetzbetreiberGeraet(artikelbezeichnung) {
  const tokens = tokenize(artikelbezeichnung);
  return Boolean(tokens[0] && MOBILE_PREFIX.test(tokens[0]));
}

module.exports = { deriveHersteller, isNetzbetreiberGeraet, tokenize, TOKEN_ABBREVIATIONS };
