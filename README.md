# HL_WG – Wertgarantie Geräteschutz Reporting

Web-Tool für die tägliche Aufbereitung des Wertgarantie-Geräteschutz-Reports
(Hartlauer): Die tägliche Report-Datei wird hochgeladen, Geräte werden
automatisch mit ihrem passenden Wertgarantie-Artikel gepaart, Hersteller, AKP
(Vermittlernummer) und FH Nummer (Filialkennung) aufgelöst, und das Ergebnis
wird in "GS Basis" bzw. "GS Komfort u. Plus" der Einspieldatei-Vorlage
übernommen. Alles, was nicht eindeutig automatisch entschieden werden kann,
landet in einer Prüfdatei statt geraten zu werden.

Bildet die in der Anleitung "Erhebung und Durchführung des täglichen
Wertgarantie Geräteschutz Reportings" beschriebenen Schritte 3–20
deterministisch nach (siehe Abschnitt "Fachliche Logik" unten für die
Abweichungen und offenen Punkte).

**Wichtig zur Einspieldatei-Vorlage:** `templates/vorlage.xlsx` ist eine
bereinigte Kopie der echten Wertgarantie-Datei "Einspieldatei_HL_neu.xlsx"
(bezogen von Hartlauer). Enthalten sind nur die sechs tatsächlich benötigten
Blätter - "GS Basis" und "GS Komfort u. Plus" (Zielblätter, auf Kopf-/
Vorgabezeile zurückgesetzt, ohne die mehrjährige Historie der Originaldatei)
sowie die Referenztabellen "MA Liste", "Geschäfte Liste",
"Geraetekennzeichen Wertgarantie" und "Partnerliste AKP" (siehe unten). Die
49 monatlichen "Report DD.MM.YYYY"-Archivblätter, "GS NEU" und "Auswertung
aktuell" aus der Originaldatei werden bewusst NICHT verwendet (nicht
gebraucht, hätten die Vorlage stark aufgebläht). Das Tool akkumuliert selbst
keine Historie - jeder Lauf erzeugt eine frische Einspieldatei ab der ersten
leeren Zeile dieser bereinigten Vorlage.

**"Partnerliste AKP"** wurde nachträglich ergänzt (Quelle: eine von Hartlauer
gelieferte AKP/FH-Liste, ursprünglich als eigene xlsx-Datei). Diese
Originaldatei hat einen Case-Sensitivity-Bug (Excel-intern referenziert
`Sheet1.xml` seine Beziehungsdatei als `sheet1.xml.rels` - unter Windows/macOS
unsichtbar, auf dem case-sensitiven Vercel-Dateisystem bricht ExcelJS daran
aber ab und liest 0 Arbeitsblätter). Die Datei wurde deshalb einmalig lokal
mit einer anderen Bibliothek gelesen, auf die zwei benötigten Spalten (AKP,
FH Nummer) reduziert und sauber in die Vorlage geschrieben - nicht die
gelieferte Originaldatei direkt einbinden, falls sie erneut aktualisiert
wird (gleiches Vorgehen wiederholen, siehe `lib/akpFallbackLookup.js`).

## Aufbau

