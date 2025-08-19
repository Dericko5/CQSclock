// server.js - Complete Express server with OneDrive integration
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Import OneDrive service and Database
const OneDriveService = require('./middleware/onedrive');
const Database = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database and OneDrive service
const db = new Database();
const oneDriveService = new OneDriveService();
const oneDriveDocsService = new OneDriveService({
  folderPath: process.env.ONEDRIVE_DOCS_FOLDER_PATH || 'Worker_Documents'
});

// Env sanity
const SERVICE_UPN = process.env.ONEDRIVE_SERVICE_UPN;
if (!SERVICE_UPN) {
  console.warn('⚠️  ONEDRIVE_SERVICE_UPN is not set in .env — uploads will fail. Set it to e.g. aldemarburbano@contractqualitysolutions.com');
}
console.log('📂 OneDrive folder base:', process.env.ONEDRIVE_FOLDER_PATH || 'TimeClock_Photos');

// Email authorization
const authorizedEmails = (process.env.AUTHORIZED_EMAILS || '')
  .split(',')
  .map(e => e.trim())
  .filter(Boolean);
function isAuthorizedEmail(email) {
  if (authorizedEmails.length === 0) return true; // allow all if unset
  return authorizedEmails.includes((email || '').toLowerCase());
}

// Security middleware (CSP can break inline scripts/styles in simple demos; enable if you need)
// app.use(helmet());

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', limiter);

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://cqsclock.onrender.com']            // or your custom domain
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
}));
// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files (serves index.html at /)
app.use(express.static(path.join(__dirname)));

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`✅ Created upload directory: ${uploadDir}`);
  } else {
    console.log(`✅ Upload directory exists: ${uploadDir}`);
  }
} catch (err) {
  console.error('❌ Failed to create upload directory:', err);
}

// Multer: disk storage to ./uploads
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const destPath = path.join(__dirname, 'uploads');
    if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
    cb(null, destPath);
  },
  filename(req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || '');
    cb(null, 'photo-' + uniqueSuffix + (ext || '.jpg'));
  }
});

// NEW: docs storage (separate prefix)
const docStorage = multer.diskStorage({
  destination(req, file, cb) {
    const destPath = path.join(__dirname, 'uploads');
    if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
    cb(null, destPath);
  },
  filename(req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || '');
    cb(null, 'doc-' + uniqueSuffix + (ext || ''));
  }
});

// For photos (unchanged)
const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/jpg').split(',');
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type.'));
  }
});

// For documents (PDF + images)
const uploadDocs = multer({
  storage: docStorage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type. Allowed: PDF, JPG, PNG.'));
  }
});


// Background OneDrive upload helper
async function uploadToOneDriveAsync(photoPath, email, timeRecordId, photoRecordId) {
  try {
    console.log(`📤 Starting OneDrive upload for ${email}...`);
    const result = await oneDriveService.uploadFile(
      photoPath,
      `clock-in-${Date.now()}.jpg`,
      email
    );

    // Persist OneDrive URL to your photo_uploads row
    await db.updatePhotoOneDriveUrl(photoRecordId, result.oneDriveUrl);

    // Cleanup local file
    await oneDriveService.cleanupLocalFile(photoPath);

    console.log(`✅ OneDrive upload completed for ${email}: ${result.oneDriveUrl}`);
  } catch (error) {
    const status = error?.response?.status;
    const body = error?.response?.data;
    console.error(`❌ OneDrive upload failed for ${email}:`, status || '', body || error.message);
    // Keep local file so you can retry later if needed
  }
}

// --- API Routes ---

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/status/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });

    const activeSession = await db.getActiveSession(email);
    res.json({
      isLoggedIn: !!activeSession,
      session: activeSession || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to check user status' });
  }
});
// Load locations
const locationsConfigPath = path.join(__dirname, 'config', 'locations.json');
let LOCATIONS = { locations: [] };
try {
  LOCATIONS = JSON.parse(fs.readFileSync(locationsConfigPath, 'utf8'));
} catch {
  console.warn('⚠️  config/locations.json missing or invalid; the dropdown will be empty.');
}

const DAILY_UPLOAD_LIMIT = parseInt(process.env.DAILY_UPLOAD_LIMIT || '5', 10);
const UNIVERSAL_CODE = process.env.UNIVERSAL_CODE || '';

// Locations list for the dropdown
app.get('/api/locations', (_req, res) => {
  res.json({ ok: true, locations: LOCATIONS.locations || [] });
});

