# HL_WG – Wertgarantie Geräteschutz Reporting

Web-Tool für die tägliche Aufbereitung des Wertgarantie-Geräteschutz-Reports
(Hartlauer): Die tägliche Report-Datei wird hochgeladen, Geräte werden
automatisch mit ihrem passenden Wertgarantie-Artikel gepaart, Hersteller und
Vermittlernummer aufgelöst, und das Ergebnis wird in die Einspieldatei-Vorlage
übernommen. Alles, was nicht eindeutig automatisch entschieden werden kann,
landet in einer Prüfliste statt geraten zu werden.

Bildet die in der Anleitung "Erhebung und Durchführung des täglichen
Wertgarantie Geräteschutz Reportings" beschriebenen Schritte 3–20
deterministisch nach (siehe Abschnitt "Fachliche Logik" unten für die
Abweichungen und offenen Punkte).

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
lib/vermittlerLookup.js     Vermittlernummer-Lookup ueber die "MA Liste" im Report (V1+V2)
templates/vorlage.xlsx      Die echte Einspieldatei-Vorlage ("Daten" + "Gerätekennzeichen")
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
- **Spalten-Mapping Report → Vorlage**: erfolgt **nach Feldbedeutung**
  (Hersteller→Hersteller, SerienNr→Seriennummer, umsatz→Kaufpreis, ...), nicht
  positionsbasiert wie ursprünglich in der Anleitung beschrieben – eine
  wörtliche Spalte-E-bis-Z-Kopie wurde an den echten Dateien getestet und
  ergab keinen Sinn (Spalten landen mehrere Positionen verschoben). Siehe
  `lib/outputBuilder.js` (`TARGET_COLS`) für die konkrete Zuordnung.
  (identisch in V1 und V2)
- **Hersteller**: zuerst Musterabgleich über eine kuratierte Markenliste
  (`lib/brandMatch.js` bzw. `lib/brandMatchV1.js`, deckt ca. 92% der
  Gerätezeilen ab), für den Rest gebündelter Claude-Aufruf pro **eindeutiger**
  Artikelbezeichnung (nicht pro Zeile) in `lib/brandLlmFallback.js`. Bleibt der
  Hersteller danach immer noch unbekannt, wird `"sonstige"` eingetragen statt
  die Zeile zurückzuhalten – die Zeile gilt dafür allein nicht mehr als
  unvollständig. (identisch in V1 und V2)
- **Vermittlernummer**: Lookup über `vknr` (Report Spalte E) gegen die
  Spalte "Mitarbeiter" im Blatt `MA Liste`, mit Namens-Fallback. Ca. 15% der
  Mitarbeiter fehlen aktuell in der MA-Liste.
- **Netzbetreiber-Geräte**: Manche ArtikelBezeichnungen beginnen mit einer
  österreichischen Mobilfunk-Vorwahl (0660/0664/0676/...) statt direkt mit der
  Marke (z.B. "0664 Sam A56") – ein Hinweis, dass das Gerät an einen
  Mobilfunkvertrag gebunden ist. Solche Zeilen gehen in **beiden Versionen**
  (`isNetzbetreiberGeraet` in `lib/brandMatch.js` bzw. `lib/brandMatchV1.js`)
  bewusst NICHT in die Einspieldatei, sondern ausschließlich in die
  Prüfdatei/Prüfliste.
- **Produkttyp**: `GERAETESCHUTZ_KOMFORT_3_2021` / `GERAETESCHUTZ_PLUS_24_2021`
  / `GERAETESCHUTZ_BASIS_5_2021`, abgeleitet aus dem WG-Artikelnamen
  ("Komfort" / "Plus" / sonst Basis). (identisch in V1 und V2)
- **Storno**: Minus-Positionen, die sich nicht mit einer Gegenposition im
  selben Bon aufheben, werden mit `Antragskodierung = "STORNO"` markiert und
  die ganze Zeile rot eingefärbt. (identisch in V1 und V2)

## V1 vs. V2 – das Filtersystem

Auf der Web-Oberfläche kann nach dem Login zwischen zwei Verarbeitungslogiken
gewählt werden:

- **V2 – Filtersystem (neu, Standard):** ein Datensatz landet **nur dann** in
  der Einspieldatei, wenn wirklich **alle** Parameter automatisch ermittelt
  werden konnten (Vermittlernummer, eindeutige Paarung) UND es sich nicht um
  ein Netzbetreiber-Gerät handelt. Fehlt auch nur eines davon, geht die
  komplette Zeile **ausschließlich** in die Prüfdatei – nie in beide. Die
  Prüfdatei ist dabei **eine einzige Arbeitsmappe im exakt selben
  Spaltenformat wie das "Daten"-Blatt** der Einspieldatei (plus angehängten
  Grund-/Bonnummer-/Hinweis-Spalten), damit eine geprüfte/ergänzte Zeile 1:1
  hineinkopiert werden kann. Keine Preisstaffel-Zuordnung bei mehreren
  Kandidaten (siehe oben). Unbekannter Hersteller blockiert nicht mehr (siehe
  "sonstige"-Fallback oben).
- **V1 – bisherige Logik:** entspricht dem Stand vor der Filtersystem-Umstellung.
  Preisstaffel-Zuordnung bei mehreren Kandidaten ist aktiv, und Zeilen mit
  fehlender Vermittlernummer werden **trotzdem** (mit Lücke) in die
  Einspieldatei übernommen – die Prüfliste dient dort nur dazu, die fehlende
  Angabe direkt in der bereits vorhandenen Zeile zu ergänzen. Netzbetreiber-Geräte
  werden wie in V2 immer ausschließlich in die Prüfliste gegeben. V1 bietet
  zusätzlich einen Download der (älteren) flachen Prüfliste als Vergleich.

Beide Modi laufen über denselben Endpunkt (`api/process.js`, Parameter
`version: "v1" | "v2"`) und dieselbe Report-Datei/Vorlage – der Unterschied
steckt ausschließlich in `lib/*V1.js` vs. `lib/*.js`.

### Bewusst offen / TODO

- **Antragskodierung** (außer bei Storno), **VMRAbrechnung**, **Intervall**:
  aktuell leer, laut Absprache für den Test zunächst nicht befüllt. Sobald
  eine Referenzdatei mit bekannten korrekten Werten vorliegt, in
  `lib/outputBuilder.js` (`buildOutput`) ergänzen.
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
