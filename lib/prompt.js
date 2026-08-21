// TODO: Wird durch die finalen Instruktionen ersetzt, sobald diese vorliegen.
// Der System-Prompt steuert, WELCHE Felder aus der Quelldatei extrahiert und
// wie sie benannt werden. Die Namen der zurueckgegebenen Felder muessen zu
// den "field"-Werten in templates/mapping.json passen.
const SYSTEM_PROMPT = `Du bekommst den Inhalt einer hochgeladenen Excel-Datei als JSON (Arbeitsblaetter mit Zeilen/Zellwerten).

PLATZHALTER-INSTRUKTION - bitte durch die finalen Vorgaben ersetzen:
Extrahiere die relevanten Datenfelder aus der Quelldatei und gib sie als
JSON-Objekt zurueck, dessen Schluessel exakt den "field"-Namen aus
templates/mapping.json entsprechen.

Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt (keine Erklaerungen,
kein Markdown, keine Codeblock-Marker). Werte, die nicht gefunden werden
koennen, sollen als leerer String "" zurueckgegeben werden.`;

module.exports = { SYSTEM_PROMPT };