// Submit photo to location (code + location + photo)
app.post('/api/submit', upload.single('photo'), async (req, res) => {
  try {
    const code = (req.body.code || '').trim();
    const location = (req.body.location || '').trim();
    if (!code || !location) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Code and location are required' });
    }
    if (!UNIVERSAL_CODE || code !== UNIVERSAL_CODE) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Invalid code' });
    }
    if (!LOCATIONS.locations.includes(location)) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Unknown location' });
    }
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });

    // Enforce daily limit per code+location
    const todayCount = await db.countLocationUploadsToday(code, location);
    if (todayCount >= DAILY_UPLOAD_LIMIT) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(429).json({ error: `Daily limit reached (${DAILY_UPLOAD_LIMIT}) for ${location}` });
    }

    // Record locally first
    const localRec = await db.recordLocationUpload(
      code, location, req.file.originalname, req.file.filename, req.file.size
    );

    // Upload to OneDrive under <base>/<location>
    const info = await oneDriveService.uploadFile(
      req.file.path,
      req.file.originalname,
      location // ← this becomes the subfolder instead of email
    );

    // Save OneDrive URL and cleanup local
    await db.setLocationUploadUrl(localRec.id, info.oneDriveUrl);
    await oneDriveService.cleanupLocalFile(req.file.path);

    res.json({
      ok: true,
      location,
      webUrl: info.oneDriveUrl
    });
  } catch (e) {
    console.error('submit error:', e?.response?.data || e.message);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Submit failed', detail: e.message });
  }
});


// Clock-in (photo required)
app.post('/api/clock-in', upload.single('photo'), async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      // Cleanup file if present
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!isAuthorizedEmail(email)) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Email not authorized to use this system' });
    }
    if (!req.file) return res.status(400).json({ error: 'Photo is required for clock in' });

    const photoPath = req.file.path;

    // 1) Clock in
    const result = await db.clockIn(email, photoPath);

    // 2) Save photo record (local info first)
    const photoRecord = await db.savePhotoRecord(
      result.timeRecordId,
      email,
      req.file.originalname,
      req.file.filename,
      req.file.size
    );

    console.log(`✅ Clock in successful: ${email} at ${result.clockInTime}`);

    // 3) Upload to OneDrive in the background; DB link updated when done
    uploadToOneDriveAsync(photoPath, email, result.timeRecordId, photoRecord.id);

    res.json({
      success: true,
      message: 'Successfully clocked in',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Clock in error:', error);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    if (String(error.message || '').includes('already clocked in')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to clock in' });
    }
  }
});

// Clock-out
app.post('/api/clock-out', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });

    const result = await db.clockOut(email);
    console.log(`✅ Clock out successful: ${email} at ${result.clockOutTime} (${result.totalHours} hours)`);

    res.json({
      success: true,
      message: 'Successfully clocked out',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Clock out error:', error);
    if (String(error.message || '').includes('No active session')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to clock out' });
    }
  }
});

// Time records for a user
app.get('/api/records/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const { startDate, endDate } = req.query;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });

    const records = await db.getTimeRecordsForUser(email, startDate, endDate);
    res.json({
      success: true,
      data: records,
      count: records.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get records error:', error);
    res.status(500).json({ error: 'Failed to retrieve time records' });
  }
});

// Admin: active users
app.get('/api/admin/active-users', async (_req, res) => {
  try {
    const activeUsers = await db.getCurrentlyLoggedInUsers();
    res.json({
      success: true,
      data: activeUsers,
      count: activeUsers.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get active users error:', error);
    res.status(500).json({ error: 'Failed to retrieve active users' });
  }
});

// Admin: all time records
app.get('/api/admin/all-records', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const records = await db.getAllTimeRecords(startDate, endDate);
    res.json({
      success: true,
      data: records,
      count: records.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get all records error:', error);
    res.status(500).json({ error: 'Failed to retrieve time records' });
  }
});

// OneDrive admin: list files
app.get('/api/admin/onedrive-files', async (_req, res) => {
  try {
    const files = await oneDriveService.listFiles();
    res.json({ success: true, data: files, count: files.length });
  } catch (error) {
    console.error('Failed to list OneDrive files:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to retrieve OneDrive files' });
  }
});

// OneDrive admin: connection test
app.get('/api/admin/test-onedrive', async (_req, res) => {
  try {
    await oneDriveService.getAccessToken();
    await oneDriveService.ensurePathExists(oneDriveService.folderPath); // ✅ fixed
    res.json({
      success: true,
      message: 'OneDrive connection successful',
      folder: oneDriveService.folderPath
    });
  } catch (error) {
    console.error('OneDrive test failed:', error?.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'OneDrive connection failed',
      details: error.message
    });
  }
});

