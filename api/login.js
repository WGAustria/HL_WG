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

  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', resolve);
  });

  let password = '';
  try {
    password = JSON.parse(body || '{}').password || '';
  } catch {
    res.status(400).json({ error: 'Ungueltige Anfrage.' });
    return;
  }

  if (password !== sitePassword) {
    res.status(401).json({ error: 'Falsches Passwort.' });
    return;
  }

  res.status(200).json({ ok: true });
};
