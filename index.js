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

        CREATE TABLE IF NOT EXISTS child_parents (
            childId INTEGER NOT NULL,
            parentId INTEGER NOT NULL,
            PRIMARY KEY (childId, parentId),
            FOREIGN KEY (childId) REFERENCES children(id) ON DELETE CASCADE,
            FOREIGN KEY (parentId) REFERENCES parents(id)
        );

        CREATE INDEX IF NOT EXISTS idx_child_parents_parent
            ON child_parents(parentId);

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

    // Основний батько кожної дитини завжди має запис у child_parents
    // (для баз, створених до появи опікунів); повторний запуск безпечний.
    db.exec(`
        INSERT OR IGNORE INTO child_parents (childId, parentId)
            SELECT id, parentId FROM children;
    `);

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

// GET /users - список акаунтів (лише admin); passwordHash ніколи не повертається
app.get('/users', authenticate, requireRole('admin'), (req, res) => {
    const users = db.prepare(`
        SELECT id, login, role, parentId, employeeId
        FROM users
        ORDER BY id
    `).all();

    return res.status(200).json(users);
});

// DELETE /users/:id - видалення акаунта (лише admin за ТЗ);
// адміністратор не може видалити сам себе
app.delete('/users/:id', authenticate, requireRole('admin'), (req, res) => {
    const rawId = req.params.id;
    const id = Number(rawId);

    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id)) {
        return res.status(400).json({
            error: 'Некоректний ID користувача'
        });
    }

    if (id === req.user.id) {
        return res.status(409).json({
            error: 'Не можна видалити власний акаунт'
        });
    }

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);

    if (!user) {
        return res.status(404).json({
            error: 'Користувача не знайдено'
        });
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    return res.status(204).send();
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
const ENFORCE_AGE_MATCH = true;
const MAX_GROUPS = 30; // максимум груп у садку
const MIN_CHILD_AGE = 2; // допустимий вік дитини (повних років)
const MAX_CHILD_AGE = 5;
const MAX_GUARDIANS = 9; // максимум додаткових опікунів

// Таблиця child_parents (опікуни) створюється в блоці 1, у initializeDatabase().

// ---------- Допоміжні функції ----------

function parseId(raw) {
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
        return null;
    }

    const id = Number(raw);

    return Number.isSafeInteger(id) ? id : null;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function toBit(value) {
    return value === true || value === 1 ? 1 : 0;
}

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const date = new Date(`${value}T00:00:00Z`);

    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
}

function calcAge(birthDate, now = new Date()) {
    const [year, month, day] = birthDate.split('-').map(Number);

    let age = now.getUTCFullYear() - year;
    const monthDiff = now.getUTCMonth() + 1 - month;

    if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < day)) {
        age--;
    }

    return age;
}

function handleDbError(res, error) {
    const message = String(error.message || '');

    if (message.includes('Group capacity exceeded')) {
        return res.status(409).json({ error: 'Група заповнена' });
    }

    if (message.includes('Group capacity below current enrollment')) {
        return res.status(409).json({
            error: 'Місткість не може бути меншою за кількість дітей у групі',
        });
    }

    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({
            error: 'Запис з такими унікальними даними вже існує',
        });
    }

    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return res.status(409).json({ error: 'Порушено зв’язок між записами' });
    }

    throw error;
}

// Групи, до яких має відношення викладач/вихователь
function getTeacherGroupIds(employeeId) {
    return db
        .prepare(
            `
        SELECT id AS groupId FROM groups
        WHERE educatorId = ? OR assistantId = ?
        UNION
        SELECT groupId FROM schedule_slots WHERE teacherId = ?
    `,
        )
        .all(employeeId, employeeId, employeeId)
        .map((row) => row.groupId);
}

function canViewGroup(user, groupId) {
    if (user.role === 'admin' || user.role === 'manager') {
        return true;
    }

    if (user.role === 'teacher') {
        return getTeacherGroupIds(user.employeeId).includes(groupId);
    }

    if (user.role === 'parent') {
        return Boolean(
            db
                .prepare(
                    `
            SELECT 1
            FROM children c
            JOIN child_parents cp ON cp.childId = c.id
            WHERE c.groupId = ? AND c.isActive = 1 AND cp.parentId = ?
            LIMIT 1
        `,
                )
                .get(groupId, user.parentId),
        );
    }

    return false;
}

function canViewChild(user, child) {
    if (user.role === 'admin' || user.role === 'manager') {
        return true;
    }

    if (user.role === 'parent') {
        return Boolean(
            db
                .prepare(
                    'SELECT 1 FROM child_parents WHERE childId = ? AND parentId = ?',
                )
                .get(child.id, user.parentId),
        );
    }

    if (user.role === 'teacher') {
        return (
            child.groupId !== null &&
            getTeacherGroupIds(user.employeeId).includes(child.groupId)
        );
    }

    return false;
}

// ---------- Серіалізація ----------

const GROUP_SELECT = `
    SELECT g.*,
           (SELECT COUNT(*) FROM children
             WHERE groupId = g.id AND isActive = 1) AS enrolled
    FROM groups g
`;

function serializeGroup(group, user) {
    if (user.role === 'parent') {
        // Батькам — лише базові дані групи
        return {
            id: group.id,
            name: group.name,
            ageCategory: group.ageCategory,
        };
    }

    return group;
}

const CHILD_SELECT = `
    SELECT c.*, g.name AS groupName
    FROM children c
    LEFT JOIN groups g ON g.id = c.groupId
`;

function serializeChild(child, user) {
    const parents = db
        .prepare(
            `
        SELECT p.id, p.fullName, p.phone, p.email, p.relationNote,
               (p.id = c.parentId) AS isPrimary
        FROM child_parents cp
        JOIN parents p ON p.id = cp.parentId
        JOIN children c ON c.id = cp.childId
        WHERE cp.childId = ?
        ORDER BY isPrimary DESC, p.id
    `,
        )
        .all(child.id)
        .map((parent) => ({ ...parent, isPrimary: parent.isPrimary === 1 }));

    // Батькам не показуємо контакти інших представників
    const visibleParents =
        user.role === 'parent'
            ? parents.map(({ id, fullName, relationNote, isPrimary }) => ({
                  id,
                  fullName,
                  relationNote,
                  isPrimary,
              }))
            : parents;

    const { groupName, ...rest } = child;

    return {
        ...rest,
        isActive: rest.isActive === 1,
        group: child.groupId ? { id: child.groupId, name: groupName } : null,
        parents: visibleParents,
    };
}

// ---------- Групи: валідація ----------

function validateGroupFields(data, isUpdate) {
    const allowed = [
        'name',
        'ageCategory',
        'capacity',
        'roomId',
        'educatorId',
        'assistantId',
    ];

    for (const field of Object.keys(data)) {
        if (!allowed.includes(field)) {
            return `Невідоме поле: ${field}`;
        }
    }

    if (!isUpdate || data.name !== undefined) {
        if (typeof data.name !== 'string' || data.name.trim() === '') {
            return 'Вкажіть коректну назву групи';
        }
    }

    if (!isUpdate || data.ageCategory !== undefined) {
        if (
            !Number.isSafeInteger(data.ageCategory) ||
            data.ageCategory < 2 ||
            data.ageCategory > 5
        ) {
            return 'Вікова категорія має бути цілим числом від 2 до 5';
        }
    }

    if (data.capacity !== undefined) {
        if (
            !Number.isSafeInteger(data.capacity) ||
            data.capacity < 1 ||
            data.capacity > 20
        ) {
            return 'Місткість має бути цілим числом від 1 до 20';
        }
    }

    for (const field of ['roomId', 'educatorId', 'assistantId']) {
        if (
            data[field] !== undefined &&
            data[field] !== null &&
            !isPositiveInt(data[field])
        ) {
            return `Некоректне поле: ${field}`;
        }
    }

    return null;
}

