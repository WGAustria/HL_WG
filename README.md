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
api/process.js              Nimmt die Report-Datei entgegen, orchestriert die Verarbeitung
lib/reportPipeline.js       Filtern (Geraet/WG-Artikel/Sonstiges), Bonnummer-Gruppierung, Paarung, Storno-Netting
lib/brandMatch.js           Hersteller-Ableitung per Markenliste (schnell, kein API-Call)
lib/brandLlmFallback.js     Hersteller-Ableitung per Claude fuer unbekannte Artikelbezeichnungen (gebuendelt)
lib/vermittlerLookup.js     Vermittlernummer-Lookup ueber die "MA Liste" im Report
lib/outputBuilder.js        Baut die Ausgabezeilen und schreibt sie in die Vorlage + Pruefliste
templates/vorlage.xlsx      Die echte Einspieldatei-Vorlage ("Daten" + "Gerätekennzeichen")
```

Zero-config Vercel-Projekt ("Other"): statische Dateien im Projekt-Root,
Serverless Functions im Ordner `api/`. `vercel.json` setzt `maxDuration: 60`
für `api/process.js`, da die Report-Datei ca. 50.000+ Zeilen hat und die
Verarbeitung (Laden, Paaren, Schreiben) mehrere Sekunden dauert.

## Fachliche Logik – wichtige Entscheidungen

- **Klassifizierung Gerät/WG-Artikel**: nutzt die im Report bereits vorhandene
  GKZ-VLOOKUP-Formel (Spalte U): numerischer Treffer = Gerät,
  `PGR_Bezeichnung == "Wertgarantie"` = WG-Artikel. Alles andere
  (Zubehör, Dienstleistungen, Gutscheine, ...) fällt raus. `"Wertgarantie GS"`
  hat keinen Treffer in `PG Matching` und wird separat zur Prüfung markiert.
- **Paarung**: eindeutige 1:1-Fälle pro Bonnummer werden automatisch gepaart;
  bei mehreren Kandidaten wird die im WG-Artikelnamen enthaltene
  Preisobergrenze genutzt (z.B. "WG UE Garantie 5J bis 300 €" → passendes
  Gerät bis 300 €). Bleibt es mehrdeutig, geht die ganze Bon-Gruppe in die
  Prüfliste statt geraten zu werden.
- **Spalten-Mapping Report → Vorlage**: erfolgt **nach Feldbedeutung**
  (Hersteller→Hersteller, SerienNr→Seriennummer, umsatz→Kaufpreis, ...), nicht
  positionsbasiert wie ursprünglich in der Anleitung beschrieben – eine
  wörtliche Spalte-E-bis-Z-Kopie wurde an den echten Dateien getestet und
  ergab keinen Sinn (Spalten landen mehrere Positionen verschoben). Siehe
  `lib/outputBuilder.js` (`TARGET_COLS`) für die konkrete Zuordnung.
- **Hersteller**: zuerst Musterabgleich über eine kuratierte Markenliste
  (`lib/brandMatch.js`, deckt ca. 92% der Gerätezeilen ab), für den Rest
  gebündelter Claude-Aufruf pro **eindeutiger** Artikelbezeichnung (nicht pro
  Zeile) in `lib/brandLlmFallback.js`.
- **Vermittlernummer**: Lookup über `vknr` (Report Spalte E) gegen die
  Spalte "Mitarbeiter" im Blatt `MA Liste`, mit Namens-Fallback. Ca. 15% der
  Mitarbeiter fehlen aktuell in der MA-Liste – diese Zeilen landen in der
  Prüfliste.
- **Produkttyp**: `GERAETESCHUTZ_KOMFORT_3_2021` / `GERAETESCHUTZ_PLUS_24_2021`
  / `GERAETESCHUTZ_BASIS_5_2021`, abgeleitet aus dem WG-Artikelnamen
  ("Komfort" / "Plus" / sonst Basis).
- **Storno**: Minus-Positionen, die sich nicht mit einer Gegenposition im
  selben Bon aufheben, werden mit `Antragskodierung = "STORNO"` markiert und
  die ganze Zeile rot eingefärbt.

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

## Prüfliste

Jede erzeugte Einspieldatei enthält zusätzlich zum Blatt "Daten" ein Blatt
**"Pruefliste"** mit allen Zeilen, die nicht automatisch verarbeitet werden
konnten (Grund, Bonnummer, Artikel, Beträge, ...). Die Web-Oberfläche zeigt
zusätzlich eine Zusammenfassung nach Grund an.

## Umgebungsvariablen (im Vercel-Projekt konfigurieren)

| Variable            | Pflicht | Beschreibung                                        |
|----------------------|---------|------------------------------------------------------|
| `ANTHROPIC_API_KEY`  | ja      | API-Key für die Anthropic Claude API (Hersteller-Fallback) |
| `SITE_PASSWORD`      | ja      | Gemeinsames Passwort für den Zugriffsschutz           |
| `ANTHROPIC_MODEL`    | nein    | Überschreibt das Standardmodell (`claude-sonnet-5`)   |

Diese Variablen müssen im Vercel-Projekt unter *Settings → Environment
Variables* gesetzt werden (Production und ggf. Preview).

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
