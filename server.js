// server.js — Express app with OneDrive + robust PDF.js W-9 viewer/download
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
// const helmet = require('helmet'); // If you enable this, configure a CSP that allows pdf.js and your inline <script>/<style>
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');

// ───────────────────────────────────────────────────────────────────────────────
// PDF.js + W-9
// ───────────────────────────────────────────────────────────────────────────────

// Your W-9 file (make sure the file name & casing matches what's in the repo)
const W9_FILE     = process.env.W9_FILE || 'IRS-Form-W9-2024.pdf';
const W9_ABS_PATH = path.join(__dirname, W9_FILE);
console.log('📄 W-9 path:', W9_ABS_PATH);

// Find pdfjs-dist viewer & build dirs no matter which layout your version uses
function resolvePdfjs() {
  // Candidate viewer.html paths (in order of most common)
  const viewerCandidates = [
    'pdfjs-dist/web/viewer.html',                  // older layout
    'pdfjs-dist/build/generic/web/viewer.html',    // newer layout
    'pdfjs-dist/legacy/web/viewer.html',           // legacy build
    'pdfjs-dist/es5/web/viewer.html',              // es5 build
    'pdfjs-dist/build/minified/web/viewer.html',   // minified build
  ];
  let viewerHtml = null;
  for (const c of viewerCandidates) {
    try {
      viewerHtml = require.resolve(c);
      break;
    } catch { /* try next */ }
  }
  if (!viewerHtml) return null;

  const viewerDir = path.dirname(viewerHtml);

  // Try to locate a build folder that contains pdf.js / pdf.worker.*
  const buildCandidates = [
    path.resolve(viewerDir, '..', 'build'),
    path.resolve(viewerDir, '..', 'build', 'minified'),
    path.resolve(viewerDir, '..', 'generic', 'build'),
    path.resolve(viewerDir, '..', '..', 'build'),
    path.resolve(viewerDir, '..', '..', 'build', 'minified'),
  ];

  let buildDir = null;
  for (const b of buildCandidates) {
    if (
      fs.existsSync(path.join(b, 'pdf.js')) ||
      fs.existsSync(path.join(b, 'pdf.mjs')) ||
      fs.existsSync(path.join(b, 'pdf.min.js'))
    ) {
      buildDir = b;
      break;
    }
  }

  return { viewerDir, buildDir };
}

