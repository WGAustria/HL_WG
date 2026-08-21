const path = require('path');
const formidable = require('formidable');
const Anthropic = require('@anthropic-ai/sdk');
const { readSourceWorkbook, loadTemplateWorkbook, applyMapping } = require('../lib/excel');
const { SYSTEM_PROMPT } = require('../lib/prompt');

const mapping = require('../templates/mapping.json');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'vorlage.xlsx');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

module.exports.config = {
  api: { bodyParser: false }
};

function parseForm(req) {
  const form = formidable({ maxFileSize: 20 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sitePassword = process.env.SITE_PASSWORD;
  if (sitePassword && req.headers['x-site-password'] !== sitePassword) {
    res.status(401).json({ error: 'Nicht autorisiert.' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY ist auf dem Server nicht konfiguriert.' });
    return;
  }

  try {
    const { files } = await parseForm(req);
    const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!uploaded) {
      res.status(400).json({ error: 'Keine Datei erhalten.' });
      return;
    }

    const fs = require('fs');
    const buffer = fs.readFileSync(uploaded.filepath);

    const sourceData = await readSourceWorkbook(buffer);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Inhalt der hochgeladenen Excel-Datei (JSON):\n${JSON.stringify(sourceData)}`
        }
      ]
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Keine Textantwort vom LLM erhalten.');

    let values;
    try {
      values = extractJson(textBlock.text);
    } catch {
      throw new Error('Antwort des LLM konnte nicht als JSON gelesen werden.');
    }

    const workbook = await loadTemplateWorkbook(TEMPLATE_PATH);
    applyMapping(workbook, mapping, values);

    const outBuffer = await workbook.xlsx.writeBuffer();
    const fileBase64 = Buffer.from(outBuffer).toString('base64');

    const preview = [
      ...mapping.fields.map(({ field }) => ({
        Feld: field,
        Wert: values && values[field] !== undefined ? values[field] : ''
      }))
    ];

    res.status(200).json({
      fileBase64,
      filename: 'ausgefuellte_vorlage.xlsx',
      preview
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Verarbeitung fehlgeschlagen.' });
  }
};
