// Loest Herstellernamen fuer ArtikelBezeichnungen auf, die lib/brandMatch.js
// nicht sicher erkennen konnte - gebuendelt ueber Claude, einmal pro
// eindeutigem Artikelnamen (nicht pro Zeile), um Kosten/Laufzeit gering zu
// halten.

const BATCH_SIZE = 80;

const SYSTEM_PROMPT = `Du bekommst eine Liste kryptisch abgekuerzter Artikelbezeichnungen aus einem
oesterreichischen Elektronik-Einzelhandel (Hartlauer). Bestimme fuer jede
Artikelbezeichnung den Hersteller (Markenname), soweit erkennbar.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, das jede Artikelbezeichnung
(exakt wie gegeben) auf den erkannten Herstellernamen abbildet. Wenn der
Hersteller nicht mit ausreichender Sicherheit bestimmbar ist, verwende den
Wert null. Keine Erklaerungen, kein Markdown.`;

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function resolveBrandsViaLlm(anthropic, model, uniqueNames) {
  const result = new Map();
  for (let i = 0; i < uniqueNames.length; i += BATCH_SIZE) {
    const batch = uniqueNames.slice(i, i + BATCH_SIZE);
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(batch) }]
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) continue;
    let parsed;
    try {
      parsed = extractJson(textBlock.text);
    } catch {
      continue;
    }
    for (const name of batch) {
      const brand = parsed[name];
      result.set(name, brand || null);
    }
  }
  return result;
}

module.exports = { resolveBrandsViaLlm };