function checkGroupRelations(group, groupId) {
    if (group.roomId !== null) {
        const room = db
            .prepare('SELECT id FROM rooms WHERE id = ?')
            .get(group.roomId);

        if (!room) {
            return { status: 400, error: 'Кімнату не знайдено' };
        }

        const taken = db
            .prepare('SELECT id FROM groups WHERE roomId = ? AND id <> ?')
            .get(group.roomId, groupId ?? 0);

        if (taken) {
            return {
                status: 409,
                error: 'Кімната вже закріплена за іншою групою',
            };
        }
    }

    if (group.educatorId !== null) {
        const educator = db
            .prepare('SELECT position FROM employees WHERE id = ?')
            .get(group.educatorId);

        if (!educator || educator.position !== 'educator') {
            return {
                status: 400,
                error: 'Вихователь не знайдений або має іншу посаду',
            };
        }
    }

    if (group.assistantId !== null) {
        const assistant = db
            .prepare('SELECT position FROM employees WHERE id = ?')
            .get(group.assistantId);

        if (!assistant || assistant.position !== 'assistant') {
            return {
                status: 400,
                error: 'Помічник не знайдений або має іншу посаду',
            };
        }
    }

    return null;
}

// ---------- Групи: маршрути ----------

// GET /groups - адмін/менеджер: всі; викладач: свої; батько: групи своїх дітей
app.get('/groups', authenticate, (req, res) => {
    const { user } = req;
    const where = [];
    const params = [];

    if (user.role === 'teacher') {
        const ids = getTeacherGroupIds(user.employeeId);

        if (ids.length === 0) {
            return res.status(200).json([]);
        }

        where.push(`g.id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
    }

    if (user.role === 'parent') {
        where.push(`g.id IN (
            SELECT c.groupId
            FROM children c
            JOIN child_parents cp ON cp.childId = c.id
            WHERE cp.parentId = ? AND c.isActive = 1 AND c.groupId IS NOT NULL
        )`);
        params.push(user.parentId);
    }

    const sql = `${GROUP_SELECT} ${
        where.length ? `WHERE ${where.join(' AND ')}` : ''
    } ORDER BY g.name`;

    const groups = db.prepare(sql).all(...params);

    res.status(200).json(groups.map((group) => serializeGroup(group, user)));
});

// GET /groups/:id
app.get('/groups/:id', authenticate, (req, res) => {
    const id = parseId(req.params.id);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID групи' });
    }

    const group = db.prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id);

    if (!group || !canViewGroup(req.user, id)) {
        return res.status(404).json({ error: 'Групу не знайдено' });
    }

    res.status(200).json(serializeGroup(group, req.user));
});

// GET /groups/:id/children - діти групи (без доступу для батьків)
app.get(
    '/groups/:id/children',
    authenticate,
    requireRole('admin', 'manager', 'teacher'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID групи' });
        }

        const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(id);

        if (!group || !canViewGroup(req.user, id)) {
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        const children = db
            .prepare(
                `${CHILD_SELECT}
                 WHERE c.groupId = ? AND c.isActive = 1
                 ORDER BY c.fullName`,
            )
            .all(id);

        res.status(200).json(
            children.map((child) => serializeChild(child, req.user)),
        );
    },
);

// POST /groups
app.post('/groups', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const data = req.body;

    if (!isPlainObject(data)) {
        return res.status(400).json({ error: 'Некоректне тіло запиту' });
    }

    const error = validateGroupFields(data, false);

    if (error) {
        return res.status(400).json({ error });
    }

    const { total } = db.prepare('SELECT COUNT(*) AS total FROM groups').get();

    if (total >= MAX_GROUPS) {
        return res.status(409).json({
            error: `Досягнуто ліміт кількості груп (${MAX_GROUPS})`,
        });
    }

    const group = {
        name: data.name.trim(),
        ageCategory: data.ageCategory,
        capacity: data.capacity ?? 20,
        roomId: data.roomId ?? null,
        educatorId: data.educatorId ?? null,
        assistantId: data.assistantId ?? null,
    };

    const relationError = checkGroupRelations(group, null);

    if (relationError) {
        return res
            .status(relationError.status)
            .json({ error: relationError.error });
    }

    try {
        const result = db
            .prepare(
                `
            INSERT INTO groups
                (name, ageCategory, capacity, roomId, educatorId, assistantId)
            VALUES (?, ?, ?, ?, ?, ?)
        `,
            )
            .run(
                group.name,
                group.ageCategory,
                group.capacity,
                group.roomId,
                group.educatorId,
                group.assistantId,
            );

        const created = db
            .prepare(`${GROUP_SELECT} WHERE g.id = ?`)
            .get(result.lastInsertRowid);

        res.status(201).json(created);
    } catch (dbError) {
        return handleDbError(res, dbError);
    }
});

// PATCH /groups/:id
app.patch(
    '/groups/:id',
    authenticate,
    requireRole('admin', 'manager'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID групи' });
        }

        const existing = db
            .prepare('SELECT * FROM groups WHERE id = ?')
            .get(id);

        if (!existing) {
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        const data = req.body;

        if (!isPlainObject(data) || Object.keys(data).length === 0) {
            return res.status(400).json({ error: 'Немає даних для оновлення' });
        }

        const error = validateGroupFields(data, true);

        if (error) {
            return res.status(400).json({ error });
        }

        const group = {
            name: data.name !== undefined ? data.name.trim() : existing.name,
            ageCategory: data.ageCategory ?? existing.ageCategory,
            capacity: data.capacity ?? existing.capacity,
            roomId: data.roomId !== undefined ? data.roomId : existing.roomId,
            educatorId:
                data.educatorId !== undefined
                    ? data.educatorId
                    : existing.educatorId,
            assistantId:
                data.assistantId !== undefined
                    ? data.assistantId
                    : existing.assistantId,
        };

        const relationError = checkGroupRelations(group, id);

        if (relationError) {
            return res
                .status(relationError.status)
                .json({ error: relationError.error });
        }

        // Зміна вікової категорії не повинна ламати вже зараховані діти
        if (ENFORCE_AGE_MATCH && group.ageCategory !== existing.ageCategory) {
            const kids = db
                .prepare(
                    'SELECT birthDate FROM children WHERE groupId = ? AND isActive = 1',
                )
                .all(id);

            if (
                kids.some((kid) => calcAge(kid.birthDate) !== group.ageCategory)
            ) {
                return res.status(409).json({
                    error: 'У групі є діти, вік яких не відповідає новій віковій категорії',
                });
            }
        }

        try {
            db.prepare(
                `
            UPDATE groups
            SET name = ?, ageCategory = ?, capacity = ?,
                roomId = ?, educatorId = ?, assistantId = ?
            WHERE id = ?
        `,
            ).run(
                group.name,
                group.ageCategory,
                group.capacity,
                group.roomId,
                group.educatorId,
                group.assistantId,
                id,
            );

            const updated = db
                .prepare(`${GROUP_SELECT} WHERE g.id = ?`)
                .get(id);

            res.status(200).json(updated);
        } catch (dbError) {
            return handleDbError(res, dbError);
        }
    },
);

// DELETE /groups/:id
app.delete(
    '/groups/:id',
    authenticate,
    requireRole('admin'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID групи' });
        }

        const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(id);

        if (!group) {
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        const hasChildren = db
            .prepare('SELECT id FROM children WHERE groupId = ? LIMIT 1')
            .get(id);

        const hasSchedule = db
            .prepare('SELECT id FROM schedule_slots WHERE groupId = ? LIMIT 1')
            .get(id);

        if (hasChildren || hasSchedule) {
            return res.status(409).json({
                error: 'Неможливо видалити групу, оскільки існують пов’язані записи',
            });
        }

        try {
            db.prepare('DELETE FROM groups WHERE id = ?').run(id);
        } catch (dbError) {
            return handleDbError(res, dbError);
        }

        res.status(204).send();
    },
);

// ---------- Діти: валідація ----------

function validateChild(data, isUpdate) {
    const allowed = [
        'fullName',
        'birthDate',
        'groupId',
        'discountPercent',
        'paymentPlan',
        'notes',
        'isActive',
    ];

    if (!isUpdate) {
        allowed.push('parentId', 'guardianIds');
    }

    for (const field of Object.keys(data)) {
        if (!allowed.includes(field)) {
            return field === 'parentId' || field === 'guardianIds'
                ? 'Представників змінюйте через PUT /children/:id/parents'
                : `Невідоме поле: ${field}`;
        }
    }

    if (!isUpdate || data.fullName !== undefined) {
        if (typeof data.fullName !== 'string' || data.fullName.trim() === '') {
            return 'Вкажіть коректне ПІБ дитини';
        }
    }

    if (!isUpdate || data.birthDate !== undefined) {
        if (!isValidDateString(data.birthDate)) {
            return 'Дата народження має бути у форматі YYYY-MM-DD';
        }

        if (data.birthDate > new Date().toISOString().slice(0, 10)) {
            return 'Дата народження не може бути в майбутньому';
        }

        const age = calcAge(data.birthDate);

        if (age < MIN_CHILD_AGE || age > MAX_CHILD_AGE) {
            return `Вік дитини має бути від ${MIN_CHILD_AGE} до ${MAX_CHILD_AGE} років (зараз ${age})`;
        }
    }

    if (
        data.groupId !== undefined &&
        data.groupId !== null &&
        !isPositiveInt(data.groupId)
    ) {
        return 'Некоректний groupId';
    }

    if (
        data.discountPercent !== undefined &&
        ![0, 10, 20, 30].includes(data.discountPercent)
    ) {
        return 'Знижка має бути 0, 10, 20 або 30';
    }

    if (
        data.paymentPlan !== undefined &&
        !['monthly', 'yearly'].includes(data.paymentPlan)
    ) {
        return 'paymentPlan має бути monthly або yearly';
    }

    if (
        data.notes !== undefined &&
        data.notes !== null &&
        typeof data.notes !== 'string'
    ) {
        return 'Некоректне поле: notes';
    }

    if (
        data.isActive !== undefined &&
        ![true, false, 0, 1].includes(data.isActive)
    ) {
        return 'isActive має бути true або false';
    }

    return null;
}

// Основний представник (платник) і необов’язкові додаткові опікуни
function validateParentLinks(parentId, guardianIds) {
    if (!isPositiveInt(parentId)) {
        return {
            status: 400,
            error: 'parentId обов’язковий і має бути додатним цілим числом',
        };
    }

    const extra = guardianIds ?? [];

    if (!Array.isArray(extra) || extra.length > MAX_GUARDIANS) {
        return {
            status: 400,
            error: `guardianIds має бути масивом (до ${MAX_GUARDIANS} елементів)`,
        };
    }

    const all = [parentId, ...extra];

    if (!extra.every(isPositiveInt) || new Set(all).size !== all.length) {
        return {
            status: 400,
            error: 'guardianIds мають бути унікальними додатними цілими числами і не містити parentId',
        };
    }

    const { cnt } = db
        .prepare(
            `SELECT COUNT(*) AS cnt FROM parents
             WHERE id IN (${all.map(() => '?').join(',')})`,
        )
        .get(...all);

    if (cnt !== all.length) {
        return {
            status: 400,
            error: 'Одного або кількох представників не знайдено',
        };
    }

    return null;
}

// Перевірка призначення до групи: існування, вік, місткість
function checkGroupAssignment(
    groupId,
    birthDate,
    childId,
    { checkAge = true, checkCapacity = true } = {},
) {
    const group = db
        .prepare('SELECT id, ageCategory, capacity FROM groups WHERE id = ?')
        .get(groupId);

    if (!group) {
        return { status: 400, error: 'Групу не знайдено' };
    }

    if (checkAge && ENFORCE_AGE_MATCH) {
        const age = calcAge(birthDate);

        if (age !== group.ageCategory) {
            return {
                status: 409,
                error: `Вік дитини (${age}) не відповідає віковій категорії групи (${group.ageCategory})`,
            };
        }
    }

    if (checkCapacity) {
        const { cnt } = db
            .prepare(
                `SELECT COUNT(*) AS cnt FROM children
                 WHERE groupId = ? AND isActive = 1 AND id <> ?`,
            )
            .get(groupId, childId ?? 0);

        if (cnt >= group.capacity) {
            return { status: 409, error: 'Група заповнена' };
        }
    }

    return null;
}

// ---------- Діти: маршрути ----------

// GET /children?groupId=&isActive=
app.get('/children', authenticate, (req, res) => {
    const { user } = req;
    const where = [];
    const params = [];

    if (user.role === 'parent') {
        where.push(
            'c.id IN (SELECT childId FROM child_parents WHERE parentId = ?)',
        );
        params.push(user.parentId);
    }

    if (user.role === 'teacher') {
        const ids = getTeacherGroupIds(user.employeeId);

        if (ids.length === 0) {
            return res.status(200).json([]);
        }

        where.push(`c.groupId IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
    }

    if (req.query.groupId !== undefined) {
        const groupId = parseId(String(req.query.groupId));

        if (groupId === null) {
            return res.status(400).json({ error: 'Некоректний groupId' });
        }

        where.push('c.groupId = ?');
        params.push(groupId);
    }

    if (req.query.isActive !== undefined) {
        const value = String(req.query.isActive);

        if (!['0', '1', 'true', 'false'].includes(value)) {
            return res.status(400).json({ error: 'Некоректний isActive' });
        }

        where.push('c.isActive = ?');
        params.push(value === '1' || value === 'true' ? 1 : 0);
    }

    const sql = `${CHILD_SELECT} ${
        where.length ? `WHERE ${where.join(' AND ')}` : ''
    } ORDER BY c.fullName`;

    const children = db.prepare(sql).all(...params);

    res.status(200).json(children.map((child) => serializeChild(child, user)));
});

// GET /children/:id
app.get('/children/:id', authenticate, (req, res) => {
    const id = parseId(req.params.id);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID дитини' });
    }

    const child = db.prepare(`${CHILD_SELECT} WHERE c.id = ?`).get(id);

    // Для чужих дітей повертаємо 404, щоб не розкривати їх існування
    if (!child || !canViewChild(req.user, child)) {
        return res.status(404).json({ error: 'Дитину не знайдено' });
    }

    res.status(200).json(serializeChild(child, req.user));
});

