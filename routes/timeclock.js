// timeclock.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const OneDriveService = require('../middleware/onedrive');
const Database = require('../database'); // your database.js

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', 'uploads') }); // disk temp storage
const db = new Database();
const oneDrive = new OneDriveService();

// POST /api/clock-in-with-photo  (email + photo)
router.post('/api/clock-in-with-photo', upload.single('photo'), async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!req.file) return res.status(400).json({ error: 'Photo required' });

    // 1) Clock in (your existing db logic)
    const result = await db.clockIn(email, null); // photoUrl to be set after upload

    // 2) Upload to OneDrive under {BASE}/{email}/timestamp_email_filename
    const info = await oneDrive.uploadFile(req.file.path, req.file.originalname, email);

    // 3) Save OneDrive link in your DB if desired (photo_uploads or time_records)
    await db.savePhotoRecord(
      result.timeRecordId,
      email,
      req.file.originalname,
      info.fileName,
      req.file.size
    );
    await db.updatePhotoOneDriveUrl(/*photoId if you track it*/ info.oneDriveUrl);

    // 4) Cleanup local temp file
    await oneDrive.cleanupLocalFile(req.file.path);

    res.json({
      ok: true,
      timeRecordId: result.timeRecordId,
      sessionId: result.sessionId,
      webUrl: info.oneDriveUrl
    });
  } catch (e) {
    console.error('clock-in-with-photo error:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Clock-in with photo failed', detail: e.message });
  }
});

module.exports = router;