app.get('/documents', (req, res) => {
  res.sendFile(path.join(__dirname, 'documents.html'));
});
app.post('/api/documents/submit',
  uploadDocs.fields([{ name: 'w9', maxCount: 1 }, { name: 'license', maxCount: 1 }]),
  async (req, res) => {
    try {
      const code     = (req.body.code || '').trim();
      const firstRaw = (req.body.firstName || '').trim();
      const lastRaw  = (req.body.lastName  || '').trim();

      if (!code || code !== (process.env.UNIVERSAL_CODE || '').trim()) {
        return res.status(401).json({ error: 'Invalid access code' });
      }
      if (!firstRaw || !lastRaw) {
        return res.status(400).json({ error: 'First & last name required' });
      }

      const w9 = (req.files?.w9 || [])[0];
      const dl = (req.files?.license || [])[0];
      if (!w9 || !dl) return res.status(400).json({ error: 'W-9 and Driver’s License are required' });
      if (w9.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'W-9 must be a PDF' });
      }

      const sanitize = s => (s || '').replace(/[^A-Za-z0-9]/g,'').trim();
      const first = sanitize(firstRaw);
      const last  = sanitize(lastRaw);
      const nameBase = (first + last) || 'Unknown';

      const ts   = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = Math.random().toString(36).slice(2, 8); // make sure it's unique

      const w9Name = `${nameBase}_W9form_${ts}_${rand}.pdf`;
      const dlExt  = (path.extname(dl.originalname || '').toLowerCase() || '.jpg');
      const dlName = `${nameBase}_DriversLicense_${ts}_${rand}${dlExt}`;
      // --- W-9 file config (override with W9_FILE in .env if you want) ---
      const W9_FILE     = process.env.W9_FILE || 'w9.PDF';
      const W9_ABS_PATH = path.join(__dirname, W9_FILE);


      // All new-hire docs go here
      const subFolder = 'New_Hires';

      const [w9Result, dlResult] = await Promise.all([
        oneDriveDocsService.uploadFile(w9.path, w9Name, subFolder),
        oneDriveDocsService.uploadFile(dl.path, dlName, subFolder),
      ]);

      // cleanup local temp files
      try { if (w9.path) fs.existsSync(w9.path) && fs.unlinkSync(w9.path); } catch {}
      try { if (dl.path) fs.existsSync(dl.path) && fs.unlinkSync(dl.path); } catch {}

      return res.json({
        success: true,
        firstName: firstRaw,
        lastName: lastRaw,
        w9: { id: w9Result.oneDriveId, url: w9Result.oneDriveUrl, name: w9Name },
        license: { id: dlResult.oneDriveId, url: dlResult.oneDriveUrl, name: dlName }
      });
    } catch (err) {
      console.error('Documents submit error:', err?.response?.data || err.message);
      try { (req.files?.w9 || []).forEach(f => fs.existsSync(f.path) && fs.unlinkSync(f.path)); } catch {}
      try { (req.files?.license || []).forEach(f => fs.existsSync(f.path) && fs.unlinkSync(f.path)); } catch {}
      return res.status(500).json({ error: 'Failed to upload documents' });
    }
  }
);




// Serve index
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/download/w9', (req, res, next) => {
  fs.access(W9_ABS_PATH, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).send('W-9 file not found');
    // res.download sets Content-Disposition: attachment; filename="..."
    res.download(W9_ABS_PATH, path.basename(W9_ABS_PATH), (e) => {
      if (e) next(e);
    });
  });
});

// Lightweight availability check for your HEAD fetch
app.head('/download/w9', (req, res) => {
  fs.access(W9_ABS_PATH, fs.constants.R_OK, (err) => {
    res.status(err ? 404 : 200).end();
  });
});

// Back-compat: if any page still links to /w9.pdf, redirect to the forced-download route
app.all(['/w9.pdf', '/W9.pdf'], (req, res) => {
  res.redirect(302, '/download/w9');
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((error, _req, res, _next) => {
  console.error('Global error handler:', error);
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
    return res.status(400).json({ error: 'File upload error' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 TimeTracker server running on port ${PORT}`);
  console.log(`📱 Frontend: http://localhost:${PORT}`);
  console.log(`🔗 API base: http://localhost:${PORT}/api`);
  console.log(`🗄️  Database: ${db.dbPath}`);
  console.log(`📁 Upload directory: ${uploadDir}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n🛑 Server terminated');
  db.close();
  process.exit(0);
});
