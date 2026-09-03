const path = require('path');
const ExcelJS = require('exceljs');
const Anthropic = require('@anthropic-ai/sdk');
const { del, put } = require('@vercel/blob');
const pipelineV2 = require('../lib/outputBuilder');
const pipelineV1 = require('../lib/outputBuilderV1');
const { buildGeschaefteLookup } = require('../lib/geschaefteLookup');
const { buildKategorieLookup } = require('../lib/kategorieLookup');

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
  if (!blobToken) {
    res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN ist auf dem Server nicht konfiguriert (Blob Store im Vercel-Projekt verbinden).' });
    return;
  }

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

    const templateWorkbook = new ExcelJS.Workbook();
    await templateWorkbook.xlsx.readFile(TEMPLATE_PATH);

    const anthropic = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;

    const { outputRows, review, stats } = await buildOutput(reportWorkbook, {
      anthropic,
      model: MODEL,
      dateFrom,
      dateTo,
      templateWorkbook
    });

    writeOutputToTemplate(templateWorkbook, outputRows);

    const outBuffer = await templateWorkbook.xlsx.writeBuffer();

    const lookupGeschaeft = buildGeschaefteLookup(templateWorkbook.getWorksheet('Geschäfte Liste'));
    const lookupKategorie = buildKategorieLookup(templateWorkbook.getWorksheet('Geraetekennzeichen Wertgarantie'));

    // Im V1-Pipeline-Modus (alte Logik) gibt es zwei Pruefliste-Formate: die
    // tabellierte Version (buildReviewWorkbookV2, im Daten-Spaltenformat) ist
    // die primaere Datei, die flache Liste (buildReviewWorkbook) steht als
    // zusaetzlicher Legacy-Download zum Vergleich bereit. Im V2-Pipeline-Modus
    // (neues Filtersystem) gibt es nur die eine, vereinheitlichte Pruefdatei.
    const primaryReviewBuilder = version === 'v1' && typeof buildReviewWorkbookV2 === 'function'
      ? buildReviewWorkbookV2
      : buildReviewWorkbook;
    const reviewWorkbook = primaryReviewBuilder(review, { lookupGeschaeft, lookupKategorie });
    const reviewBuffer = await reviewWorkbook.xlsx.writeBuffer();

    let legacyBuffer = null;
    if (version === 'v1' && typeof buildReviewWorkbookV2 === 'function') {
      const legacyWorkbook = buildReviewWorkbook(review, { lookupGeschaeft, lookupKategorie });
      legacyBuffer = await legacyWorkbook.xlsx.writeBuffer();
    }

    // Ergebnisdateien koennen (bei einem vollen Tagesreport) mehrere MB
    // groß werden - als base64 im JSON-Response wuerde das wieder das
    // 4,5MB-Limit von Vercel Serverless Functions reißen (siehe
    // FUNCTION_PAYLOAD_TOO_LARGE-Fix beim Upload). Deshalb werden die
    // Ergebnisdateien stattdessen zu Vercel Blob hochgeladen (oeffentlich,
    // aber mit zufaelligem Pfad-Suffix) und nur die (kleinen) Download-URLs
    // im Response zurueckgegeben - der Browser laedt die Datei direkt von
    // Blob, nicht ueber diese Funktion.
    const xlsxContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const dateStamp = new Date().toISOString().slice(0, 10);

    async function uploadResult(buf, filename) {
      const blob = await put(`results/${dateStamp}-${filename}`, buf, {
        access: 'public',
        addRandomSuffix: true,
        contentType: xlsxContentType,
        token: blobToken
      });
      return { url: blob.downloadUrl, filename };
    }

    const fileResult = await uploadResult(outBuffer, `Einspieldatei_${dateStamp}.xlsx`);
    const reviewResult = await uploadResult(
      reviewBuffer,
      version === 'v1' ? `Pruefliste_${dateStamp}.xlsx` : `Pruefdatei_${dateStamp}.xlsx`
    );
    const reviewLegacyFlatResult = legacyBuffer
      ? await uploadResult(legacyBuffer, `Pruefliste_flach_${dateStamp}.xlsx`)
      : null;

    const reviewSummary = {};
    for (const entry of review) {
      const label = REVIEW_REASON_LABELS[entry.reason] || entry.reason;
      reviewSummary[label] = (reviewSummary[label] || 0) + entry.rows.length;
    }

    const preview = outputRows.slice(0, 50).map((r) => ({
      Bonnummer: r.bonnummer,
      Hersteller: r.hersteller,
      Typ: r.typ,
      Seriennummer: r.seriennummer,
      Kaufpreis: r.kaufpreis,
      Produkttyp: r.produkttyp,
      Storno: r.isStorno ? 'ja' : ''
    }));

    res.status(200).json({
      version,
      fileUrl: fileResult.url,
      filename: fileResult.filename,
      reviewUrl: reviewResult.url,
      reviewFilename: reviewResult.filename,
      reviewLegacyFlatUrl: reviewLegacyFlatResult ? reviewLegacyFlatResult.url : null,
      reviewLegacyFlatFilename: reviewLegacyFlatResult ? reviewLegacyFlatResult.filename : null,
      preview,
      stats,
      reviewSummary
    });

    del(blobUrl, { token: blobToken }).catch((err) => console.error('Blob-Loeschung fehlgeschlagen:', err));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Verarbeitung fehlgeschlagen.' });
  }
};
