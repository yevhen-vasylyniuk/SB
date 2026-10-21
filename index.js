
require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Тарифи й ставки з ТЗ (суми в цілих гривнях). Редагування через API це бонус.
const CONFIG = {
    BASE_TUITION_MONTH: 15000,
    MONTHS_IN_YEAR: 12,
    YEARLY_PLAN_DISCOUNT_PERCENT: 12,
    ALLOWED_DISCOUNT_PERCENTS: [0, 10, 20, 30],
    MEAL_PER_DAY: { 2: 300, 3: 400, 4: 500, 5: 600 },
    WORK_DAYS_PER_MONTH: 20,
    GROUP_MAX_CHILDREN: 20,
    SALARY_BASE_CHILDREN: 12,
    EDUCATOR_RATE_BASE: 2000,
    EDUCATOR_RATE_OVER: 5000,
    ASSISTANT_BASE_SALARY: 20000,
    ASSISTANT_EXTRA_PER_CHILD: 3000,
    MANAGER_SALARY: 80000,
    TEACHER_SALARY: 40000,
    ROOM_RENT: 50000
};

app.use(express.json());

// ==========================================
// 1. БАЗА ДАНИХ
// ==========================================


const db = new Database('kindergarten.db');

db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');


function migrateDatabase() {
    const columns = db.prepare(`
        PRAGMA table_info(groups)
    `).all();

    const hasCapacity = columns.some(
        column => column.name === 'capacity'
    );

    if (!hasCapacity) {
        console.log('Migrating database: adding groups.capacity');

        db.exec(`
            ALTER TABLE groups
            ADD COLUMN capacity INTEGER NOT NULL DEFAULT 20
            CHECK (capacity BETWEEN 1 AND 20);
        `);

        console.log('Migration completed: groups.capacity added');
    } else {
        console.log('Database schema is up to date');
    }
}

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
    `);

    migrateDatabase();

    db.exec(`
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

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('Set JWT_SECRET (at least 32 characters) in .env');
}

app.post('/auth/login', (req, res) => {
    const { login, password } = req.body || {};

    if (
        typeof login !== 'string' ||
        !login.trim() ||
        typeof password !== 'string' ||
        !password
    ) {
        return res.status(400).json({
            error: 'Вкажіть логін і пароль'
        });
    }

    const user = db.prepare(`
        SELECT id, login, passwordHash, role
        FROM users
        WHERE login = ?
    `).get(login.trim());

    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        return res.status(401).json({
            error: 'Невірний логін або пароль'
        });
    }

    const token = jwt.sign(
        {
            userId: user.id,
            role: user.role
        },
        JWT_SECRET,
        { expiresIn: '8h' }
    );

    return res.status(200).json({
        token,
        tokenType: 'Bearer',
        expiresIn: 28800,
        user: {
            id: user.id,
            login: user.login,
            role: user.role
        }
    });
});

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    if (typeof authHeader !== 'string') {
        return res.status(401).json({
            error: 'Потрібна авторизація'
        });
    }

    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);

    if (!match) {
        return res.status(401).json({
            error: 'Невірний формат токена'
        });
    }

    try {
        const decoded = jwt.verify(match[1], JWT_SECRET, {
            algorithms: ['HS256']
        });

        if (
            !decoded ||
            !Number.isInteger(decoded.userId) ||
            !['admin', 'manager', 'parent', 'teacher'].includes(decoded.role)
        ) {
            return res.status(401).json({
                error: 'Недійсний токен'
            });
        }

        const user = db.prepare(`
            SELECT id, login, role, parentId, employeeId
            FROM users
            WHERE id = ?
        `).get(decoded.userId);

        if (!user || user.role !== decoded.role) {
            return res.status(401).json({
                error: 'Користувача не знайдено або роль змінена'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        return res.status(401).json({
            error: 'Недійсний або прострочений токен'
        });
    }
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'Потрібна авторизація'
            });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                error: 'Недостатньо прав доступу'
            });
        }

        next();
    };
}