const pdfjs = resolvePdfjs();
if (!pdfjs) {
  console.error('❌ Could not locate pdfjs-dist viewer.html. Did you run `npm i pdfjs-dist`?');
} else {
  console.log('📦 Serving PDF.js viewer from:', pdfjs.viewerDir);
  console.log('📦 Serving PDF.js build  from:', pdfjs.buildDir || '(none found)');

  // Serve the viewer directory at /pdfjs/web (images, cmaps, locale, viewer.html, etc.)
  appStaticMount('/pdfjs/web', pdfjs.viewerDir);

  // Serve the build directory (pdf.js, workers, mjs). Some layouts don’t need this, but expose it anyway.
  if (pdfjs.buildDir) {
    appStaticMount('/pdfjs/build', pdfjs.buildDir);
  }

  // Helper to mount static with .mjs content-type fix
  function appStaticMount(route, dir) {
    // Defined below after `const app = express()`, but hoisted by function usage—we’ll rebind after app creation.
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// App / Services
// ───────────────────────────────────────────────────────────────────────────────
const OneDriveService = require('./middleware/onedrive');
const Database        = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

// Bind the static helper now that `app` exists
function mountStaticFixed(route, dir) {
  app.use(route, express.static(dir, {
    setHeaders(res, filePath) {
      // Some hosts serve .mjs incorrectly; make sure it's JS so the browser runs it
      if (filePath.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      }
    }
  }));
}
// Re-run the pdf.js mounts (if resolved) now that we can call app.use
(function rebindPdfJs() {
  const pdfjs2 = resolvePdfjs();
  if (!pdfjs2) return;
  console.log('📦 (bind) PDF.js viewer:', pdfjs2.viewerDir);
  console.log('📦 (bind) PDF.js build :', pdfjs2.buildDir || '(none)');
  mountStaticFixed('/pdfjs/web', pdfjs2.viewerDir);
  if (pdfjs2.buildDir) mountStaticFixed('/pdfjs/build', pdfjs2.buildDir);
})();

const db                 = new Database();
const oneDriveService    = new OneDriveService();
const oneDriveDocs       = new OneDriveService({
  folderPath: process.env.ONEDRIVE_DOCS_FOLDER_PATH || 'Worker_Documents'
});

// ───────────────────────────────────────────────────────────────────────────────
// Environment sanity
// ───────────────────────────────────────────────────────────────────────────────
if (!process.env.ONEDRIVE_SERVICE_UPN) {
  console.warn('⚠️  ONEDRIVE_SERVICE_UPN is not set in .env — uploads will fail.');
}
console.log('📂 OneDrive base folder:', process.env.ONEDRIVE_FOLDER_PATH || 'TimeClock_Photos');

// ───────────────────────────────────────────────────────────────────────────────
// Middleware
// ───────────────────────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message:  { error: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', limiter);

// If you enable helmet(), add an appropriate CSP for pdf.js/inline styles/scripts
// app.use(helmet());

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://cqsclock.onrender.com']
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve your site files (index.html, etc.) from the project root
app.use(express.static(path.join(__dirname)));

// ───────────────────────────────────────────────────────────────────────────────
// Shortcuts for W-9
// ───────────────────────────────────────────────────────────────────────────────
app.get('/w9', (_req, res) => {
  const fileUrl = encodeURIComponent('/' + W9_FILE);
  // Loads the in-browser viewer
  res.redirect(`/pdfjs/web/viewer.html?file=${fileUrl}#view=FitH&pagemode=none`);
});

// Force download (mobile-friendly)
app.get('/download/w9', (_req, res, next) => {
  fs.access(W9_ABS_PATH, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).send('W-9 file not found');
    res.download(W9_ABS_PATH, path.basename(W9_ABS_PATH), (e) => e && next(e));
  });
});

// Lightweight HEAD probe (if you use it client-side)
app.head('/download/w9', (_req, res) => {
  fs.access(W9_ABS_PATH, fs.constants.R_OK, (err) => res.sendStatus(err ? 404 : 200));
});

// Back-compat redirects
app.all(['/w9.pdf', '/W9.pdf'], (_req, res) => res.redirect(302, '/download/w9'));

// ───────────────────────────────────────────────────────────────────────────────
// Upload directories & Multer
// ───────────────────────────────────────────────────────────────────────────────
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

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || '');
    cb(null, 'photo-' + unique + (ext || '.jpg'));
  }
});

const docStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || '');
    cb(null, 'doc-' + unique + (ext || ''));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/jpg').split(',');
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type.'));
  }
});

