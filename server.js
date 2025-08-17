// server.js - Main Express server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
const db = new Database();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:"],
        },
    },
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.'
    }
});
app.use('/api/', limiter);

// CORS configuration
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://yourdomain.com'] // Replace with your actual domain
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (your frontend)
app.use(express.static(path.join(__dirname)));

// Ensure upload directories exist
const uploadDir = path.join(__dirname, 'uploads', 'temp');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'photo-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024, // 5MB default
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/jpg').split(',');
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, and JPG files are allowed.'));
        }
    }
});

// API Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Get user status (check if clocked in)
app.get('/api/status/:email', async (req, res) => {
    try {
        const { email } = req.params;
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

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

// Clock in endpoint
app.post('/api/clock-in', upload.single('photo'), async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Photo is required for clock in' });
        }

        // For now, we'll store the local file path. Later we'll upload to OneDrive
        const photoPath = req.file.path;
        
        const result = await db.clockIn(email, photoPath);
        
        // Save photo record
        await db.savePhotoRecord(
            result.timeRecordId,
            email,
            req.file.originalname,
            req.file.filename,
            req.file.size
        );

        console.log(`✅ Clock in successful: ${email} at ${result.clockInTime}`);
        
        res.json({
            success: true,
            message: 'Successfully clocked in',
            data: result,
            timestamp: new Date().toISOString()
        });

        // TODO: Upload photo to OneDrive in background
        // uploadToOneDrive(photoPath, email, result.timeRecordId);

    } catch (error) {
        console.error('Clock in error:', error);
        
        // Clean up uploaded file if there was an error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        if (error.message.includes('already clocked in')) {
            res.status(409).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Failed to clock in' });
        }
    }
});

// Clock out endpoint
app.post('/api/clock-out', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

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
        
        if (error.message.includes('No active session')) {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Failed to clock out' });
        }
    }
});

// Get time records for a user
app.get('/api/records/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const { startDate, endDate } = req.query;
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

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

// Admin endpoint - get all currently logged in users
app.get('/api/admin/active-users', async (req, res) => {
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

// Admin endpoint - get all time records
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

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle 404s
//app.use('*', (req, res) => {
//    res.status(404).json({ error: 'Endpoint not found' });
//});

// Global error handler
app.use((error, req, res, next) => {
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
    console.log(`📱 Frontend available at: http://localhost:${PORT}`);
    console.log(`🔗 API endpoints at: http://localhost:${PORT}/api`);
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