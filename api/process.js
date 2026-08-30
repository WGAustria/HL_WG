const path = require('path');
const fs = require('fs');
const { formidable } = require('formidable');
const ExcelJS = require('exceljs');
const Anthropic = require('@anthropic-ai/sdk');
const { buildOutput, writeOutputToTemplate, buildReviewWorkbook, buildReviewWorkbookV2, REVIEW_REASON_LABELS } = require('../lib/outputBuilder');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'vorlage.xlsx');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

module.exports.config = {
  api: { bodyParser: false }
};

function parseForm(req) {
  const form = formidable({ maxFileSize: 30 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function fieldValue(fields, name) {
  const v = fields[name];
  return Array.isArray(v) ? v[0] : v;
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

  try {
    const { fields, files } = await parseForm(req);
    const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!uploaded) {
      res.status(400).json({ error: 'Keine Datei erhalten.' });
      return;
    }

    const dateFromRaw = fieldValue(fields, 'dateFrom');
    const dateToRaw = fieldValue(fields, 'dateTo');
    const dateFrom = dateFromRaw ? new Date(dateFromRaw) : null;
    const dateTo = dateToRaw ? new Date(dateToRaw) : null;

    const buffer = fs.readFileSync(uploaded.filepath);
    const reportWorkbook = new ExcelJS.Workbook();
    await reportWorkbook.xlsx.load(buffer);

    const anthropic = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;

    const { outputRows, review, stats } = await buildOutput(reportWorkbook, {
      anthropic,
      model: MODEL,
      dateFrom,
      dateTo
    });

    const templateWorkbook = new ExcelJS.Workbook();
    await templateWorkbook.xlsx.readFile(TEMPLATE_PATH);
    writeOutputToTemplate(templateWorkbook, outputRows);

    const outBuffer = await templateWorkbook.xlsx.writeBuffer();
    const fileBase64 = Buffer.from(outBuffer).toString('base64');

    const reviewWorkbook = buildReviewWorkbook(review);
    const reviewBuffer = await reviewWorkbook.xlsx.writeBuffer();
    const reviewBase64 = Buffer.from(reviewBuffer).toString('base64');

    const reviewWorkbookV2 = buildReviewWorkbookV2(review);
    const reviewBufferV2 = await reviewWorkbookV2.xlsx.writeBuffer();
    const reviewV2Base64 = Buffer.from(reviewBufferV2).toString('base64');

    const reviewSummary = {};
    for (const entry of review) {
      const label = REVIEW_REASON_LABELS[entry.reason] || entry.reason;
      reviewSummary[label] = (reviewSummary[label] || 0) + entry.rows.length;
    }

    const preview = outputRows.slice(0, 50).map((r) => ({
      Bonnummer: r.bonnummer,
      Hersteller: r.hersteller,
      Modell: r.modellbezeichnung,
      Seriennummer: r.seriennummer,
      Kaufpreis: r.kaufpreis,
      Produkttyp: r.produkttyp,
      Storno: r.isStorno ? 'ja' : ''
    }));

    const dateStamp = new Date().toISOString().slice(0, 10);
    res.status(200).json({
      fileBase64,
      filename: `Einspieldatei_${dateStamp}.xlsx`,
      reviewBase64,
      reviewFilename: `Pruefliste_v1_${dateStamp}.xlsx`,
      reviewV2Base64,
      reviewV2Filename: `Pruefliste_v2_${dateStamp}.xlsx`,
      preview,
      stats,
      reviewSummary
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Verarbeitung fehlgeschlagen.' });
  }
};