```
index.html                Ein-Seiten-Frontend (Upload, Passwort-Gate, Datumsfilter, Vorschau/Download)
api/login.js               Prüft das gemeinsame Passwort
api/blob-upload.js          Stellt Client-Tokens für den direkten Browser-Upload zu Vercel Blob aus
api/process.js              Lädt die Report-Datei von Vercel Blob, orchestriert die Verarbeitung
build/blob-client-entry.js  Build-Entry für den Blob-Upload-Browser-Bundle (siehe unten)
blob-client.bundle.js       Fertig gebauter Browser-Bundle (im Repo abgelegt, kein Build-Step nötig)
lib/reportPipeline.js       V2 (neu): Filtern, Bonnummer-Gruppierung, Paarung, Storno-Netting
lib/brandMatch.js           V2 (neu): Hersteller-Ableitung + Netzbetreiber-Geraet-Erkennung
lib/outputBuilder.js        V2 (neu): Ausgabezeilen bauen, Filtersystem, EINE Pruefdatei
lib/reportPipelineV1.js     V1 (bisherige Logik): wie reportPipeline.js, inkl. Preisstaffel-Zuordnung
lib/brandMatchV1.js         V1 (bisherige Logik): wie brandMatch.js, ohne Netzbetreiber-Erkennung
lib/outputBuilderV1.js      V1 (bisherige Logik): wie outputBuilder.js, ohne Filtersystem
lib/brandLlmFallback.js     Hersteller-Ableitung per Claude fuer unbekannte Artikelbezeichnungen (gebuendelt, V1+V2)
lib/vermittlerLookup.js     AKP-Lookup ueber die "MA Liste" im Report (V1+V2)
lib/geschaefteLookup.js     FH-Nummer/Geschaeftsadresse-Lookup ueber "Geschäfte Liste" in der Vorlage (V1+V2)
lib/kategorieLookup.js      Kategorie-Lookup (Geraetekennzeichen -> Beschreibung) ueber "Geraetekennzeichen Wertgarantie" in der Vorlage (V1+V2)
lib/akpFallbackLookup.js    AKP-Fallback (erste AKP je FH Nummer) ueber "Partnerliste AKP" in der Vorlage (V1+V2)
templates/vorlage.xlsx      Bereinigte echte Einspieldatei-Vorlage (siehe Kasten oben)
```

Die Web-Oberfläche hat nach dem Login einen Umschalter zwischen **V1**
(bisherige Logik) und **V2** (neues Filtersystem) – siehe Abschnitt "V1 vs.
V2" unten. Beide Varianten laufen parallel im selben Deployment, damit sie
vor einer endgültigen Entscheidung direkt verglichen werden können.

Zero-config Vercel-Projekt ("Other"): statische Dateien im Projekt-Root,
Serverless Functions im Ordner `api/`. `vercel.json` setzt `maxDuration: 60`
für `api/process.js`, da die Report-Datei ca. 50.000+ Zeilen hat und die
Verarbeitung (Laden, Paaren, Schreiben) mehrere Sekunden dauert.

### Datei-Upload über Vercel Blob (wichtig)

Vercel Serverless Functions lehnen Requests über 4,5 MB grundsätzlich ab
(`FUNCTION_PAYLOAD_TOO_LARGE`) – das ist ein fixes Infrastruktur-Limit, das
sich nicht per Konfiguration umgehen lässt. Die echte Report-Datei ist aber
üblicherweise > 10 MB. Deshalb läuft der Upload zweistufig:

1. Der Browser lädt die Datei **direkt** zu Vercel Blob hoch (nicht über eine
   Serverless Function), authentifiziert über ein kurzlebiges Client-Token,
   das `api/blob-upload.js` ausstellt (`handleUpload`-Route). Das übernimmt
   `blob-client.bundle.js` (eingebunden in `index.html`), ein mit esbuild
   vorgebauter Browser-Bundle von `@vercel/blob/client`'s `upload()`-Funktion
   – ein raw `<script type="module">`-Import würde nicht funktionieren, da
   `@vercel/blob/client` Node-only Imports (`crypto`, `undici`) enthält, die
   nur über einen Bundler mit `platform: browser` sauber aufgelöst werden.
2. Der Browser schickt anschließend nur noch die (kleine) Blob-URL plus
   Datumsfilter als JSON an `/api/process`. Die Funktion lädt die Datei von
   dort per `fetch`, verarbeitet sie wie bisher und löscht den Blob danach
   wieder.

**Voraussetzung im Vercel-Projekt:** Unter *Storage* muss ein **Blob Store**
angelegt und mit dem Projekt verbunden sein (einmalig, im Vercel-Dashboard,
"Connect Store" bzw. "Create Database → Blob"). Das setzt automatisch die
Umgebungsvariable `BLOB_READ_WRITE_TOKEN` – ohne diese Variable schlägt der
Upload fehl. Diesen Schritt muss der Projekt-Owner selbst im eigenen
Vercel-Account durchführen.

Falls `build/blob-client-entry.js` geändert wird, muss der Bundle neu gebaut
werden: `npm run build:blob-client` (erzeugt `blob-client.bundle.js` neu,
kein Build-Step auf Vercel selbst nötig – die Datei wird fertig gebaut
eingecheckt).

## Fachliche Logik – wichtige Entscheidungen

