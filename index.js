
require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ==========================================
// 1. БАЗА ДАНИХ
// ==========================================


const db = new Database('kindergarten.db');

db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

function initializeDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS parents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fullName TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            relationNote TEXT
        );

        CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fullName TEXT NOT NULL,
            position TEXT NOT NULL
                CHECK (position IN (
                    'manager', 'educator', 'assistant', 'teacher'
                )),
            salaryRate INTEGER
                CHECK (salaryRate IS NULL OR salaryRate >= 0)
        );

        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL
                CHECK (type IN ('base', 'specialized')),
            rent INTEGER NOT NULL DEFAULT 50000
                CHECK (rent >= 0)
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            login TEXT NOT NULL UNIQUE,
            passwordHash TEXT NOT NULL,
            role TEXT NOT NULL
                CHECK (role IN (
                    'admin', 'manager', 'parent', 'teacher'
                )),
            parentId INTEGER,
            employeeId INTEGER,
            FOREIGN KEY (parentId) REFERENCES parents(id),
            FOREIGN KEY (employeeId) REFERENCES employees(id),
            CHECK (
                (role = 'parent' AND parentId IS NOT NULL
                    AND employeeId IS NULL)
                OR
                (role = 'teacher' AND employeeId IS NOT NULL
                    AND parentId IS NULL)
                OR
                (role IN ('admin', 'manager')
                    AND parentId IS NULL
                    AND employeeId IS NULL)
            )
        );

        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            ageCategory INTEGER NOT NULL
                CHECK (ageCategory BETWEEN 2 AND 5),
            capacity INTEGER NOT NULL DEFAULT 20
                CHECK (capacity BETWEEN 1 AND 20),
            roomId INTEGER UNIQUE,
            educatorId INTEGER,
            assistantId INTEGER,
            FOREIGN KEY (roomId) REFERENCES rooms(id),
            FOREIGN KEY (educatorId) REFERENCES employees(id),
            FOREIGN KEY (assistantId) REFERENCES employees(id),
            CHECK (
                educatorId IS NULL OR assistantId IS NULL
                OR educatorId <> assistantId
            )
        );

        CREATE TABLE IF NOT EXISTS children (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fullName TEXT NOT NULL,
            birthDate TEXT NOT NULL,
            parentId INTEGER NOT NULL,
            groupId INTEGER,
            discountPercent INTEGER NOT NULL DEFAULT 0
                CHECK (discountPercent IN (0, 10, 20, 30)),
            paymentPlan TEXT NOT NULL DEFAULT 'monthly'
                CHECK (paymentPlan IN ('monthly', 'yearly')),
            notes TEXT,
            isActive INTEGER NOT NULL DEFAULT 1
                CHECK (isActive IN (0, 1)),
            FOREIGN KEY (parentId) REFERENCES parents(id),
            FOREIGN KEY (groupId) REFERENCES groups(id),
            CHECK (isActive = 1 OR groupId IS NULL)
        );

        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            teacherId INTEGER,
            roomId INTEGER,
            FOREIGN KEY (teacherId) REFERENCES employees(id),
            FOREIGN KEY (roomId) REFERENCES rooms(id)
        );

        CREATE TABLE IF NOT EXISTS schedule_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            groupId INTEGER NOT NULL,
            activityId INTEGER NOT NULL,
            teacherId INTEGER NOT NULL,
            roomId INTEGER NOT NULL,
            dayOfWeek INTEGER NOT NULL
                CHECK (dayOfWeek BETWEEN 0 AND 4),
            startTime TEXT NOT NULL,
            durationMin INTEGER NOT NULL
                CHECK (durationMin > 0),
            FOREIGN KEY (groupId) REFERENCES groups(id),
            FOREIGN KEY (activityId) REFERENCES activities(id),
            FOREIGN KEY (teacherId) REFERENCES employees(id),
            FOREIGN KEY (roomId) REFERENCES rooms(id),
            UNIQUE (groupId, dayOfWeek, startTime),
            UNIQUE (teacherId, dayOfWeek, startTime),
            UNIQUE (roomId, dayOfWeek, startTime)
        );

        CREATE TRIGGER IF NOT EXISTS check_group_capacity_insert
        BEFORE INSERT ON children
        WHEN NEW.groupId IS NOT NULL AND NEW.isActive = 1
        BEGIN
        SELECT RAISE(ABORT, 'Group capacity exceeded')
            WHERE (
                SELECT COUNT(*)
                FROM children
                WHERE groupId = NEW.groupId AND isActive = 1
            ) >= (
                SELECT capacity FROM groups WHERE id = NEW.groupId
            );
        END;

        CREATE TRIGGER IF NOT EXISTS check_group_capacity_update
        BEFORE UPDATE OF groupId, isActive ON children
            WHEN NEW.groupId IS NOT NULL
            AND NEW.isActive = 1
            AND (
            OLD.groupId IS NOT NEW.groupId
            OR OLD.isActive <> NEW.isActive
            )
        BEGIN
        SELECT RAISE(ABORT, 'Group capacity exceeded')
            WHERE (
                SELECT COUNT(*)
                FROM children
                WHERE groupId = NEW.groupId
                  AND isActive = 1
                  AND id <> OLD.id
            ) >= (
                SELECT capacity FROM groups WHERE id = NEW.groupId
            );
        END;

        CREATE TRIGGER IF NOT EXISTS check_group_capacity_change
        BEFORE UPDATE OF capacity ON groups
            WHEN NEW.capacity < (
            SELECT COUNT(*)
            FROM children
            WHERE groupId = OLD.id AND isActive = 1
            )
        BEGIN
        SELECT RAISE(
                       ABORT,
                       'Group capacity below current enrollment'
               );
        END;
    `);

    console.log('SQLite tables initialized');
}

initializeDatabase();


function seedDatabase() {
    const seed = db.transaction(() => {
        const activities = [
            'Музика',
            'Англійська',
            'Фізкультура',
            'Вільна боротьба',
            'Шахи'
        ];

        const insertActivity = db.prepare(`
            INSERT OR IGNORE INTO activities (name)
            VALUES (?)
        `);

        for (const name of activities) {
            insertActivity.run(name);
        }

        const existingAdmin = db.prepare(`
            SELECT id FROM users WHERE login = ?
        `).get('admin');

        if (!existingAdmin) {
            const adminPassword = process.env.ADMIN_PASSWORD;

            if (!adminPassword || adminPassword.length < 12) {
                throw new Error(
                    'Set ADMIN_PASSWORD (at least 12 characters) in .env'
                );
            }

            const passwordHash = bcrypt.hashSync(adminPassword, 12);

            db.prepare(`
                INSERT INTO users (login, passwordHash, role)
                VALUES (?, ?, ?)
            `).run('admin', passwordHash, 'admin');

            console.log('Initial admin created');
        }
    });

    seed();
    console.log('Seed completed');
}

seedDatabase();




// ==========================================
// 2. АВТОРИЗАЦІЯ
// ==========================================

// Тут будуть реєстрація, вхід і JWT.

// ==========================================
// 3. БАТЬКИ ТА ПРАЦІВНИКИ
// ==========================================

// Тут будуть операції CRUD.

// ==========================================
// 4. ДІТИ ТА ГРУПИ
// ==========================================

// Тут будуть операції CRUD.

// ==========================================
// 5. КІМНАТИ ТА ЗАНЯТТЯ
// ==========================================

// Тут будуть операції CRUD.

// ==========================================
// 6. РАХУНКИ ТА ПЛАТЕЖІ
// ==========================================

// Тут будуть фінансові операції.


// ==========================================
// 7. ОБРОБКА ПОМИЛОК
// ==========================================
// Обробники помилок розміщені після маршрутів API.

// ==========================================
// 8. ПЕРЕВІРКА РОБОТИ API
// ==========================================

app.get('/api/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();

        res.status(200).json({
            status: 'ok',
            database: 'connected',
            message: 'Kindergarten API працює'
        });
    } catch (error) {
        console.error('Database health check failed:', error);

        res.status(503).json({
            error: 'Database unavailable'
        });
    }
});

// ==========================================
// 404 - НЕІСНУЮЧИЙ МАРШРУТ
// ==========================================

app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found'
    });
});

// ==========================================
// 500 - ГЛОБАЛЬНА ОБРОБКА ПОМИЛОК
// ==========================================

app.use((err, req, res, next) => {
    console.error('Server error:', err);

    // Некоректний JSON у тілі запиту
    if (err instanceof SyntaxError &&
        err.status === 400 &&
        'body' in err) {

        return res.status(400).json({
            error: 'Invalid JSON body'
        });
    }

    // Інші непередбачені помилки
    return res.status(500).json({
        error: 'Internal server error'
    });
});

// ==========================================
// 9. ЗАПУСК СЕРВЕРА
// ==========================================

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});