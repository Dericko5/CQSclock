// photos.js
const express = require('express');
const OneDriveService = require('../middleware/onedrive');

const router = express.Router();
const oneDrive = new OneDriveService();

// List files under ONEDRIVE_FOLDER_PATH
router.get('/api/photos', async (_req, res) => {
  try {
    const files = await oneDrive.listFiles();
    res.json({ ok: true, files });
  } catch (e) {
    console.error('List files error:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'List failed', detail: e.message });
  }
});

// Get a temporary download URL for a file id
router.get('/api/photos/:id/download', async (req, res) => {
  try {
    const url = await oneDrive.getFileDownloadUrl(req.params.id);
    res.json({ ok: true, downloadUrl: url });
  } catch (e) {
    console.error('Get download URL error:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Get URL failed', detail: e.message });
  }
});

module.exports = router;