- **Klassifizierung Gerät/WG-Artikel**: nutzt die im Report bereits vorhandene
  GKZ-VLOOKUP-Formel (Spalte U): numerischer Treffer = Gerät,
  `PGR_Bezeichnung == "Wertgarantie"` = WG-Artikel. Alles andere
  (Zubehör, Dienstleistungen, Gutscheine, ...) fällt raus. `"Wertgarantie GS"`
  hat keinen Treffer in `PG Matching` und wird separat zur Prüfung markiert.
  (identisch in V1 und V2)
- **Paarung**: eindeutige 1:1-Fälle pro Bonnummer werden automatisch gepaart.
  Bei mehreren Kandidaten im selben Bon nutzt **V1** die im WG-Artikelnamen
  enthaltene Preisobergrenze (z.B. "WG UE Garantie 5J bis 300 €" → passendes
  Gerät bis 300 €), um trotzdem automatisch zu paaren. **V2** verzichtet
  bewusst auf diese Preisstaffel-Zuordnung – bei mehreren Kandidaten geht die
  ganze Bon-Gruppe immer in die Prüfdatei statt (auch nur teilweise)
  automatisch geraten zu werden.
- **Keine Kundendaten in "GS Basis"/"GS Komfort u. Plus"**: die echten
  historischen Zeilen dieser Blätter enthalten laut Vorlage nie Anrede/Email
  und nutzen die Kundenadresse nicht - stattdessen: Filialnummer (Spalte 7),
  die Konstante `"Bonnummer"` (Spalte 8), die echte Kassenbonnummer
  (Spalte 9), die Konstante `"Hartlauer"` (Spalte 10) und die
  **Geschäftsadresse** (Spalten 11-15, aus `lib/geschaefteLookup.js`). Das
  Tool folgt dieser echten Praxis, nicht der (irreführenden) Kopfzeile.
  (identisch in V1 und V2)
- **Spalten-Mapping Report → Vorlage**: erfolgt **nach Feldbedeutung**, nicht
  positionsbasiert wie ursprünglich in der Anleitung beschrieben – eine
  wörtliche Spalte-E-bis-Z-Kopie wurde an den echten Dateien getestet und
  ergab keinen Sinn. Siehe `lib/outputBuilder.js` (`TARGET_COLS`) für die
  konkrete Zuordnung. (identisch in V1 und V2)
- **Hersteller**: zuerst Musterabgleich über eine kuratierte Markenliste
  (`lib/brandMatch.js` bzw. `lib/brandMatchV1.js`, deckt ca. 92% der
  Gerätezeilen ab), für den Rest gebündelter Claude-Aufruf pro **eindeutiger**
  Artikelbezeichnung (nicht pro Zeile) in `lib/brandLlmFallback.js`. Bleibt der
  Hersteller danach immer noch unbekannt, wird `"sonstige"` eingetragen statt
  die Zeile zurückzuhalten – die Zeile gilt dafür allein nicht mehr als
  unvollständig. (identisch in V1 und V2)
- **AKP** (Vermittlernummer): primär Lookup über `vknr`/Personalnummer
  (Report Spalte E) gegen die Spalte "Mitarbeiter" im Blatt `MA Liste`, mit
  Namens-Fallback (`lib/vermittlerLookup.js`). Findet sich dort kein Treffer,
  wird ersatzweise die **erste** AKP-Nummer aus dem Blatt `Partnerliste AKP`
  der Vorlage genommen, die zur (über die Filialnummer aufgelösten) FH
  Nummer der Filiale passt (`lib/akpFallbackLookup.js`) - so vom Kunden
  vorgegeben. Nur wenn auch dieser Fallback keinen Treffer liefert, gilt die
  AKP als fehlend.
- **FH Nummer + Geschäftsadresse**: Lookup über die Filialnummer (Report
  Spalte G) gegen "GNR" im Blatt `Geschäfte Liste` der Vorlage
  (`lib/geschaefteLookup.js`), liefert FH Nummer ("WG GNr"), PLZ, Ort und
  Strasse/Hausnummer (per Regex aus der kombinierten Adresse getrennt).
- **Kategorie**: Lookup über das Gerätekennzeichen (GKZ, bereits aus dem
  Report bekannt) gegen das Blatt `Geraetekennzeichen Wertgarantie` der
  Vorlage (`lib/kategorieLookup.js`), z.B. `"Tablet-Computer"`,
  `"Smartwatch"`. Kein Treffer → leer (kein Blocker, kein "sonstige"-Fallback).
