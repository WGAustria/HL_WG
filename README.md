# HL_WG – Excel-Datenübernahme per LLM

Einfache Ein-Seiten-Web-App: Nutzer lädt eine Excel-Datei hoch, ein LLM
(Anthropic Claude) extrahiert die relevanten Daten daraus und trägt sie in
eine hinterlegte Excel-Vorlage ein. Ergebnis wird als Vorschau angezeigt und
zum Download angeboten.

## Aufbau

```
index.html              Ein-Seiten-Frontend (Upload, Passwort-Gate, Vorschau/Download)
api/login.js            Prüft das gemeinsame Passwort (Vercel Serverless Function)
api/process.js          Nimmt die Datei entgegen, ruft das LLM auf, befüllt die Vorlage
lib/excel.js            Excel lesen (Quelldatei) / Vorlage befüllen (ExcelJS)
lib/prompt.js           System-Prompt für das LLM  ⚠️ TODO – siehe unten
templates/vorlage.xlsx  Die Ziel-Vorlage             ⚠️ TODO – Platzhalter, ersetzen
templates/mapping.json  Zuordnung LLM-Feld -> Zelle in der Vorlage  ⚠️ TODO – anpassen
scripts/generate-placeholder-template.js  Erzeugt die aktuelle Platzhalter-Vorlage
```

Es handelt sich um ein "Other"/zero-config Vercel-Projekt (keine Framework
wie Next.js nötig): statische Dateien im Projekt-Root, Serverless Functions
im Ordner `api/`.

## Offene TODOs, bevor das Tool produktiv nutzbar ist

1. **Echte Excel-Vorlage**: `templates/vorlage.xlsx` durch die echte Vorlage
   ersetzen.
2. **Mapping**: `templates/mapping.json` an die echte Vorlage anpassen –
   für jedes Feld, das das LLM liefern soll, Blattname (`sheet`) und
   Zielzelle (`cell`) eintragen.
3. **LLM-Instruktionen**: `lib/prompt.js` (`SYSTEM_PROMPT`) durch die
   finalen Anweisungen ersetzen, sobald diese vorliegen. Die vom LLM
   zurückgegebenen JSON-Schlüssel müssen zu den `field`-Namen in
   `mapping.json` passen.

Bis dahin läuft die App bereits End-to-End mit einer Platzhalter-Vorlage
und einem Platzhalter-Prompt (`npm run generate-placeholder-template`
erzeugt die aktuelle Platzhalter-Vorlage neu, falls `mapping.json` geändert
wird).

## Umgebungsvariablen (im Vercel-Projekt konfigurieren)

| Variable            | Pflicht | Beschreibung                                              |
|----------------------|---------|-------------------------------------------------------------|
| `ANTHROPIC_API_KEY`  | ja      | API-Key für die Anthropic Claude API                        |
| `SITE_PASSWORD`      | ja      | Gemeinsames Passwort für den Zugriffsschutz                 |
| `ANTHROPIC_MODEL`    | nein    | Überschreibt das Standardmodell (`claude-sonnet-5`)          |

Diese Variablen müssen im Vercel-Projekt unter *Settings → Environment
Variables* gesetzt werden (Production und ggf. Preview).

## Passwortschutz

Die Startseite zeigt zunächst eine Passwortabfrage. Nach erfolgreicher
Prüfung gegen `SITE_PASSWORD` (`api/login.js`) wird die Upload-Oberfläche
freigeschaltet; das Passwort wird für die Dauer der Browser-Session
gespeichert und bei jeder Verarbeitung erneut serverseitig geprüft
(`api/process.js`). Das ist ein einfacher, für ein internes Tool
ausreichender Schutz – kein Ersatz für echtes Nutzer-Login mit
individuellen Konten.

## Lokale Entwicklung

```bash
npm install
npm run generate-placeholder-template   # nur nötig, wenn templates/vorlage.xlsx fehlt
vercel dev
```

(`vercel dev` benötigt die Vercel CLI: `npm i -g vercel`.)

## Deployment

Das Vercel-Projekt für dieses Repo existiert laut Rückmeldung bereits unter
einem separaten Vercel-Account. Bitte dort:

1. Dieses GitHub-Repo (`WGAustria/HL_WG`, Branch wie gewünscht) als
   Deployment-Quelle verbinden, falls noch nicht geschehen.
2. Die Umgebungsvariablen oben setzen.
3. `templates/vorlage.xlsx` und `templates/mapping.json` durch die echten
   Werte ersetzen (siehe TODOs oben), sobald verfügbar.