// POST /children
app.post(
    '/children',
    authenticate,
    requireRole('admin', 'manager'),
    (req, res) => {
        const data = req.body;

        if (!isPlainObject(data)) {
            return res.status(400).json({ error: 'Некоректне тіло запиту' });
        }

        const error = validateChild(data, false);

        if (error) {
            return res.status(400).json({ error });
        }

        const parentsError = validateParentLinks(
            data.parentId,
            data.guardianIds,
        );

        if (parentsError) {
            return res
                .status(parentsError.status)
                .json({ error: parentsError.error });
        }

        const isActive = data.isActive === undefined ? 1 : toBit(data.isActive);
        const groupId = data.groupId ?? null;

        if (isActive === 0 && groupId !== null) {
            return res.status(400).json({
                error: 'Неактивну дитину не можна призначити до групи',
            });
        }

        if (groupId !== null) {
            const assignmentError = checkGroupAssignment(
                groupId,
                data.birthDate,
                null,
            );

            if (assignmentError) {
                return res
                    .status(assignmentError.status)
                    .json({ error: assignmentError.error });
            }
        }

        try {
            const createChild = db.transaction(() => {
                const result = db
                    .prepare(
                        `
                    INSERT INTO children
                        (fullName, birthDate, parentId, groupId,
                         discountPercent, paymentPlan, notes, isActive)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `,
                    )
                    .run(
                        data.fullName.trim(),
                        data.birthDate,
                        data.parentId,
                        groupId,
                        data.discountPercent ?? 0,
                        data.paymentPlan ?? 'monthly',
                        data.notes?.trim() || null,
                        isActive,
                    );

                const childId = Number(result.lastInsertRowid);
                const link = db.prepare(
                    'INSERT INTO child_parents (childId, parentId) VALUES (?, ?)',
                );

                for (const parentId of [
                    data.parentId,
                    ...(data.guardianIds ?? []),
                ]) {
                    link.run(childId, parentId);
                }

                return childId;
            });

            const childId = createChild();
            const created = db
                .prepare(`${CHILD_SELECT} WHERE c.id = ?`)
                .get(childId);

            res.status(201).json(serializeChild(created, req.user));
        } catch (dbError) {
            return handleDbError(res, dbError);
        }
    },
);