const uploadDocs = multer({
  storage: docStorage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type. Allowed: PDF, JPG, PNG.'));
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers & config
// ───────────────────────────────────────────────────────────────────────────────
const authorizedEmails = (process.env.AUTHORIZED_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
function isAuthorizedEmail(email) {
  if (authorizedEmails.length === 0) return true;
  return authorizedEmails.includes((email || '').toLowerCase());
}

async function uploadToOneDriveAsync(localPath, subFolder, remoteName) {
  const result = await oneDriveService.uploadFile(localPath, remoteName, subFolder);
  await oneDriveService.cleanupLocalFile(localPath);
  return result;
}

const locationsConfigPath = path.join(__dirname, 'config', 'locations.json');
let LOCATIONS = { locations: [] };
try { LOCATIONS = JSON.parse(fs.readFileSync(locationsConfigPath, 'utf8')); }
catch { console.warn('⚠️  config/locations.json missing or invalid; dropdown will be empty.'); }

const DAILY_UPLOAD_LIMIT = parseInt(process.env.DAILY_UPLOAD_LIMIT || '5', 10);
const UNIVERSAL_CODE     = (process.env.UNIVERSAL_CODE || '').trim();

// ───────────────────────────────────────────────────────────────────────────────
// API
// ───────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), environment: process.env.NODE_ENV || 'development' });
});

app.get('/api/status/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
    const active = await db.getActiveSession(email);
    res.json({ isLoggedIn: !!active, session: active || null, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Status error:', e);
    res.status(500).json({ error: 'Failed to check user status' });
  }
});

app.get('/api/locations', (_req, res) => {
  res.json({ ok: true, locations: LOCATIONS.locations || [] });
});

app.post('/api/submit', upload.single('photo'), async (req, res) => {
  try {
    const code     = (req.body.code || '').trim();
    const location = (req.body.location || '').trim();
    if (!code || !location) throw new Error('Code and location are required');
    if (!UNIVERSAL_CODE || code !== UNIVERSAL_CODE) return res.status(401).json({ error: 'Invalid code' });
    if (!LOCATIONS.locations.includes(location)) return res.status(400).json({ error: 'Unknown location' });
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });

    const todayCount = await db.countLocationUploadsToday(code, location);
    if (todayCount >= DAILY_UPLOAD_LIMIT) {
      fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
      return res.status(429).json({ error: `Daily limit reached (${DAILY_UPLOAD_LIMIT}) for ${location}` });
    }

    const localRec = await db.recordLocationUpload(
      code, location, req.file.originalname, req.file.filename, req.file.size
    );

    const uploaded = await oneDriveService.uploadFile(req.file.path, req.file.originalname, location);
    await db.setLocationUploadUrl(localRec.id, uploaded.oneDriveUrl);
    await oneDriveService.cleanupLocalFile(req.file.path);

    res.json({ ok: true, location, webUrl: uploaded.oneDriveUrl });
  } catch (e) {
    console.error('submit error:', e?.response?.data || e.message);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Submit failed', detail: e.message });
  }
});