- **Netzbetreiber-Geräte**: Manche ArtikelBezeichnungen beginnen mit einer
  österreichischen Mobilfunk-Vorwahl (0660/0664/0676/...) statt direkt mit der
  Marke (z.B. "0664 Sam A56") – ein Hinweis, dass das Gerät an einen
  Mobilfunkvertrag gebunden ist. Solche Zeilen gehen in **beiden Versionen**
  (`isNetzbetreiberGeraet` in `lib/brandMatch.js` bzw. `lib/brandMatchV1.js`)
  bewusst NICHT in die Einspieldatei, sondern ausschließlich in die
  Prüfdatei/Prüfliste.
- **Zielblatt + Produkttyp/Policentyp**: Komfort/Plus-WG-Artikel gehen ins
  Blatt "GS Komfort u. Plus" (Produkttyp `"Geräteschutz Komfort"` bzw.
  `"Geräteschutz Plus"`, Policentyp `"GERAETESCHUTZ"`), alles andere ins
  Blatt "GS Basis" (Produkttyp `"Geräteschutz Basis"`, Policentyp
  `"GARANTIEVERLAENGERUNG"`) - siehe `wgProduktInfo()` in
  `lib/outputBuilder.js`. (identisch in V1 und V2)
- **Storno**: Minus-Positionen, die sich nicht mit einer Gegenposition im
  selben Bon aufheben, werden per rot eingefärbter Zeile markiert (die neue
  Vorlage hat kein `Antragskodierung`-Feld mehr für einen Storno-Code).
  (identisch in V1 und V2)

## V1 vs. V2 – das Filtersystem

Auf der Web-Oberfläche kann nach dem Login zwischen zwei Verarbeitungslogiken
gewählt werden:

- **V2 – Filtersystem (neu, Standard):** ein Datensatz landet **nur dann** in
  der Einspieldatei, wenn wirklich **alle** Parameter automatisch ermittelt
  werden konnten (AKP, FH Nummer/Geschäftsadresse, eindeutige Paarung) UND es
  sich nicht um ein Netzbetreiber-Gerät handelt. Fehlt auch nur eines davon,
  geht die komplette Zeile **ausschließlich** in die Prüfdatei – nie in
  beide. Die Prüfdatei ist dabei **eine einzige Arbeitsmappe im exakt selben
  Spaltenformat wie "GS Basis"/"GS Komfort u. Plus"** (plus angehängten
  Grund-/Bonnummer-/Hinweis-Spalten), damit eine geprüfte/ergänzte Zeile 1:1
  hineinkopiert werden kann. Keine Preisstaffel-Zuordnung bei mehreren
  Kandidaten (siehe oben). Unbekannter Hersteller blockiert nicht mehr (siehe
  "sonstige"-Fallback oben).
- **V1 – bisherige Logik:** entspricht dem Stand vor der Filtersystem-Umstellung.
  Preisstaffel-Zuordnung bei mehreren Kandidaten ist aktiv, und Zeilen mit
  fehlender AKP oder FH Nummer werden **trotzdem** (mit Lücke) in die
  Einspieldatei übernommen – die Prüfliste dient dort nur dazu, die fehlende
  Angabe direkt in der bereits vorhandenen Zeile zu ergänzen. Netzbetreiber-Geräte
  werden wie in V2 immer ausschließlich in die Prüfliste gegeben. V1 bietet
  zusätzlich einen Download der (älteren) flachen Prüfliste als Vergleich.

Beide Modi laufen über denselben Endpunkt (`api/process.js`, Parameter
`version: "v1" | "v2"`) und dieselbe Report-Datei/Vorlage – der Unterschied
steckt ausschließlich in `lib/*V1.js` vs. `lib/*.js`.

### Bewusst offen / TODO

- **"Gebraucht Nachtrag"** (WG-Artikel ohne Gerät): braucht laut Anleitung
  eine Suche in Salesforce/AX, auf die dieses Tool keinen Zugriff hat – diese
  Zeilen werden nur in der Prüfliste ausgewiesen, nicht automatisch verarbeitet.