// PATCH /children/:id (включно з призначенням у групу через groupId)
// admin/manager: усі поля; parent: лише notes своєї дитини
app.patch(
    '/children/:id',
    authenticate,
    requireRole('admin', 'manager', 'parent'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID дитини' });
        }

        const child = db.prepare('SELECT * FROM children WHERE id = ?').get(id);
        const isParent = req.user.role === 'parent';

        // Чужу дитину батько не бачить: 404, щоб не розкривати її існування
        if (!child || (isParent && !canViewChild(req.user, child))) {
            return res.status(404).json({ error: 'Дитину не знайдено' });
        }

        const data = req.body;

        if (!isPlainObject(data) || Object.keys(data).length === 0) {
            return res.status(400).json({ error: 'Немає даних для оновлення' });
        }

        // Батько може змінювати лише notes своєї дитини
        if (isParent && Object.keys(data).some((field) => field !== 'notes')) {
            return res.status(403).json({
                error: 'Батьки можуть змінювати лише поле notes',
            });
        }

        const error = validateChild(data, true);

        if (error) {
            return res.status(400).json({ error });
        }

        const newIsActive =
            data.isActive === undefined ? child.isActive : toBit(data.isActive);

        let newGroupId =
            data.groupId !== undefined ? data.groupId : child.groupId;

        if (newIsActive === 0) {
            if (data.groupId !== undefined && data.groupId !== null) {
                return res.status(400).json({
                    error: 'Неактивну дитину не можна призначити до групи',
                });
            }

            // Деактивація автоматично виводить дитину з групи
            newGroupId = null;
        }

        const newBirthDate = data.birthDate ?? child.birthDate;
        const groupChanged = newGroupId !== child.groupId;
        const birthDateChanged = data.birthDate !== undefined;

        if (newGroupId !== null && (groupChanged || birthDateChanged)) {
            const assignmentError = checkGroupAssignment(
                newGroupId,
                newBirthDate,
                id,
                {
                    checkAge: true,
                    checkCapacity: groupChanged,
                },
            );

            if (assignmentError) {
                return res
                    .status(assignmentError.status)
                    .json({ error: assignmentError.error });
            }
        }

        try {
            db.prepare(
                `
            UPDATE children
            SET fullName = ?, birthDate = ?, groupId = ?,
                discountPercent = ?, paymentPlan = ?, notes = ?, isActive = ?
            WHERE id = ?
        `,
            ).run(
                data.fullName !== undefined
                    ? data.fullName.trim()
                    : child.fullName,
                newBirthDate,
                newGroupId,
                data.discountPercent ?? child.discountPercent,
                data.paymentPlan ?? child.paymentPlan,
                data.notes !== undefined
                    ? data.notes?.trim() || null
                    : child.notes,
                newIsActive,
                id,
            );

            const updated = db
                .prepare(`${CHILD_SELECT} WHERE c.id = ?`)
                .get(id);

            res.status(200).json(serializeChild(updated, req.user));
        } catch (dbError) {
            return handleDbError(res, dbError);
        }
    },
);

// PUT /children/:id/parents - замінити представників
// parentId — основний представник (платник), guardianIds — додаткові опікуни.
app.put(
    '/children/:id/parents',
    authenticate,
    requireRole('admin', 'manager'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID дитини' });
        }

        const child = db
            .prepare('SELECT id FROM children WHERE id = ?')
            .get(id);

        if (!child) {
            return res.status(404).json({ error: 'Дитину не знайдено' });
        }

        const data = req.body;

        if (!isPlainObject(data)) {
            return res.status(400).json({ error: 'Некоректне тіло запиту' });
        }

        const parentsError = validateParentLinks(
            data.parentId,
            data.guardianIds,
        );

        if (parentsError) {
            return res
                .status(parentsError.status)
                .json({ error: parentsError.error });
        }

        try {
            db.transaction(() => {
                db.prepare('DELETE FROM child_parents WHERE childId = ?').run(
                    id,
                );

                const link = db.prepare(
                    'INSERT INTO child_parents (childId, parentId) VALUES (?, ?)',
                );

                for (const parentId of [
                    data.parentId,
                    ...(data.guardianIds ?? []),
                ]) {
                    link.run(id, parentId);
                }

                db.prepare('UPDATE children SET parentId = ? WHERE id = ?').run(
                    data.parentId,
                    id,
                );
            })();

            const updated = db
                .prepare(`${CHILD_SELECT} WHERE c.id = ?`)
                .get(id);

            res.status(200).json(serializeChild(updated, req.user));
        } catch (dbError) {
            return handleDbError(res, dbError);
        }
    },
);

// DELETE /children/:id
app.delete(
    '/children/:id',
    authenticate,
    requireRole('admin'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID дитини' });
        }

        const child = db
            .prepare('SELECT id FROM children WHERE id = ?')
            .get(id);

        if (!child) {
            return res.status(404).json({ error: 'Дитину не знайдено' });
        }

        try {
            // child_parents видаляється каскадно
            db.prepare('DELETE FROM children WHERE id = ?').run(id);
        } catch (dbError) {
            return handleDbError(res, dbError);
        }

        res.status(204).send();
    },
);

// ==========================================
// 5. КІМНАТИ ТА ЗАНЯТТЯ
// ==========================================

app.get('/rooms', authenticate, requireRole('admin', 'manager'), (req, res) => {
    try {
        const rooms = db.prepare(`
            SELECT id, name, type, rent
            FROM rooms
            ORDER BY id ASC
        `).all();

        return res.status(200).json(rooms);
    } catch (error) {
        console.error('Failed to fetch rooms:', error);
        return res.status(500).json({
            error: 'Failed to fetch rooms'
        });
    }
});