app.post('/api/clock-in', upload.single('photo'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) throw new Error('Valid email is required');
    if (!isAuthorizedEmail(email)) return res.status(403).json({ error: 'Email not authorized to use this system' });
    if (!req.file) return res.status(400).json({ error: 'Photo is required for clock in' });

    const clock = await db.clockIn(email, req.file.path);
    const photoRecord = await db.savePhotoRecord(clock.timeRecordId, email, req.file.originalname, req.file.filename, req.file.size);

    // background upload
    uploadToOneDriveAsync(req.file.path, email, `clock-in-${Date.now()}.jpg`)
      .then(info => db.updatePhotoOneDriveUrl(photoRecord.id, info.oneDriveUrl))
      .catch(err => console.error('OneDrive async upload failed:', err?.response?.data || err.message));

    res.json({ success: true, message: 'Successfully clocked in', data: clock, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Clock in error:', e);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (String(e.message || '').includes('already clocked in')) return res.status(409).json({ error: e.message });
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

app.post('/api/clock-out', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
    const result = await db.clockOut(email);
    res.json({ success: true, message: 'Successfully clocked out', data: result, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Clock out error:', e);
    if (String(e.message || '').includes('No active session')) return res.status(404).json({ error: e.message });
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

app.get('/api/records/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const { startDate, endDate } = req.query;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
    const records = await db.getTimeRecordsForUser(email, startDate, endDate);
    res.json({ success: true, data: records, count: records.length, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Get records error:', e);
    res.status(500).json({ error: 'Failed to retrieve time records' });
  }
});

app.get('/api/admin/active-users', async (_req, res) => {
  try {
    const activeUsers = await db.getCurrentlyLoggedInUsers();
    res.json({ success: true, data: activeUsers, count: activeUsers.length, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Get active users error:', e);
    res.status(500).json({ error: 'Failed to retrieve active users' });
  }
});

app.get('/api/admin/all-records', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const records = await db.getAllTimeRecords(startDate, endDate);
    res.json({ success: true, data: records, count: records.length, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Get all records error:', e);
    res.status(500).json({ error: 'Failed to retrieve time records' });
  }
});

app.get('/api/admin/onedrive-files', async (_req, res) => {
  try {
    const files = await oneDriveService.listFiles();
    res.json({ success: true, data: files, count: files.length });
  } catch (e) {
    console.error('Failed to list OneDrive files:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Failed to retrieve OneDrive files' });
  }
});

app.get('/api/admin/test-onedrive', async (_req, res) => {
  try {
    await oneDriveService.getAccessToken();
    await oneDriveService.ensurePathExists(oneDriveService.folderPath);
    res.json({ success: true, message: 'OneDrive connection successful', folder: oneDriveService.folderPath });
  } catch (e) {
    console.error('OneDrive test failed:', e?.response?.data || e.message);
    res.status(500).json({ success: false, error: 'OneDrive connection failed', details: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Pages
// ───────────────────────────────────────────────────────────────────────────────
app.get('/documents', (_req, res) => {
  res.sendFile(path.join(__dirname, 'documents.html'));
});

app.post('/api/documents/submit',
  uploadDocs.fields([{ name: 'w9', maxCount: 1 }, { name: 'license', maxCount: 1 }]),
  async (req, res) => {
    try {
      const code     = (req.body.code || '').trim();
      const firstRaw = (req.body.firstName || '').trim();
      const lastRaw  = (req.body.lastName  || '').trim();

      if (!code || code !== UNIVERSAL_CODE) return res.status(401).json({ error: 'Invalid access code' });
      if (!firstRaw || !lastRaw)           return res.status(400).json({ error: 'First & last name required' });

      const w9 = (req.files?.w9 || [])[0];
      const dl = (req.files?.license || [])[0];
      if (!w9 || !dl)                      return res.status(400).json({ error: 'W-9 and Driver’s License are required' });
      if (w9.mimetype !== 'application/pdf') return res.status(400).json({ error: 'W-9 must be a PDF' });

      const sanitize = s => (s || '').replace(/[^A-Za-z0-9]/g,'').trim();
      const first = sanitize(firstRaw);
      const last  = sanitize(lastRaw);
      const nameBase = (first + last) || 'Unknown';

      const ts   = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = Math.random().toString(36).slice(2, 8);

      const w9Name = `${nameBase}_W9form_${ts}_${rand}.pdf`;
      const dlExt  = (path.extname(dl.originalname || '').toLowerCase() || '.jpg');
      const dlName = `${nameBase}_DriversLicense_${ts}_${rand}${dlExt}`;

      const subFolder = 'New_Hires';

      const [w9Result, dlResult] = await Promise.all([
        oneDriveDocs.uploadFile(w9.path, w9Name, subFolder),
        oneDriveDocs.uploadFile(dl.path, dlName, subFolder),
      ]);

      try { w9.path && fs.existsSync(w9.path) && fs.unlinkSync(w9.path); } catch {}
      try { dl.path && fs.existsSync(dl.path) && fs.unlinkSync(dl.path); } catch {}

      res.json({
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
      res.status(500).json({ error: 'Failed to upload documents' });
    }
  }
);

// Root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ───────────────────────────────────────────────────────────────────────────────
// 404 & Error handler (last)
// ───────────────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));

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

// ───────────────────────────────────────────────────────────────────────────────
// Start
// ───────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 TimeTracker server running on port ${PORT}`);
  console.log(`📱 Frontend: http://localhost:${PORT}`);
  console.log(`🔗 API base: http://localhost:${PORT}/api`);
  console.log(`🗄️  Database: ${db.dbPath}`);
  console.log(`📁 Upload directory: ${uploadDir}`);
});
