// database.js - Database setup and configuration
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor() {
        // Create database file in project root
        this.dbPath = path.join(__dirname, 'timeclock.db');
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
                // First, get or create user
                let user = await this.getUserByEmail(userEmail);
                if (!user) {
                    user = await this.createUser(userEmail);
                }

                // Check if already clocked in
                const activeSession = await this.getActiveSession(userEmail);
                if (activeSession) {
                    reject(new Error('User is already clocked in'));
                    return;
                }

                const clockInTime = new Date().toISOString();

                // Create time record
                this.db.run(`
                    INSERT INTO time_records (user_id, email, clock_in_time, photo_url, status)
                    VALUES (?, ?, ?, ?, 'active')
                `, [user.id, userEmail, clockInTime, photoUrl], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        const timeRecordId = this.lastID;

                        // Create active session
                        this.db.run(`
                            INSERT INTO active_sessions (user_id, email, time_record_id, clock_in_time, photo_url)
                            VALUES (?, ?, ?, ?, ?)
                        `, [user.id, userEmail, timeRecordId, clockInTime, photoUrl], function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve({
                                    timeRecordId,
                                    sessionId: this.lastID,
                                    clockInTime,
                                    userEmail,
                                    photoUrl
                                });
                            }
                        });
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async clockOut(userEmail) {
        return new Promise(async (resolve, reject) => {
            try {
                // Get active session
                const activeSession = await this.getActiveSession(userEmail);
                if (!activeSession) {
                    reject(new Error('No active session found for this user'));
                    return;
                }

                const clockOutTime = new Date().toISOString();
                const clockInTime = new Date(activeSession.clock_in_time);
                const clockOutTimeObj = new Date(clockOutTime);
                const totalHours = (clockOutTimeObj - clockInTime) / (1000 * 60 * 60); // Convert to hours

                // Update time record
                this.db.run(`
                    UPDATE time_records 
                    SET clock_out_time = ?, total_hours = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [clockOutTime, totalHours.toFixed(2), activeSession.time_record_id], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        // Remove active session
                        this.db.run('DELETE FROM active_sessions WHERE id = ?', [activeSession.id], function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve({
                                    timeRecordId: activeSession.time_record_id,
                                    clockInTime: activeSession.clock_in_time,
                                    clockOutTime,
                                    totalHours: totalHours.toFixed(2),
                                    userEmail
                                });
                            }
                        });
                    }
                });
            } catch (error) {
                reject(error);
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