app.get('/rooms/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({
            error: 'Invalid room ID'
        });
    }

    try {
        const room = db.prepare(`
            SELECT id, name, type, rent
            FROM rooms
            WHERE id = ?
        `).get(id);

        if (!room) {
            return res.status(404).json({
                error: 'Room not found'
            });
        }

        return res.status(200).json(room);
    } catch (error) {
        console.error('Failed to fetch room:', error);
        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});


app.post('/rooms', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const { name, type, rent = 50000 } = req.body || {};

    if (
        typeof name !== 'string' ||
        !name.trim() ||
        typeof type !== 'string' ||
        !['base', 'specialized'].includes(type) ||
        !Number.isSafeInteger(rent) ||
        rent < 0
    ) {
        return res.status(400).json({
            error: 'Invalid room data'
        });
    }

    const normalizedName = name.trim();

    try {
        const result = db.prepare(`
            INSERT INTO rooms (name, type, rent)
            VALUES (?, ?, ?)
        `).run(normalizedName, type, rent);

        const room = db.prepare(`
            SELECT id, name, type, rent
            FROM rooms
            WHERE id = ?
        `).get(result.lastInsertRowid);

        return res.status(201).json(room);
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'Room with this name already exists'
            });
        }

        console.error('Failed to create room:', error);

        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});


app.patch('/rooms/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }

    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Invalid room data' });
    }

    const allowedFields = ['name', 'type', 'rent'];
    const fields = Object.keys(body);

    if (
        fields.length === 0 ||
        fields.some(field => !allowedFields.includes(field))
    ) {
        return res.status(400).json({ error: 'Invalid room data' });
    }

    try {
        const existing = db.prepare(`
            SELECT id, name, type, rent
            FROM rooms
            WHERE id = ?
        `).get(id);

        if (!existing) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const name = Object.hasOwn(body, 'name')
            ? body.name
            : existing.name;

        const type = Object.hasOwn(body, 'type')
            ? body.type
            : existing.type;

        const rent = Object.hasOwn(body, 'rent')
            ? body.rent
            : existing.rent;

        if (
            typeof name !== 'string' ||
            !name.trim() ||
            typeof type !== 'string' ||
            !['base', 'specialized'].includes(type) ||
            !Number.isSafeInteger(rent) ||
            rent < 0
        ) {
            return res.status(400).json({ error: 'Invalid room data' });
        }

        // Не дозволяємо змінювати базову кімнату групи
        // на спеціалізовану.
        if (type === 'specialized') {
            const group = db.prepare(`
                SELECT id FROM groups WHERE roomId = ?
            `).get(id);

            if (group) {
                return res.status(409).json({
                    error: 'Room is assigned to a group'
                });
            }
        }

        // Кімната, призначена дисципліні, має залишатись
        // спеціалізованою.
        if (type === 'base') {
            const activity = db.prepare(`
                SELECT id FROM activities WHERE roomId = ?
            `).get(id);

            if (activity) {
                return res.status(409).json({
                    error: 'Room is assigned to an activity'
                });
            }
        }

        db.prepare(`
            UPDATE rooms
            SET name = ?, type = ?, rent = ?
            WHERE id = ?
        `).run(name.trim(), type, rent, id);

        const updated = db.prepare(`
            SELECT id, name, type, rent
            FROM rooms
            WHERE id = ?
        `).get(id);

        return res.status(200).json(updated);

    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'Room with this name already exists'
            });
        }

        console.error('Failed to update room:', error);
        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});


app.delete('/rooms/:id', authenticate, requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }

    try {
        const room = db.prepare(`
            SELECT id FROM rooms WHERE id = ?
        `).get(id);

        if (!room) {
            return res.status(404).json({
                error: 'Room not found'
            });
        }

        const usedByGroup = db.prepare(`
            SELECT id FROM groups WHERE roomId = ?
        `).get(id);

        const usedByActivity = db.prepare(`
            SELECT id FROM activities WHERE roomId = ?
        `).get(id);

        const usedBySchedule = db.prepare(`
            SELECT id FROM schedule_slots WHERE roomId = ?
        `).get(id);

        if (usedByGroup || usedByActivity || usedBySchedule) {
            return res.status(409).json({
                error: 'Room is currently in use'
            });
        }

        db.prepare(`
            DELETE FROM rooms WHERE id = ?
        `).run(id);

        return res.status(204).send();

    } catch (error) {
        if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
            return res.status(409).json({
                error: 'Room is currently in use'
            });
        }

        console.error('Failed to delete room:', error);
        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});

app.get('/activities', authenticate, requireRole('admin', 'manager'), (req, res) => {
    try {
        const activities = db.prepare(`
            SELECT id, name, teacherId, roomId
            FROM activities
            ORDER BY id ASC
        `).all();

        return res.status(200).json(activities);

    } catch (error) {
        console.error('Failed to fetch activities:', error);

        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});

app.get('/activities/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({
            error: 'Invalid activity ID'
        });
    }

    try {
        const activity = db.prepare(`
            SELECT id, name, teacherId, roomId
            FROM activities
            WHERE id = ?
        `).get(id);

        if (!activity) {
            return res.status(404).json({
                error: 'Activity not found'
            });
        }

        return res.status(200).json(activity);

    } catch (error) {
        console.error('Failed to fetch activity:', error);

        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});

app.post('/activities', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Invalid activity data' });
    }

    const allowedFields = ['name', 'teacherId', 'roomId'];

    if (Object.keys(body).some(key => !allowedFields.includes(key))) {
        return res.status(400).json({ error: 'Invalid activity data' });
    }

    const { name, teacherId = null, roomId = null } = body;

    if (
        typeof name !== 'string' ||
        !name.trim() ||
        (teacherId !== null && (!Number.isSafeInteger(teacherId) || teacherId <= 0)) ||
        (roomId !== null && (!Number.isSafeInteger(roomId) || roomId <= 0))
    ) {
        return res.status(400).json({ error: 'Invalid activity data' });
    }

    try {
        if (teacherId !== null) {
            const teacher = db.prepare(`
                SELECT id, position
                FROM employees
                WHERE id = ?
            `).get(teacherId);

            if (!teacher) {
                return res.status(404).json({
                    error: 'Teacher not found'
                });
            }

            if (teacher.position !== 'teacher') {
                return res.status(409).json({
                    error: 'Employee is not a teacher'
                });
            }
        }

        if (roomId !== null) {
            const room = db.prepare(`
                SELECT id, type
                FROM rooms
                WHERE id = ?
            `).get(roomId);

            if (!room) {
                return res.status(404).json({
                    error: 'Room not found'
                });
            }

            if (room.type !== 'specialized') {
                return res.status(409).json({
                    error: 'Activity requires a specialized room'
                });
            }
        }

        const result = db.prepare(`
            INSERT INTO activities (name, teacherId, roomId)
            VALUES (?, ?, ?)
        `).run(name.trim(), teacherId, roomId);

        const activity = db.prepare(`
            SELECT id, name, teacherId, roomId
            FROM activities
            WHERE id = ?
        `).get(result.lastInsertRowid);

        return res.status(201).json(activity);

    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'Activity with this name already exists'
            });
        }

        if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
            return res.status(409).json({
                error: 'Related record is no longer available'
            });
        }

        console.error('Failed to create activity:', error);

        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});

