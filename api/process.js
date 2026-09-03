const path = require('path');
const ExcelJS = require('exceljs');
const Anthropic = require('@anthropic-ai/sdk');
const { del } = require('@vercel/blob');
const pipelineV2 = require('../lib/outputBuilder');
const pipelineV1 = require('../lib/outputBuilderV1');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'vorlage.xlsx');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) {
    res.status(500).json({ error: 'SITE_PASSWORD ist auf dem Server nicht konfiguriert.' });
    return;
  }
  if (req.headers['x-site-password'] !== sitePassword) {
    res.status(401).json({ error: 'Nicht autorisiert.' });
    return;
  }

  const { blobUrl, dateFrom: dateFromRaw, dateTo: dateToRaw, version: versionRaw } = req.body || {};
  if (!blobUrl || typeof blobUrl !== 'string') {
    res.status(400).json({ error: 'Keine Datei erhalten (blobUrl fehlt).' });
    return;
  }

  const version = versionRaw === 'v1' ? 'v1' : 'v2';
  const { buildOutput, writeOutputToTemplate, buildReviewWorkbook, buildReviewWorkbookV2, REVIEW_REASON_LABELS } =
    version === 'v1' ? pipelineV1 : pipelineV2;

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  try {
    const dateFrom = dateFromRaw ? new Date(dateFromRaw) : null;
    const dateTo = dateToRaw ? new Date(dateToRaw) : null;

    const blobResp = await fetch(blobUrl, blobToken ? { headers: { Authorization: `Bearer ${blobToken}` } } : undefined);
    if (!blobResp.ok) {
      throw new Error(`Datei konnte nicht geladen werden (Blob-Status ${blobResp.status}).`);
    }
    const buffer = Buffer.from(await blobResp.arrayBuffer());

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

    // Im V1-Pipeline-Modus (alte Logik) gibt es zwei Pruefliste-Formate: die
    // tabellierte Version (buildReviewWorkbookV2, im Daten-Spaltenformat) ist
    // die primaere Datei, die flache Liste (buildReviewWorkbook) steht als
    // zusaetzlicher Legacy-Download zum Vergleich bereit. Im V2-Pipeline-Modus
    // (neues Filtersystem) gibt es nur die eine, vereinheitlichte Pruefdatei.
    const primaryReviewBuilder = version === 'v1' && typeof buildReviewWorkbookV2 === 'function'
      ? buildReviewWorkbookV2
      : buildReviewWorkbook;
    const reviewWorkbook = primaryReviewBuilder(review);
    const reviewBuffer = await reviewWorkbook.xlsx.writeBuffer();
    const reviewBase64 = Buffer.from(reviewBuffer).toString('base64');

    let reviewLegacyFlatBase64 = null;
    if (version === 'v1' && typeof buildReviewWorkbookV2 === 'function') {
      const legacyWorkbook = buildReviewWorkbook(review);
      const legacyBuffer = await legacyWorkbook.xlsx.writeBuffer();
      reviewLegacyFlatBase64 = Buffer.from(legacyBuffer).toString('base64');
    }

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
      Produkttyp: r.produkttyp.replace(/^GERAETESCHUTZ_/, '').replace(/_2021$/, ''),
      Storno: r.isStorno ? 'ja' : ''
    }));

    const dateStamp = new Date().toISOString().slice(0, 10);
    res.status(200).json({
      version,
      fileBase64,
      filename: `Einspieldatei_${dateStamp}.xlsx`,
      reviewBase64,
      reviewFilename: version === 'v1' ? `Pruefliste_${dateStamp}.xlsx` : `Pruefdatei_${dateStamp}.xlsx`,
      reviewLegacyFlatBase64,
      reviewLegacyFlatFilename: reviewLegacyFlatBase64 ? `Pruefliste_flach_${dateStamp}.xlsx` : null,
      preview,
      stats,
      reviewSummary
    });

    if (blobToken) {
      del(blobUrl, { token: blobToken }).catch((err) => console.error('Blob-Loeschung fehlgeschlagen:', err));
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Verarbeitung fehlgeschlagen.' });
  }
};