app.post('/users', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const data = req.body;

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({
            error: 'Некоректні дані користувача'
        });
    }

    const { login, password, role, parentId, employeeId } = data;
    const allowedRoles = ['admin', 'manager', 'parent', 'teacher'];

    // Перевірка дозволених полів
    const allowedFields = ['login', 'password', 'role', 'parentId', 'employeeId'];

    if (Object.keys(data).some(field => !allowedFields.includes(field))) {
        return res.status(400).json({
            error: 'Передано невідомі поля'
        });
    }

    // Перевірка логіна
    if (
        typeof login !== 'string' ||
        !login.trim() ||
        login !== login.trim()
    ) {
        return res.status(400).json({
            error: 'Вкажіть коректний логін'
        });
    }

    // Перевірка пароля
    if (typeof password !== 'string' || password.length < 12) {
        return res.status(400).json({
            error: 'Пароль повинен містити щонайменше 12 символів'
        });
    }

    // Перевірка ролі
    if (!allowedRoles.includes(role)) {
        return res.status(400).json({
            error: 'Недопустима роль користувача'
        });
    }

    // Менеджер може створювати тільки батьків
    if (req.user.role === 'manager' && role !== 'parent') {
        return res.status(403).json({
            error: 'Менеджер може створювати лише користувачів із роллю parent'
        });
    }

    const normalizedParentId = parentId == null ? null : parentId;
    const normalizedEmployeeId = employeeId == null ? null : employeeId;

    // Перевірка зв'язків відповідно до ролі
    if (role === 'parent') {
        if (
            !Number.isInteger(normalizedParentId) ||
            normalizedParentId <= 0 ||
            normalizedEmployeeId !== null
        ) {
            return res.status(400).json({
                error: 'Для parent потрібен коректний parentId'
            });
        }

        const parent = db.prepare(
            'SELECT id FROM parents WHERE id = ?'
        ).get(normalizedParentId);

        if (!parent) {
            return res.status(404).json({
                error: 'Батька не знайдено'
            });
        }
    } else if (role === 'teacher') {
        if (
            !Number.isInteger(normalizedEmployeeId) ||
            normalizedEmployeeId <= 0 ||
            normalizedParentId !== null
        ) {
            return res.status(400).json({
                error: 'Для teacher потрібен коректний employeeId'
            });
        }

        const employee = db.prepare(
            'SELECT id, position FROM employees WHERE id = ?'
        ).get(normalizedEmployeeId);

        if (!employee) {
            return res.status(404).json({
                error: 'Працівника не знайдено'
            });
        }

        if (employee.position !== 'teacher') {
            return res.status(400).json({
                error: 'Працівник повинен мати посаду teacher'
            });
        }
    } else if (
        normalizedParentId !== null ||
        normalizedEmployeeId !== null
    ) {
        return res.status(400).json({
            error: 'Для admin і manager зв’язки parentId та employeeId заборонені'
        });
    }

    // Перевірка унікальності логіна
    const existingUser = db.prepare(
        'SELECT id FROM users WHERE login = ?'
    ).get(login);

    if (existingUser) {
        return res.status(409).json({
            error: 'Користувач із таким логіном уже існує'
        });
    }

    const passwordHash = bcrypt.hashSync(password, 12);

    try {
        const result = db.prepare(`
            INSERT INTO users (login, passwordHash, role, parentId, employeeId)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            login,
            passwordHash,
            role,
            normalizedParentId,
            normalizedEmployeeId
        );

        return res.status(201).json({
            id: Number(result.lastInsertRowid),
            login,
            role,
            parentId: normalizedParentId,
            employeeId: normalizedEmployeeId
        });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'Користувач із таким логіном уже існує'
            });
        }

        console.error('User creation failed:', error);

        return res.status(500).json({
            error: 'Не вдалося створити користувача'
        });
    }
});
// ==========================================
// 3. БАТЬКИ ТА ПРАЦІВНИКИ
// ==========================================



function validateParent(data, isUpdate = false) {
    const allowedFields = ['fullName', 'phone', 'email', 'relationNote'];

    for (const field of Object.keys(data)) {
        if (!allowedFields.includes(field)) {
            return `Невідоме поле: ${field}`;
        }
    }

    if (!isUpdate || data.fullName !== undefined) {
        if (typeof data.fullName !== 'string' || data.fullName.trim() === '') {
            return 'Вкажіть коректне ПІБ батька';
        }
    }

    for (const field of ['phone', 'email', 'relationNote']) {
        if (data[field] !== undefined &&
            data[field] !== null &&
            typeof data[field] !== 'string') {
            return `Некоректне поле: ${field}`;
        }
    }

    return null;
}


function getParentId(req) {
    const rawId = req.params.id;

    if (!/^[1-9]\d*$/.test(rawId)) {
        return null;
    }

    const id = Number(rawId);

    if (!Number.isSafeInteger(id)) {
        return null;
    }

    return id;
}


// GET /parents - отримати всіх батьків
app.get('/parents', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const parents = db.prepare(
        'SELECT * FROM parents'
    ).all();

    res.status(200).json(parents);
});

// GET /parents/:id - отримати батька за ID
app.get('/parents/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = getParentId(req);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID батька' });
    }

    const parent = db.prepare(
        'SELECT * FROM parents WHERE id = ?'
    ).get(id);

    if (!parent) {
        return res.status(404).json({ error: 'Батька не знайдено' });
    }

    res.status(200).json(parent);
});

// POST /parents - створити батька
app.post('/parents', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const data = req.body;

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'Некоректне тіло запиту' });
    }

    const error = validateParent(data);

    if (error) {
        return res.status(400).json({ error });
    }

    const { fullName, phone, email, relationNote } = data;

    const result = db.prepare(`
        INSERT INTO parents (fullName, phone, email, relationNote)
        VALUES (?, ?, ?, ?)
    `).run(
        fullName.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        relationNote?.trim() || null
    );

    const parent = db.prepare(
        'SELECT * FROM parents WHERE id = ?'
    ).get(result.lastInsertRowid);

    res.status(201).json(parent);
});

// PATCH /parents/:id - оновити батька
app.patch('/parents/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = getParentId(req);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID батька' });
    }

    const parent = db.prepare(
        'SELECT * FROM parents WHERE id = ?'
    ).get(id);

    if (!parent) {
        return res.status(404).json({ error: 'Батька не знайдено' });
    }

    const data = req.body;

    if (!data || typeof data !== 'object' ||
        Array.isArray(data) || Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'Немає даних для оновлення' });
    }

    const error = validateParent(data, true);

    if (error) {
        return res.status(400).json({ error });
    }

    const fullName = data.fullName !== undefined
        ? data.fullName.trim()
        : parent.fullName;

    const phone = data.phone !== undefined
        ? data.phone?.trim() || null
        : parent.phone;

    const email = data.email !== undefined
        ? data.email?.trim() || null
        : parent.email;

    const relationNote = data.relationNote !== undefined
        ? data.relationNote?.trim() || null
        : parent.relationNote;

    db.prepare(`
        UPDATE parents
        SET fullName = ?, phone = ?, email = ?, relationNote = ?
        WHERE id = ?
    `).run(fullName, phone, email, relationNote, id);

    const updatedParent = db.prepare(
        'SELECT * FROM parents WHERE id = ?'
    ).get(id);

    res.status(200).json(updatedParent);
});

// DELETE /parents/:id - видалити батька
app.delete('/parents/:id', authenticate, requireRole('admin'), (req, res) => {
    const id = getParentId(req);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID батька' });
    }

    const parent = db.prepare(
        'SELECT * FROM parents WHERE id = ?'
    ).get(id);

    if (!parent) {
        return res.status(404).json({ error: 'Батька не знайдено' });
    }

    const hasChildren = db.prepare(
        'SELECT id FROM children WHERE parentId = ? LIMIT 1'
    ).get(id);

    const hasAccount = db.prepare(
        'SELECT id FROM users WHERE parentId = ? LIMIT 1'
    ).get(id);

    if (hasChildren || hasAccount) {
        return res.status(409).json({
            error: 'Неможливо видалити батька, оскільки існують пов’язані записи'
        });
    }



    try {
        db.prepare(
            'DELETE FROM parents WHERE id = ?'
        ).run(id);
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
            return res.status(409).json({
                error: 'Батько має пов’язані записи'
            });
        }

        throw error;
    }

    res.status(204).send();


});


function validateEmployee(data, isUpdate = false) {
    const allowedFields = ['fullName', 'position', 'salaryRate'];
    const positions = ['manager', 'educator', 'assistant', 'teacher'];

    for (const field of Object.keys(data)) {
        if (!allowedFields.includes(field)) {
            return `Невідоме поле: ${field}`;
        }
    }

    if (!isUpdate || data.fullName !== undefined) {
        if (typeof data.fullName !== 'string' || data.fullName.trim() === '') {
            return 'Вкажіть коректне ПІБ працівника';
        }
    }

    if (!isUpdate || data.position !== undefined) {
        if (!positions.includes(data.position)) {
            return 'Некоректна посада працівника';
        }
    }

    if (data.salaryRate !== undefined &&
        data.salaryRate !== null &&
        (!Number.isSafeInteger(data.salaryRate) || data.salaryRate < 0)) {
        return 'Зарплата повинна бути невід’ємним цілим числом';
    }

    return null;
}


function getEmployeeId(req) {
    const rawId = req.params.id;

    if (!/^[1-9]\d*$/.test(rawId)) {
        return null;
    }

    const id = Number(rawId);

    if (!Number.isSafeInteger(id)) {
        return null;
    }

    return id;
}


function validateEmployeeRelations(id, position) {
    if (position === 'manager') {
        const existing = db.prepare(
            'SELECT id FROM employees WHERE position = ? AND id != ? LIMIT 1'
        ).get('manager', id ?? 0);

        if (existing) {
            return 'У садку може бути лише один менеджер';
        }
    }

    if (id === null) {
        return null;
    }

    const educator = db.prepare(
        'SELECT id FROM groups WHERE educatorId = ? LIMIT 1'
    ).get(id);

    if (educator && position !== 'educator') {
        return 'Працівник закріплений як вихователь групи';
    }

    const assistant = db.prepare(
        'SELECT id FROM groups WHERE assistantId = ? LIMIT 1'
    ).get(id);

    if (assistant && position !== 'assistant') {
        return 'Працівник закріплений як помічник вихователя';
    }

    const activity = db.prepare(
        'SELECT id FROM activities WHERE teacherId = ? LIMIT 1'
    ).get(id);

    const schedule = db.prepare(
        'SELECT id FROM schedule_slots WHERE teacherId = ? LIMIT 1'
    ).get(id);

    const account = db.prepare(
        'SELECT id FROM users WHERE employeeId = ? AND role = ? LIMIT 1'
    ).get(id, 'teacher');

    if ((activity || schedule || account) && position !== 'teacher') {
        return 'Працівник закріплений як викладач';
    }

    return null;
}


// GET /employees - отримати всіх працівників
app.get('/employees', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const employees = db.prepare(
        'SELECT * FROM employees'
    ).all();

    res.status(200).json(employees);
});

// GET /employees/:id - отримати працівника за ID
app.get('/employees/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = getEmployeeId(req);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID працівника' });
    }

    const employee = db.prepare(
        'SELECT * FROM employees WHERE id = ?'
    ).get(id);

    if (!employee) {
        return res.status(404).json({ error: 'Працівника не знайдено' });
    }

    res.status(200).json(employee);
});

// POST /employees - створити працівника
app.post('/employees', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const data = req.body;

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'Некоректне тіло запиту' });
    }

    const error = validateEmployee(data);

    if (error) {
        return res.status(400).json({ error });
    }


    const relationError = validateEmployeeRelations(null, data.position);

    if (relationError) {
        return res.status(409).json({ error: relationError });
    }


    const { fullName, position, salaryRate } = data;

    const result = db.prepare(`
        INSERT INTO employees (fullName, position, salaryRate)
        VALUES (?, ?, ?)
    `).run(
        fullName.trim(),
        position,
        salaryRate ?? null
    );

    const employee = db.prepare(
        'SELECT * FROM employees WHERE id = ?'
    ).get(result.lastInsertRowid);

    res.status(201).json(employee);
});

// PATCH /employees/:id - оновити працівника
app.patch('/employees/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = getEmployeeId(req);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID працівника' });
    }

    const employee = db.prepare(
        'SELECT * FROM employees WHERE id = ?'
    ).get(id);

    if (!employee) {
        return res.status(404).json({ error: 'Працівника не знайдено' });
    }

    const data = req.body;

    if (!data || typeof data !== 'object' ||
        Array.isArray(data) || Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'Немає даних для оновлення' });
    }

    const error = validateEmployee(data, true);

    if (error) {
        return res.status(400).json({ error });
    }

    const fullName = data.fullName !== undefined
        ? data.fullName.trim()
        : employee.fullName;

    const position = data.position !== undefined
        ? data.position
        : employee.position;

    const salaryRate = data.salaryRate !== undefined
        ? data.salaryRate
        : employee.salaryRate;


    const relationError = validateEmployeeRelations(id, position);

    if (relationError) {
        return res.status(409).json({ error: relationError });
    }


    db.prepare(`
        UPDATE employees
        SET fullName = ?, position = ?, salaryRate = ?
        WHERE id = ?
    `).run(fullName, position, salaryRate, id);

    const updatedEmployee = db.prepare(
        'SELECT * FROM employees WHERE id = ?'
    ).get(id);

    res.status(200).json(updatedEmployee);
});

// DELETE /employees/:id - видалити працівника
app.delete('/employees/:id', authenticate, requireRole('admin'), (req, res) => {
    const id = getEmployeeId(req);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID працівника' });
    }

    const employee = db.prepare(
        'SELECT * FROM employees WHERE id = ?'
    ).get(id);

    if (!employee) {
        return res.status(404).json({ error: 'Працівника не знайдено' });
    }

    const inGroups = db.prepare(`
        SELECT id FROM groups
        WHERE educatorId = ? OR assistantId = ?
        LIMIT 1
    `).get(id, id);

    const inActivities = db.prepare(
        'SELECT id FROM activities WHERE teacherId = ? LIMIT 1'
    ).get(id);

    const inSchedules = db.prepare(
        'SELECT id FROM schedule_slots WHERE teacherId = ? LIMIT 1'
    ).get(id);

    const hasAccount = db.prepare(
        'SELECT id FROM users WHERE employeeId = ? LIMIT 1'
    ).get(id);

    if (inGroups || inActivities || inSchedules || hasAccount) {
        return res.status(409).json({
            error: 'Неможливо видалити працівника, оскільки існують пов’язані записи'
        });
    }


    try {
        db.prepare(
            'DELETE FROM employees WHERE id = ?'
        ).run(id);
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
            return res.status(409).json({
                error: 'Працівник має пов’язані записи'
            });
        }

        throw error;
    }

    res.status(204).send();

});




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

// Чисті функції розрахунку: без доступу до БД, лише цілі гривні.
// Контракт описаний у PROJECT_TASKS.md. Некоректний вхід дає RangeError,
// тому маршрути мають перевіряти дані до виклику.

// calcTuition({ discountPercent, paymentPlan }) -> { perMonth, perYear }
// perMonth це місячний еквівалент (для плану yearly це 1/12 річної суми),
// саме він іде в розрахунок прибутку.
function calcTuition(child) {
    if (!child || typeof child !== 'object') {
        throw new RangeError('calcTuition: очікується об\'єкт дитини');
    }

    const { discountPercent, paymentPlan } = child;

    if (!CONFIG.ALLOWED_DISCOUNT_PERCENTS.includes(discountPercent)) {
        throw new RangeError('calcTuition: некоректна знижка');
    }

    if (paymentPlan !== 'monthly' && paymentPlan !== 'yearly') {
        throw new RangeError('calcTuition: некоректний план оплати');
    }

    const yearBase = Math.round(
        CONFIG.BASE_TUITION_MONTH * CONFIG.MONTHS_IN_YEAR *
        (100 - discountPercent) / 100
    );

    const perYear = paymentPlan === 'yearly'
        ? Math.round(yearBase * (100 - CONFIG.YEARLY_PLAN_DISCOUNT_PERCENT) / 100)
        : yearBase;

    return {
        perMonth: Math.round(perYear / CONFIG.MONTHS_IN_YEAR),
        perYear
    };
}

// calcMeals(age) -> { perDay, perMonth, perYear }
// age визначає викликач: group.ageCategory, а без групи повний вік за birthDate.
// Пільги на харчування не діють, у прибуток садка воно не входить.
function calcMeals(age) {
    if (!Number.isInteger(age) || CONFIG.MEAL_PER_DAY[age] === undefined) {
        throw new RangeError('calcMeals: вік має бути цілим числом від 2 до 5');
    }

    const perDay = CONFIG.MEAL_PER_DAY[age];
    const perMonth = perDay * CONFIG.WORK_DAYS_PER_MONTH;

    return {
        perDay,
        perMonth,
        perYear: perMonth * CONFIG.MONTHS_IN_YEAR
    };
}

function assertKidsCount(kidsCount, fnName) {
    if (
        !Number.isInteger(kidsCount) ||
        kidsCount < 0 ||
        kidsCount > CONFIG.GROUP_MAX_CHILDREN
    ) {
        throw new RangeError(
            `${fnName}: кількість дітей має бути цілим числом від 0 до ${CONFIG.GROUP_MAX_CHILDREN}`
        );
    }
}

// calcEducatorSalary(kidsCount) -> зарплата вихователя за місяць
// 2 000 за кожну з перших 12 дітей, 5 000 за кожну з 13-ї по 20-ту.
function calcEducatorSalary(kidsCount) {
    assertKidsCount(kidsCount, 'calcEducatorSalary');

    const base = Math.min(kidsCount, CONFIG.SALARY_BASE_CHILDREN);
    const over = Math.max(0, kidsCount - CONFIG.SALARY_BASE_CHILDREN);

    return base * CONFIG.EDUCATOR_RATE_BASE + over * CONFIG.EDUCATOR_RATE_OVER;
}

// calcAssistantSalary(kidsCount) -> зарплата помічника за місяць
// 20 000 плюс 3 000 за кожну дитину з 13-ї по 20-ту.
function calcAssistantSalary(kidsCount) {
    assertKidsCount(kidsCount, 'calcAssistantSalary');

    const over = Math.max(0, kidsCount - CONFIG.SALARY_BASE_CHILDREN);

    return CONFIG.ASSISTANT_BASE_SALARY + over * CONFIG.ASSISTANT_EXTRA_PER_CHILD;
}

// Далі тут буде GET /children/:id/invoice (після злиття дітей і груп).


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