app.patch('/activities/:id', authenticate, requireRole('admin', 'manager'), (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid activity ID' });
    }

    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Invalid activity data' });
    }

    const allowedFields = ['name', 'teacherId', 'roomId'];
    const fields = Object.keys(body);

    if (fields.length === 0 || fields.some(field => !allowedFields.includes(field))) {
        return res.status(400).json({ error: 'Invalid activity data' });
    }

    try {
        const existing = db.prepare(`
            SELECT id, name, teacherId, roomId
            FROM activities
            WHERE id = ?
        `).get(id);

        if (!existing) {
            return res.status(404).json({ error: 'Activity not found' });
        }

        const name = Object.hasOwn(body, 'name') ? body.name : existing.name;
        const teacherId = Object.hasOwn(body, 'teacherId')
            ? body.teacherId
            : existing.teacherId;
        const roomId = Object.hasOwn(body, 'roomId')
            ? body.roomId
            : existing.roomId;

        if (
            typeof name !== 'string' ||
            !name.trim() ||
            (teacherId !== null &&
                (!Number.isSafeInteger(teacherId) || teacherId <= 0)) ||
            (roomId !== null &&
                (!Number.isSafeInteger(roomId) || roomId <= 0))
        ) {
            return res.status(400).json({ error: 'Invalid activity data' });
        }

        if (teacherId !== null) {
            const teacher = db.prepare(`
                SELECT id, position
                FROM employees
                WHERE id = ?
            `).get(teacherId);

            if (!teacher) {
                return res.status(404).json({ error: 'Teacher not found' });
            }

            if (teacher.position !== 'teacher') {
                return res.status(409).json({
                    error: 'Employee is not a teacher'
                });
            }
        }

        if (roomId !== null) {
            const room = db.prepare(`
                SELECT id, type
                FROM rooms
                WHERE id = ?
            `).get(roomId);

            if (!room) {
                return res.status(404).json({ error: 'Room not found' });
            }

            if (room.type !== 'specialized') {
                return res.status(409).json({
                    error: 'Activity requires a specialized room'
                });
            }
        }

        db.prepare(`
            UPDATE activities
            SET name = ?, teacherId = ?, roomId = ?
            WHERE id = ?
        `).run(name.trim(), teacherId, roomId, id);

        const updated = db.prepare(`
            SELECT id, name, teacherId, roomId
            FROM activities
            WHERE id = ?
        `).get(id);

        return res.status(200).json(updated);

    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'Activity with this name already exists'
            });
        }

        if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
            return res.status(409).json({
                error: 'Related record is no longer available'
            });
        }

        console.error('Failed to update activity:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/activities/:id', authenticate, requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid activity ID' });
    }

    try {
        const activity = db.prepare(`
            SELECT id FROM activities WHERE id = ?
        `).get(id);

        if (!activity) {
            return res.status(404).json({ error: 'Activity not found' });
        }

        const usedBySchedule = db.prepare(`
            SELECT id
            FROM schedule_slots
            WHERE activityId = ?
        `).get(id);

        if (usedBySchedule) {
            return res.status(409).json({
                error: 'Activity is currently used in schedule'
            });
        }

        db.prepare(`
            DELETE FROM activities WHERE id = ?
        `).run(id);

        return res.status(204).send();

    } catch (error) {
        if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
            return res.status(409).json({
                error: 'Activity is currently in use'
            });
        }

        console.error('Failed to delete activity:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

function findScheduleConflict(slot, ignoreId = null) {
    const { groupId, teacherId, roomId, dayOfWeek, startTime } = slot;

    const conflicts = [
        { column: 'groupId', value: groupId, type: 'group_busy' },
        { column: 'teacherId', value: teacherId, type: 'teacher_busy' },
        { column: 'roomId', value: roomId, type: 'room_busy' }
    ];

    for (const conflict of conflicts) {
        const existing = db.prepare(`
            SELECT id
            FROM schedule_slots
            WHERE dayOfWeek = ?
              AND startTime = ?
              AND ${conflict.column} = ?
              AND id IS NOT ?
            ORDER BY id ASC
            LIMIT 1
        `).get(
            dayOfWeek,
            startTime,
            conflict.value,
            ignoreId
        );

        if (existing) {
            return {
                type: conflict.type,
                slotId: existing.id
            };
        }
    }

    return null;
}



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

// GET /children/:id/invoice - рахунок рахується на льоту за поточними даними дитини.
// Роли: admin і manager для будь-якої дитини; parent лише для своєї дитини і лише
// основний представник (children.parentId), інші опікуни бачать дитину, але не рахунок.
// Для неактивної дитини 409. Тариф харчування за віком групи (group.ageCategory),
// а без групи за повним віком на дату запиту.
app.get(
    '/children/:id/invoice',
    authenticate,
    requireRole('admin', 'manager', 'parent'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID дитини' });
        }

        const child = db.prepare('SELECT * FROM children WHERE id = ?').get(id);

        if (!child || !canViewChild(req.user, child)) {
            return res.status(404).json({ error: 'Дитину не знайдено' });
        }

        if (req.user.role === 'parent' && child.parentId !== req.user.parentId) {
            return res.status(403).json({
                error: 'Рахунок доступний лише основному представнику дитини'
            });
        }

        if (child.isActive !== 1) {
            return res.status(409).json({
                error: 'Рахунок для неактивної дитини не формується'
            });
        }

        let age;

        if (child.groupId !== null) {
            age = db
                .prepare('SELECT ageCategory FROM groups WHERE id = ?')
                .get(child.groupId).ageCategory;
        } else {
            age = calcAge(child.birthDate);
        }

        try {
            const tuition = calcTuition(child);
            const meals = calcMeals(age);
            const isYearly = child.paymentPlan === 'yearly';

            const tuitionAmount = isYearly ? tuition.perYear : tuition.perMonth;
            const mealsAmount = isYearly ? meals.perYear : meals.perMonth;

            return res.status(200).json({
                childId: child.id,
                fullName: child.fullName,
                paymentPlan: child.paymentPlan,
                discountPercent: child.discountPercent,
                period: isYearly ? 'year' : 'month',
                lines: [
                    { name: 'Навчання', amount: tuitionAmount },
                    { name: 'Харчування', amount: mealsAmount }
                ],
                total: tuitionAmount + mealsAmount
            });
        } catch (error) {
            if (error instanceof RangeError) {
                return res.status(409).json({
                    error: 'Неможливо розрахувати рахунок: вік дитини поза діапазоном 2-5 років'
                });
            }

            throw error;
        }
    }
);


// ==========================================
// РОЗКЛАД
// ==========================================

