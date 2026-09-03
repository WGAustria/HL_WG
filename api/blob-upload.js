const { handleUpload } = require('@vercel/blob/client');

// Stellt Client-Tokens fuer den direkten Browser-Upload zu Vercel Blob aus.
// Notwendig, weil Vercel Serverless Functions Requests > 4.5MB ablehnen
// (FUNCTION_PAYLOAD_TOO_LARGE) - die Report-Datei ist typischerweise > 10MB.
// Der Browser laedt die Datei stattdessen direkt zu Vercel Blob hoch, und
// /api/process bekommt danach nur noch die (kleine) Blob-URL.
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

  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', resolve);
  });

  try {
    const jsonResponse = await handleUpload({
      body: JSON.parse(body || '{}'),
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel'
        ],
        addRandomSuffix: true,
        access: 'private',
        maximumSizeInBytes: 60 * 1024 * 1024
      })
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Upload-Token konnte nicht erstellt werden.' });
  }
};
