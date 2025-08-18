// upload.js
const express = require('express');
const multer = require('multer');
const { graphClient } = require('./auth');

const router = express.Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB per your .env
const SERVICE_UPN = process.env.ONEDRIVE_SERVICE_UPN;
const BASE_FOLDER = process.env.ONEDRIVE_FOLDER_PATH || 'TimeClock_Photos';

router.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!SERVICE_UPN) return res.status(500).json({ error: 'ONEDRIVE_SERVICE_UPN not set' });

    const safeEmail = email.replace(/[^a-z0-9._@-]/gi, '_');
    const fileName = `${Date.now()}_${req.file.originalname}`;

    const client = await graphClient();
    const apiPath =
      `/users/${encodeURIComponent(SERVICE_UPN)}` +
      `/drive/root:/${BASE_FOLDER}/${safeEmail}/${fileName}:/content`;

    // Debug: confirm we are NOT using /me
    console.log('GRAPH PUT:', apiPath);

    const result = await client.api(apiPath).put(req.file.buffer);
    return res.json({ ok: true, id: result.id, webUrl: result.webUrl, name: result.name });
  } catch (e) {
    console.error('Upload error:', e?.response?.status, e?.response?.data || e.message);
    return res.status(500).json({ error: 'Upload failed', detail: e.message });
  }
});

module.exports = router;