function generateScheduleLogic() {
    const groups = db.prepare('SELECT * FROM groups ORDER BY ageCategory DESC').all();
    const activities = db.prepare('SELECT * FROM activities LIMIT 5').all();

    if (activities.length < 5) {
        throw new Error('Для генерації розкладу необхідно мінімум 5 профільних дисциплін у базі.');
    }

    for (const act of activities) {
        if (!act.teacherId || !act.roomId) {
            throw new Error(`Дисципліна "${act.name}" не має призначеного викладача або кімнати.`);
        }
    }

    const insertSlot = db.prepare(`
        INSERT INTO schedule_slots (groupId, activityId, teacherId, roomId, dayOfWeek, startTime, durationMin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const generate = db.transaction(() => {
        db.prepare('DELETE FROM schedule_slots').run();
        const numActivities = 5;
        
        for (let d = 0; d < 5; d++) {
            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];
                const activityIndex = (i + d) % numActivities;
                const activity = activities[activityIndex];

                const slotIndex = Math.floor(i / numActivities);
                const totalMinutes = 9 * 60 + 30 + (slotIndex * 30); 
                
                const hh = Math.floor(totalMinutes / 60).toString().padStart(2, '0');
                const mm = (totalMinutes % 60).toString().padStart(2, '0');
                const startTime = `${hh}:${mm}`;

                insertSlot.run(
                    group.id, activity.id, activity.teacherId, 
                    activity.roomId, d, startTime, 30
                );
            }
        }
    });

    generate();
}

// --- ЕНДПОІНТИ РОЗКЛАДУ ---

// 1. Згенерувати розклад
app.post('/schedules/generate', authenticate, requireRole('admin', 'manager'), (req, res) => {
    try {
        generateScheduleLogic();
        res.status(201).json({ message: 'Розклад на тиждень успішно згенеровано.' });
    } catch (error) {
        res.status(409).json({ error: error.message });
    }
});

// 2. Отримати розклад для групи (ТЗ: батьки - своя дитина (і за children.parentId, і за child_parents), вчителі - свої групи, admin/manager - всі)
app.get('/groups/:id/schedule', authenticate, (req, res) => {
    const groupId = Number(req.params.id);

    // Перевірка прав доступу за ТЗ
    if (req.user.role === 'parent') {
        // Батько бачить тільки групу своєї дитини (перевірка і за прямою колонкою, і за таблицею опікунів)
        const childInGroup = db.prepare(`
            SELECT 1 
            FROM children c
            LEFT JOIN child_parents cp ON c.id = cp.childId
            WHERE (c.parentId = ? OR cp.parentId = ?) AND c.groupId = ? 
            LIMIT 1
        `).get(req.user.parentId, req.user.parentId, groupId);
        
        if (!childInGroup) {
            return res.status(403).json({ error: 'Доступ заборонено. Ви можете переглядати розклад лише групи вашої дитини.' });
        }
    } else if (req.user.role === 'teacher') {
        // Викладач бачить розклад лише тих груп, де він веде заняття
        const teachesInGroup = db.prepare('SELECT 1 FROM schedule_slots WHERE teacherId = ? AND groupId = ? LIMIT 1').get(req.user.employeeId, groupId);
        if (!teachesInGroup) {
            return res.status(403).json({ error: 'Доступ заборонено. Ви можете переглядати розклад лише своїх груп.' });
        }
    }
    // Якщо роль admin або manager — код просто йде далі без блокування

    const schedule = db.prepare(`
        SELECT s.id, s.dayOfWeek, s.startTime, s.durationMin, 
               a.name as activityName, e.fullName as teacherName, r.name as roomName
        FROM schedule_slots s
        JOIN activities a ON s.activityId = a.id
        JOIN employees e ON s.teacherId = e.id
        JOIN rooms r ON s.roomId = r.id
        WHERE s.groupId = ?
        ORDER BY s.dayOfWeek, s.startTime
    `).all(groupId);

    if (!schedule.length) return res.status(404).json({ error: 'Розклад не знайдено' });
    res.status(200).json(schedule);
});

// 3. Отримати розклад для викладача (ТЗ: тільки свій розклад, admin/manager - всі)
app.get('/teachers/:id/schedule', authenticate, (req, res) => {
    const requestedTeacherId = Number(req.params.id);

    // Перевірка прав доступу за ТЗ
    if (req.user.role === 'parent') {
        return res.status(403).json({ error: 'Доступ заборонено. Батьки не мають доступу до персональних розкладів викладачів.' });
    } else if (req.user.role === 'teacher' && req.user.employeeId !== requestedTeacherId) {
        // Викладач бачить тільки свій розклад
        return res.status(403).json({ error: 'Доступ заборонено. Ви можете переглядати лише власний розклад.' });
    }
    // admin та manager проходять без додаткових перевірок

    const schedule = db.prepare(`
        SELECT s.id, s.dayOfWeek, s.startTime, s.durationMin, 
               g.name as groupName, a.name as activityName, r.name as roomName
        FROM schedule_slots s
        JOIN groups g ON s.groupId = g.id
        JOIN activities a ON s.activityId = a.id
        JOIN rooms r ON s.roomId = r.id
        WHERE s.teacherId = ?
        ORDER BY s.dayOfWeek, s.startTime
    `).all(requestedTeacherId);

    if (!schedule.length) return res.status(404).json({ error: 'Розклад не знайдено' });
    res.status(200).json(schedule);
});

// 4. Оновити слот розкладу (перенести урок)
app.patch('/schedules/:id', authenticate, requireRole('admin', 'manager', 'teacher'), (req, res) => {
    try {
        const slotId = Number(req.params.id);
        
        // Валідація на порожнє тіло та наявність полів
        if (!req.body || req.body.startTime === undefined || req.body.dayOfWeek === undefined) {
            return res.status(400).json({ error: 'Відсутні обов\'язкові поля: startTime, dayOfWeek' });
        }

        const { startTime, dayOfWeek } = req.body;
        
        // Сувора валідація типу і значень (isInteger і т.д.)
        const validTimes = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00'];
        if (!validTimes.includes(startTime) || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 4) {
            return res.status(400).json({ error: 'Недійсний час або день тижня. Дозволено: 09:30-12:00, дні: 0-4 (тільки цілі числа).' });
        }

        const currentSlot = db.prepare('SELECT * FROM schedule_slots WHERE id = ?').get(slotId);
        if (!currentSlot) return res.status(404).json({ error: 'Слот не знайдено' });

        // Перевірка: вчитель може міняти тільки свої заняття
        if (req.user.role === 'teacher' && currentSlot.teacherId !== req.user.employeeId) {
            return res.status(403).json({ error: 'Ви можете змінювати лише власні заняття.' });
        }

        // Перевірка колізій через функцію Громова
        const conflict = findScheduleConflict({
            groupId: currentSlot.groupId,
            teacherId: currentSlot.teacherId,
            roomId: currentSlot.roomId,
            dayOfWeek: dayOfWeek,
            startTime: startTime,
            durationMin: 30
        }, slotId);

        if (conflict) {
            return res.status(409).json({ 
                error: 'Колізія розкладу: час вже зайнятий', 
                type: conflict.type, 
                slotId: conflict.slotId 
            });
        }

        db.prepare(`
            UPDATE schedule_slots 
            SET startTime = ?, dayOfWeek = ? 
            WHERE id = ?
        `).run(startTime, dayOfWeek, slotId);
        
        res.status(200).json({ message: 'Слот успішно оновлено' });

    } catch (error) {
        // Перехоплення унікальності на рівні БД
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'Колізія розкладу: конфлікт унікальності в базі даних.' });
        }
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// ПРИБУТОК
// ==========================================

// --- ЧИСТІ ФУНКЦІЇ ДЛЯ РОЗРАХУНКУ ПРИБУТКУ ---
function calcGroupProfit(groupId) {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    if (!group) throw new Error('Групу не знайдено');

    const children = db.prepare('SELECT discountPercent, paymentPlan FROM children WHERE groupId = ? AND isActive = 1').all(groupId);
    const kidsCount = children.length;

    let totalIncome = 0;
    for (const child of children) {
        totalIncome += calcTuition(child).perMonth;
    }

    const educatorSalary = calcEducatorSalary(kidsCount);
    const assistantSalary = calcAssistantSalary(kidsCount);
    const totalExpenses = CONFIG.ROOM_RENT + educatorSalary + assistantSalary;

    return {
        groupName: group.name,
        childrenCount: kidsCount,
        income: totalIncome,
        expenses: totalExpenses,
        netProfit: totalIncome - totalExpenses
    };
}

function calcKindergartenProfit() {
    const allActiveChildren = db.prepare('SELECT discountPercent, paymentPlan FROM children WHERE isActive = 1').all();
    
    let totalKindergartenIncome = 0;
    for (const child of allActiveChildren) {
        totalKindergartenIncome += calcTuition(child).perMonth;
    }

    const groups = db.prepare('SELECT id FROM groups').all();
    let totalGroupExpenses = 0;

    for (const g of groups) {
        const kidsInGroup = db.prepare('SELECT count(*) as count FROM children WHERE groupId = ? AND isActive = 1').get(g.id).count;
        totalGroupExpenses += calcEducatorSalary(kidsInGroup) + calcAssistantSalary(kidsInGroup);
    }

    const room = db.prepare('SELECT SUM(rent) as totalRent FROM rooms').get();
    const totalRent = room && room.totalRent ? room.totalRent : 0;
    
    const teachersCount = db.prepare("SELECT COUNT(*) as count FROM employees WHERE position = 'teacher'").get().count;
    const totalKindergartenExpenses = totalRent + CONFIG.MANAGER_SALARY + (CONFIG.TEACHER_SALARY * teachersCount) + totalGroupExpenses;

    return {
        totalIncome: totalKindergartenIncome,
        totalExpenses: totalKindergartenExpenses,
        totalNetProfit: totalKindergartenIncome - totalKindergartenExpenses
    };
}

// --- ЕНДПОІНТИ ПРИБУТКУ ---

// 5. Отримати прибуток для конкретної групи
app.get('/groups/:id/profit', authenticate, requireRole('admin'), (req, res) => {
    const id = parseId(req.params.id);

    if (id === null) {
        return res.status(400).json({ error: 'Некоректний ID групи' });
    }

    try {
        const profitData = calcGroupProfit(id);
        res.status(200).json(profitData);
    } catch (error) {
        if (error.message === 'Групу не знайдено') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({ error: error.message });
    }
});

// 6. Отримати загальний фінансовий звіт по садочку
app.get('/admin/profit', authenticate, requireRole('admin'), (req, res) => {
    try {
        const profitData = calcKindergartenProfit();
        res.status(200).json(profitData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ПРОГНОЗ ПРИБУТКУ (бонус ТЗ, етап 4) ---
// Симуляція для заданої кількості дітей без запису в БД. Припущення:
// діти розподіляються по групах рівномірно; на кожну групу припадає одна базова
// кімната, вихователь і помічник; на кожну дисципліну один викладач і один
// спеціалізований зал; доходом вважається лише навчання (як у звітах прибутку).
const FORECAST_MAX_GROUPS = 30;
const FORECAST_MAX_CHILDREN = 600;

function calcForecast({ children, age, groupSize, discountPercent, paymentPlan, disciplines }) {
    const groups = Math.ceil(children / groupSize);

    if (groups > FORECAST_MAX_GROUPS) {
        return { tooManyGroups: true, groups };
    }

    const base = Math.floor(children / groups);
    const extra = children % groups;
    const sizes = [];

    for (let i = 0; i < groups; i++) {
        sizes.push(i < extra ? base + 1 : base);
    }

    const tuitionPerChild = calcTuition({ discountPercent, paymentPlan }).perMonth;
    const income = children * tuitionPerChild;

    const baseRooms = groups;
    const specializedRooms = disciplines;
    const totalRooms = baseRooms + specializedRooms;

    const rent = totalRooms * CONFIG.ROOM_RENT;
    const manager = CONFIG.MANAGER_SALARY;
    const teachers = disciplines * CONFIG.TEACHER_SALARY;
    const educators = sizes.reduce((sum, n) => sum + calcEducatorSalary(n), 0);
    const assistants = sizes.reduce((sum, n) => sum + calcAssistantSalary(n), 0);
    const expensesTotal = rent + manager + teachers + educators + assistants;

    return {
        input: { children, age, groupSize, discountPercent, paymentPlan },
        groups: {
            count: groups,
            minSize: Math.min(...sizes),
            maxSize: Math.max(...sizes)
        },
        teachers: disciplines,
        rooms: { base: baseRooms, specialized: specializedRooms, total: totalRooms },
        income,
        expenses: {
            rent,
            manager,
            teachers,
            educators,
            assistants,
            total: expensesTotal
        },
        netProfit: income - expensesTotal
    };
}

// GET /admin/forecast?children=150&age=5&groupSize=20&discountPercent=0&paymentPlan=monthly
app.get('/admin/forecast', authenticate, requireRole('admin'), (req, res) => {
    const readInt = (value, fallback, min, max) => {
        if (value === undefined) {
            return fallback;
        }

        if (typeof value !== 'string' || !/^\d+$/.test(value)) {
            return null;
        }

        const number = Number(value);

        return number >= min && number <= max ? number : null;
    };

    const children = readInt(req.query.children, null, 1, FORECAST_MAX_CHILDREN);
    const age = readInt(req.query.age, 5, 2, 5);
    const groupSize = readInt(req.query.groupSize, CONFIG.GROUP_MAX_CHILDREN, 1, CONFIG.GROUP_MAX_CHILDREN);
    const discountPercent = readInt(req.query.discountPercent, 0, 0, 30);
    const paymentPlan = req.query.paymentPlan === undefined ? 'monthly' : req.query.paymentPlan;

    if (children === null) {
        return res.status(400).json({
            error: `Параметр children обов'язковий: ціле число від 1 до ${FORECAST_MAX_CHILDREN}`
        });
    }

    if (age === null) {
        return res.status(400).json({ error: 'Параметр age має бути цілим числом від 2 до 5' });
    }

    if (groupSize === null) {
        return res.status(400).json({
            error: `Параметр groupSize має бути цілим числом від 1 до ${CONFIG.GROUP_MAX_CHILDREN}`
        });
    }

    if (discountPercent === null || !CONFIG.ALLOWED_DISCOUNT_PERCENTS.includes(discountPercent)) {
        return res.status(400).json({ error: 'Параметр discountPercent має бути 0, 10, 20 або 30' });
    }

    if (paymentPlan !== 'monthly' && paymentPlan !== 'yearly') {
        return res.status(400).json({ error: 'Параметр paymentPlan має бути monthly або yearly' });
    }

    const disciplines = db.prepare('SELECT COUNT(*) AS count FROM activities').get().count || 5;
    const options = { children, age, groupSize, discountPercent, paymentPlan, disciplines };
    const forecast = calcForecast(options);

    if (forecast.tooManyGroups) {
        return res.status(400).json({
            error: `Для ${children} дітей по ${groupSize} у групі потрібно ${forecast.groups} груп, а максимум ${FORECAST_MAX_GROUPS}`
        });
    }

    // Мінімальна кількість дітей, за якої прогноз виходить у плюс при тих самих умовах.
    let breakEvenChildren = null;

    for (let n = 1; n <= FORECAST_MAX_GROUPS * groupSize; n++) {
        const result = calcForecast({ ...options, children: n });

        if (!result.tooManyGroups && result.netProfit >= 0) {
            breakEvenChildren = n;
            break;
        }
    }

    // Порівняння груп по 12 і по 20 дітей для тієї самої кількості дітей.
    const comparison = [12, 20].map((size) => {
        const result = calcForecast({ ...options, groupSize: size });

        return result.tooManyGroups
            ? { groupSize: size, error: `потрібно ${result.groups} груп, максимум ${FORECAST_MAX_GROUPS}` }
            : { groupSize: size, groups: result.groups.count, rooms: result.rooms.total, netProfit: result.netProfit };
    });

    return res.status(200).json({ ...forecast, breakEvenChildren, comparison });
});

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