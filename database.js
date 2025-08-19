// database.js - Database setup and configuration
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor() {
        // Create database file in project root
        this.dbPath = process.env.DB_PATH || path.join(__dirname, 'timeclock.db');
        this.db = new sqlite3.Database(this.dbPath);
        this.initializeTables();
    }

    initializeTables() {
        this.db.serialize(() => {
            // Users table - stores employee information
            this.db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    first_name TEXT,
                    last_name TEXT,
                    employee_id TEXT,
                    department TEXT,
                    is_active BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Time records table - stores all clock in/out events
            this.db.run(`
                CREATE TABLE IF NOT EXISTS time_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    email TEXT NOT NULL,
                    clock_in_time DATETIME NOT NULL,
                    clock_out_time DATETIME,
                    total_hours DECIMAL(5,2),
                    status TEXT DEFAULT 'active',
                    photo_url TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            `);

            // Active sessions table - tracks who's currently clocked in
            this.db.run(`
                CREATE TABLE IF NOT EXISTS active_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    email TEXT NOT NULL,
                    time_record_id INTEGER NOT NULL,
                    clock_in_time DATETIME NOT NULL,
                    photo_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id),
                    FOREIGN KEY (time_record_id) REFERENCES time_records (id)
                )
            `);

            // Photo uploads table - tracks all uploaded images
            this.db.run(`
                CREATE TABLE IF NOT EXISTS photo_uploads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    time_record_id INTEGER NOT NULL,
                    user_email TEXT NOT NULL,
                    original_filename TEXT,
                    stored_filename TEXT,
                    onedrive_url TEXT,
                    file_size INTEGER,
                    upload_status TEXT DEFAULT 'pending',
                    upload_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (time_record_id) REFERENCES time_records (id)
                )
            `);

            console.log('✅ Database tables initialized successfully');
        });
        this.db.run(`
            CREATE TABLE IF NOT EXISTS location_uploads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                location TEXT NOT NULL,
                original_filename TEXT,
                stored_filename TEXT,
                onedrive_url TEXT,
                file_size INTEGER,
                submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            `);
    }
    async recordLocationUpload(code, location, original, stored, size, onedriveUrl=null) {
        return new Promise((resolve, reject) => {
            this.db.run(`
            INSERT INTO location_uploads (code, location, original_filename, stored_filename, file_size, onedrive_url)
            VALUES (?, ?, ?, ?, ?, ?)
            `, [code, location, original, stored, size, onedriveUrl], function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
            });
        });
    }

    async setLocationUploadUrl(id, url) {
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE location_uploads SET onedrive_url = ? WHERE id = ?`,
            [url, id], function(err) {
                if (err) reject(err); else resolve(true);
            });
        });
    }

    async countLocationUploadsToday(code, location) {
        return new Promise((resolve, reject) => {
            this.db.get(`
            SELECT COUNT(*) AS cnt
            FROM location_uploads
            WHERE code = ?
                AND location = ?
                AND DATE(submitted_at, 'localtime') = DATE('now', 'localtime')
            `, [code, location], (err, row) => {
            if (err) reject(err); else resolve(row?.cnt || 0);
            });
        });
    }


    // User management methods
    async createUser(email, firstName = null, lastName = null, employeeId = null, department = null) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO users (email, first_name, last_name, employee_id, department)
                VALUES (?, ?, ?, ?, ?)
            `);
            
            stmt.run([email, firstName, lastName, employeeId, department], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, email, firstName, lastName, employeeId, department });
                }
            });
            stmt.finalize();
        });
    }

    async getUserByEmail(email) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE email = ? AND is_active = 1', [email], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    // Time tracking methods
    async clockIn(userEmail, photoUrl = null) {
    return new Promise(async (resolve, reject) => {
        try {
        let user = await this.getUserByEmail(userEmail);
        if (!user) user = await this.createUser(userEmail);

        const activeSession = await this.getActiveSession(userEmail);
        if (activeSession) return reject(new Error('User is already clocked in'));

        const clockInTime = new Date().toISOString();

        const db = this.db; // <— capture it

        db.run(`
            INSERT INTO time_records (user_id, email, clock_in_time, photo_url, status)
            VALUES (?, ?, ?, ?, 'active')
        `, [user.id, userEmail, clockInTime, photoUrl], function (err) {
            if (err) return reject(err);

            const timeRecordId = this.lastID; // ok: "this" here is the statement for THIS run

            db.run(`
            INSERT INTO active_sessions (user_id, email, time_record_id, clock_in_time, photo_url)
            VALUES (?, ?, ?, ?, ?)
            `, [user.id, userEmail, timeRecordId, clockInTime, photoUrl], function (err) {
            if (err) return reject(err);

            resolve({
                timeRecordId,
                sessionId: this.lastID, // ok: statement for the second run
                clockInTime,
                userEmail,
                photoUrl
            });
            });
        });
        } catch (e) {
        reject(e);
        }
    });
    }


    async clockOut(userEmail) {
    return new Promise(async (resolve, reject) => {
        try {
        const activeSession = await this.getActiveSession(userEmail);
        if (!activeSession) return reject(new Error('No active session found for this user'));

        const clockOutTime = new Date().toISOString();
        const clockInTime = new Date(activeSession.clock_in_time);
        const totalHours = (new Date(clockOutTime) - clockInTime) / 36e5;

        const db = this.db; // <— capture

        db.run(`
            UPDATE time_records
            SET clock_out_time = ?, total_hours = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [clockOutTime, totalHours.toFixed(2), activeSession.time_record_id], function (err) {
            if (err) return reject(err);

            db.run('DELETE FROM active_sessions WHERE id = ?', [activeSession.id], function (err) {
            if (err) return reject(err);

            resolve({
                timeRecordId: activeSession.time_record_id,
                clockInTime: activeSession.clock_in_time,
                clockOutTime,
                totalHours: totalHours.toFixed(2),
                userEmail
            });
            });
        });
        } catch (e) {
        reject(e);
        }
    });
    }


    async getActiveSession(userEmail) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM active_sessions WHERE email = ?', [userEmail], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    // Photo management
    async savePhotoRecord(timeRecordId, userEmail, originalFilename, storedFilename, fileSize) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO photo_uploads (time_record_id, user_email, original_filename, stored_filename, file_size)
                VALUES (?, ?, ?, ?, ?)
            `, [timeRecordId, userEmail, originalFilename, storedFilename, fileSize], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, timeRecordId, userEmail, originalFilename, storedFilename });
                }
            });
        });
    }

    async updatePhotoOneDriveUrl(photoId, oneDriveUrl) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                UPDATE photo_uploads 
                SET onedrive_url = ?, upload_status = 'uploaded'
                WHERE id = ?
            `, [oneDriveUrl, photoId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ photoId, oneDriveUrl });
                }
            });
        });
    }

    // Reporting methods
    async getTimeRecordsForUser(userEmail, startDate = null, endDate = null) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT * FROM time_records WHERE email = ?';
            let params = [userEmail];

            if (startDate && endDate) {
                query += ' AND clock_in_time BETWEEN ? AND ?';
                params.push(startDate, endDate);
            }

            query += ' ORDER BY clock_in_time DESC';

            this.db.all(query, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getAllTimeRecords(startDate = null, endDate = null) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT tr.*, u.first_name, u.last_name, u.department FROM time_records tr LEFT JOIN users u ON tr.user_id = u.id';
            let params = [];

            if (startDate && endDate) {
                query += ' WHERE tr.clock_in_time BETWEEN ? AND ?';
                params.push(startDate, endDate);
            }

            query += ' ORDER BY tr.clock_in_time DESC';

            this.db.all(query, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getCurrentlyLoggedInUsers() {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT a.*, u.first_name, u.last_name, u.department
                FROM active_sessions a
                LEFT JOIN users u ON a.user_id = u.id
                ORDER BY a.clock_in_time DESC
            `, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Database maintenance
    close() {
        this.db.close((err) => {
            if (err) {
                console.error('Error closing database:', err);
            } else {
                console.log('Database connection closed.');
            }
        });
    }
}

module.exports = Database;