- **Preiskorrektur bei Plus-Artikeln** (Anleitung Schritt 14): wird aktuell
  nicht automatisch korrigiert (keine Referenz-Listenpreise verfügbar).
- **Monatlicher Export** ("GS Basis Komfort Plus Report"): bewusst noch nicht
  Teil dieses Tools, kommt als eigener Schritt.
- Die Report-Datei muss vor dem Upload in Excel aktualisiert sein
  ("Daten aktualisieren", Schritt 2 der Anleitung) – das Tool selbst hat
  keinen Zugriff auf die zugrundeliegende Datenquelle.

## Prüfdatei / Prüfliste

Die Prüfdatei (V2) bzw. Prüfliste (V1) ist eine **eigenständige** Datei, kein
Tab in der Einspieldatei – siehe Abschnitt "V1 vs. V2" oben für den genauen
Unterschied. Die Web-Oberfläche zeigt zusätzlich eine Zusammenfassung nach
Grund an.

## Ergebnisdateien über Vercel Blob (wichtig)

Ein voller Tagesreport erzeugt eine Einspieldatei + Prüfdatei von zusammen
oft mehreren MB - als Base64 im JSON-Response der Funktion würde das erneut
das 4,5-MB-Limit von Vercel Serverless Functions reißen (siehe
"Datei-Upload über Vercel Blob" oben, nur diesmal auf dem Rückweg). Deshalb
lädt `api/process.js` die fertigen Dateien selbst zu Vercel Blob hoch
(`access: "public"` mit zufälligem Pfad-Suffix, also nicht auffindbar ohne
den Link) und gibt nur die (kleinen) `downloadUrl`-Links im JSON-Response
zurück; der Browser lädt die Datei direkt von dort herunter, nicht über
diese Funktion. Die hochgeladenen Ergebnisdateien werden aktuell nicht
automatisch wieder gelöscht (nur die hochgeladene Report-Datei wird nach der
Verarbeitung entfernt) - bei Bedarf könnte dafür später ein Cron-Job
ergänzt werden.

## Umgebungsvariablen (im Vercel-Projekt konfigurieren)

| Variable            | Pflicht | Beschreibung                                        |
|----------------------|---------|------------------------------------------------------|
| `ANTHROPIC_API_KEY`  | ja      | API-Key für die Anthropic Claude API (Hersteller-Fallback) |
| `SITE_PASSWORD`      | ja      | Gemeinsames Passwort für den Zugriffsschutz           |
| `BLOB_READ_WRITE_TOKEN` | ja   | Wird automatisch gesetzt, sobald im Vercel-Projekt unter *Storage* ein Blob Store verbunden ist – siehe Abschnitt "Datei-Upload über Vercel Blob" oben |
| `ANTHROPIC_MODEL`    | nein    | Überschreibt das Standardmodell (`claude-sonnet-5`)   |

`ANTHROPIC_API_KEY` und `SITE_PASSWORD` müssen im Vercel-Projekt unter
*Settings → Environment Variables* manuell gesetzt werden (Production und
ggf. Preview). `BLOB_READ_WRITE_TOKEN` wird **nicht** manuell gesetzt,
sondern automatisch angelegt, sobald ein Blob Store mit dem Projekt
verbunden wird.

## Passwortschutz

Die Startseite zeigt zunächst eine Passwortabfrage. Nach erfolgreicher
Prüfung gegen `SITE_PASSWORD` (`api/login.js`) wird die Upload-Oberfläche
freigeschaltet; das Passwort wird für die Dauer der Browser-Session
gespeichert und bei jeder Verarbeitung erneut serverseitig geprüft
(`api/process.js`).

## Lokale Entwicklung

```bash
npm install
vercel dev
```

(`vercel dev` benötigt die Vercel CLI: `npm i -g vercel`.)

## Deployment

Das Vercel-Projekt für dieses Repo existiert laut Rückmeldung bereits unter
einem separaten Vercel-Account. Bitte dort:

1. Dieses GitHub-Repo (`WGAustria/HL_WG`, gewünschter Branch) als
   Deployment-Quelle verbinden, falls noch nicht geschehen.
2. Die Umgebungsvariablen oben setzen.
3. Prüfen, ob der Vercel-Plan Function-Laufzeiten von 60s erlaubt
   (`vercel.json`) – bei sehr großen Report-Dateien ggf. anpassen.
