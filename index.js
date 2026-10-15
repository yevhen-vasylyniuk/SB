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

// Тут буде підключення SQLite та створення таблиць.

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
const ENFORCE_AGE_MATCH = true;

db.exec(`
    CREATE TABLE IF NOT EXISTS child_parents (
        childId INTEGER NOT NULL,
        parentId INTEGER NOT NULL,
        PRIMARY KEY (childId, parentId),
        FOREIGN KEY (childId) REFERENCES children(id) ON DELETE CASCADE,
        FOREIGN KEY (parentId) REFERENCES parents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_child_parents_parent
        ON child_parents(parentId);

    INSERT OR IGNORE INTO child_parents (childId, parentId)
        SELECT id, parentId FROM children;
`);

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

// ---------- Автентифікація та ролі (мінімум для розмежування доступу) ----------
const AUTH_DISABLED =
    process.env.AUTH_DISABLED === 'true' &&
    process.env.NODE_ENV !== 'production';

if (AUTH_DISABLED) {
    console.warn('УВАГА: авторизацію вимкнено (AUTH_DISABLED=true)');
}
function authenticate(req, res, next) {
    if (AUTH_DISABLED) {
        req.user = {
            id: 0,
            login: 'dev',
            role: 'admin',
            parentId: null,
            employeeId: null,
        };
        return next();
    }
    const [scheme, token] = (req.headers.authorization || '').split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Потрібна авторизація' });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
        console.error('JWT_SECRET is not set');
        return res.status(500).json({ error: 'Internal server error' });
    }

    let payload;

    try {
        payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Недійсний токен' });
    }

    const user = db
        .prepare(
            'SELECT id, login, role, parentId, employeeId FROM users WHERE id = ?',
        )
        .get(payload.sub);

    if (!user) {
        return res.status(401).json({ error: 'Користувача не знайдено' });
    }

    req.user = user;
    next();
}

function authorize(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Недостатньо прав' });
        }

        next();
    };
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
    authorize('admin', 'manager', 'teacher'),
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
app.post('/groups', authenticate, authorize('admin', 'manager'), (req, res) => {
    const data = req.body;

    if (!isPlainObject(data)) {
        return res.status(400).json({ error: 'Некоректне тіло запиту' });
    }

    const error = validateGroupFields(data, false);

    if (error) {
        return res.status(400).json({ error });
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
    authorize('admin', 'manager'),
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
    authorize('admin', 'manager'),
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
        allowed.push('parentIds');
    }

    for (const field of Object.keys(data)) {
        if (!allowed.includes(field)) {
            return field === 'parentIds'
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

function validateParentIds(parentIds) {
    if (
        !Array.isArray(parentIds) ||
        parentIds.length === 0 ||
        parentIds.length > 10
    ) {
        return {
            status: 400,
            error: 'parentIds має бути непорожнім масивом (до 10 елементів)',
        };
    }

    if (
        !parentIds.every(isPositiveInt) ||
        new Set(parentIds).size !== parentIds.length
    ) {
        return {
            status: 400,
            error: 'parentIds мають бути унікальними додатними цілими числами',
        };
    }

    const { cnt } = db
        .prepare(
            `SELECT COUNT(*) AS cnt FROM parents
             WHERE id IN (${parentIds.map(() => '?').join(',')})`,
        )
        .get(...parentIds);

    if (cnt !== parentIds.length) {
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
    authorize('admin', 'manager'),
    (req, res) => {
        const data = req.body;

        if (!isPlainObject(data)) {
            return res.status(400).json({ error: 'Некоректне тіло запиту' });
        }

        const error = validateChild(data, false);

        if (error) {
            return res.status(400).json({ error });
        }

        const parentsError = validateParentIds(data.parentIds);

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
                        data.parentIds[0],
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

                for (const parentId of data.parentIds) {
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
app.patch(
    '/children/:id',
    authenticate,
    authorize('admin', 'manager'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID дитини' });
        }

        const child = db.prepare('SELECT * FROM children WHERE id = ?').get(id);

        if (!child) {
            return res.status(404).json({ error: 'Дитину не знайдено' });
        }

        const data = req.body;

        if (!isPlainObject(data) || Object.keys(data).length === 0) {
            return res.status(400).json({ error: 'Немає даних для оновлення' });
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

// PUT /children/:id/parents - замінити список представників
// Перший елемент parentIds стає основним представником.
app.put(
    '/children/:id/parents',
    authenticate,
    authorize('admin', 'manager'),
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

        const parentsError = validateParentIds(data.parentIds);

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

                for (const parentId of data.parentIds) {
                    link.run(id, parentId);
                }

                db.prepare('UPDATE children SET parentId = ? WHERE id = ?').run(
                    data.parentIds[0],
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
    authorize('admin', 'manager'),
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

// Тут будуть операції CRUD.

// ==========================================
// 6. РАХУНКИ ТА ПЛАТЕЖІ
// ==========================================

// Тут будуть фінансові операції.

// ==========================================
// 7. ОБРОБКА ПОМИЛОК
// ==========================================

// Тут буде централізована обробка помилок.

// ==========================================
// 8. ПЕРЕВІРКА РОБОТИ API
// ==========================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Kindergarten API працює',
    });
});

// ==========================================
// 9. ЗАПУСК СЕРВЕРА
// ==========================================

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
