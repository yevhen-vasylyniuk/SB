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

// ==========================================
// 4. ДІТИ ТА ГРУПИ  (Dev 4)
// ==========================================
// Вставити у server.js замість заглушки розділу 4
// (після розділу 3, перед 404-обробником).

// Чи перевіряти, що вік дитини відповідає ageCategory групи.
// Увімкнути (true) лише після підтвердження вимогами.
const ENFORCE_AGE_MATCH = false;

const STAFF_ROLES = ['admin', 'manager'];

// ------------------------------------------------------------
// ТИМЧАСОВО: заглушка авторизації до готового розділу 2 (Dev 1).
// Коли Dev 1 додасть authenticate / requireRole - ВИДАЛИТИ цей блок
// (дублікат const дасть помилку при запуску - це навмисно).
// Очікується JWT з payload: { id, role, parentId?, employeeId? }
// ------------------------------------------------------------
const authenticate = (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Потрібна авторизація' });
    }

    try {
        const p = jwt.verify(token, process.env.JWT_SECRET);
        req.user = {
            id: p.id,
            role: p.role,
            parentId: p.parentId ?? null,
            employeeId: p.employeeId ?? null,
        };
        next();
    } catch {
        res.status(401).json({ error: 'Недійсний токен' });
    }
};

const requireRole =
    (...roles) =>
    (req, res, next) =>
        roles.includes(req.user.role)
            ? next()
            : res.status(403).json({ error: 'Недостатньо прав' });
// ------------------------------------------------------------

// ---------- Спільні хелпери ----------

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Приймає рядок з URL ("5") або число з body (5). Повертає число або null.
function parseId(value) {
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
        value = Number(value);
    }

    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}

function parseBirthDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
    }

    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));

    if (
        date.getUTCFullYear() !== y ||
        date.getUTCMonth() !== m - 1 ||
        date.getUTCDate() !== d
    ) {
        return null;
    }

    return date;
}

// Повних років на сьогодні
function calcAge(birthDate, today = new Date()) {
    let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
    const monthDiff = today.getUTCMonth() - birthDate.getUTCMonth();

    if (
        monthDiff < 0 ||
        (monthDiff === 0 && today.getUTCDate() < birthDate.getUTCDate())
    ) {
        age--;
    }

    return age;
}

// Перетворює помилки БД (тригери, UNIQUE, FK) на 409.
// Повертає true, якщо відповідь уже відправлено.
function handleDbError(error, res) {
    const msg = error.message || '';

    if (msg.includes('Group capacity exceeded')) {
        res.status(409).json({ error: 'Група заповнена' });
        return true;
    }

    if (msg.includes('Group capacity below current enrollment')) {
        res.status(409).json({
            error: 'Місткість менша за поточну кількість дітей у групі',
        });
        return true;
    }

    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
            error: 'Порушено унікальність (назва групи або кімната вже зайняті)',
        });
        return true;
    }

    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        res.status(409).json({ error: 'Запис має пов’язані дані' });
        return true;
    }

    return false;
}

// Батьки працюють тільки зі своїми даними
function isParent(user) {
    return user.role === 'parent';
}

function parentHasChildInGroup(parentId, groupId) {
    return Boolean(
        db
            .prepare(
                `
        SELECT 1 FROM children
        WHERE parentId = ? AND groupId = ? AND isActive = 1
        LIMIT 1
    `,
            )
            .get(parentId, groupId),
    );
}

// ==========================================
// ГРУПИ
// ==========================================

const GROUP_SELECT = `
    SELECT g.*,
           (SELECT COUNT(*) FROM children c
            WHERE c.groupId = g.id AND c.isActive = 1) AS enrolled
    FROM groups g
`;

function validateGroup(data, isUpdate = false) {
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
            !Number.isInteger(data.ageCategory) ||
            data.ageCategory < 2 ||
            data.ageCategory > 5
        ) {
            return 'Вікова категорія має бути цілим числом від 2 до 5';
        }
    }

    if (
        data.capacity !== undefined &&
        (!Number.isInteger(data.capacity) ||
            data.capacity < 1 ||
            data.capacity > 20)
    ) {
        return 'Місткість має бути цілим числом від 1 до 20';
    }

    for (const field of ['roomId', 'educatorId', 'assistantId']) {
        if (
            data[field] !== undefined &&
            data[field] !== null &&
            parseId(data[field]) === null
        ) {
            return `Некоректне поле: ${field}`;
        }
    }

    return null;
}

// Перевірка зв'язків групи з кімнатою та працівниками
function checkGroupRelations(state) {
    if (
        state.roomId !== null &&
        !db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(state.roomId)
    ) {
        return 'Кімнати з таким ID не існує';
    }

    if (state.educatorId !== null) {
        const educator = db
            .prepare('SELECT position FROM employees WHERE id = ?')
            .get(state.educatorId);

        if (!educator) return 'Вихователя з таким ID не існує';
        if (educator.position !== 'educator') {
            return 'Працівник не має посади вихователя';
        }
    }

    if (state.assistantId !== null) {
        const assistant = db
            .prepare('SELECT position FROM employees WHERE id = ?')
            .get(state.assistantId);

        if (!assistant) return 'Помічника з таким ID не існує';
        if (assistant.position !== 'assistant') {
            return 'Працівник не має посади помічника вихователя';
        }
    }

    if (state.educatorId !== null && state.educatorId === state.assistantId) {
        return 'Вихователь і помічник мають бути різними людьми';
    }

    return null;
}

// GET /groups
// admin/manager - усі групи; parent - лише групи своїх дітей
app.get(
    '/groups',
    authenticate,
    requireRole(...STAFF_ROLES, 'parent'),
    (req, res) => {
        if (isParent(req.user)) {
            if (!req.user.parentId) {
                return res.status(403).json({ error: 'Недостатньо прав' });
            }

            const groups = db
                .prepare(
                    `
                ${GROUP_SELECT}
                WHERE g.id IN (
                    SELECT groupId FROM children
                    WHERE parentId = ? AND isActive = 1
                      AND groupId IS NOT NULL
                )
            `,
                )
                .all(req.user.parentId);

            return res.status(200).json(groups);
        }

        res.status(200).json(db.prepare(GROUP_SELECT).all());
    },
);

// GET /groups/:id
app.get(
    '/groups/:id',
    authenticate,
    requireRole(...STAFF_ROLES, 'parent'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID групи' });
        }

        if (
            isParent(req.user) &&
            !(req.user.parentId && parentHasChildInGroup(req.user.parentId, id))
        ) {
            // Не розкриваємо, чи існує чужа група
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        const group = db.prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id);

        if (!group) {
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        res.status(200).json(group);
    },
);

// GET /groups/:id/children - діти групи (лише персонал)
app.get(
    '/groups/:id/children',
    authenticate,
    requireRole(...STAFF_ROLES),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID групи' });
        }

        if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id)) {
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        const children = db
            .prepare(
                `
            SELECT * FROM children
            WHERE groupId = ? AND isActive = 1
        `,
            )
            .all(id);

        res.status(200).json(children);
    },
);

// POST /groups
app.post('/groups', authenticate, requireRole(...STAFF_ROLES), (req, res) => {
    const data = req.body;

    if (!isPlainObject(data)) {
        return res.status(400).json({ error: 'Некоректне тіло запиту' });
    }

    const error = validateGroup(data);

    if (error) {
        return res.status(400).json({ error });
    }

    const state = {
        name: data.name.trim(),
        ageCategory: data.ageCategory,
        capacity: data.capacity ?? 20,
        roomId: data.roomId == null ? null : parseId(data.roomId),
        educatorId: data.educatorId == null ? null : parseId(data.educatorId),
        assistantId:
            data.assistantId == null ? null : parseId(data.assistantId),
    };

    const relationError = checkGroupRelations(state);

    if (relationError) {
        return res.status(400).json({ error: relationError });
    }

    let result;

    try {
        result = db
            .prepare(
                `
                INSERT INTO groups
                    (name, ageCategory, capacity, roomId, educatorId, assistantId)
                VALUES (?, ?, ?, ?, ?, ?)
            `,
            )
            .run(
                state.name,
                state.ageCategory,
                state.capacity,
                state.roomId,
                state.educatorId,
                state.assistantId,
            );
    } catch (e) {
        if (handleDbError(e, res)) return;
        throw e;
    }

    res.status(201).json(
        db
            .prepare(`${GROUP_SELECT} WHERE g.id = ?`)
            .get(result.lastInsertRowid),
    );
});

// PATCH /groups/:id
app.patch(
    '/groups/:id',
    authenticate,
    requireRole(...STAFF_ROLES),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID групи' });
        }

        const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);

        if (!group) {
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        const data = req.body;

        if (!isPlainObject(data) || Object.keys(data).length === 0) {
            return res.status(400).json({ error: 'Немає даних для оновлення' });
        }

        const error = validateGroup(data, true);

        if (error) {
            return res.status(400).json({ error });
        }

        const pick = (field) =>
            data[field] === undefined
                ? group[field]
                : data[field] === null
                  ? null
                  : parseId(data[field]);

        const state = {
            name: data.name !== undefined ? data.name.trim() : group.name,
            ageCategory: data.ageCategory ?? group.ageCategory,
            capacity: data.capacity ?? group.capacity,
            roomId: pick('roomId'),
            educatorId: pick('educatorId'),
            assistantId: pick('assistantId'),
        };

        const relationError = checkGroupRelations(state);

        if (relationError) {
            return res.status(400).json({ error: relationError });
        }

        // Якщо змінюється вікова категорія - діти в групі мають їй відповідати
        if (ENFORCE_AGE_MATCH && state.ageCategory !== group.ageCategory) {
            const kids = db
                .prepare(
                    `
                SELECT birthDate FROM children
                WHERE groupId = ? AND isActive = 1
            `,
                )
                .all(id);

            const mismatch = kids.some(
                (k) =>
                    calcAge(parseBirthDate(k.birthDate)) !== state.ageCategory,
            );

            if (mismatch) {
                return res.status(409).json({
                    error: 'У групі є діти іншого віку',
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
                state.name,
                state.ageCategory,
                state.capacity,
                state.roomId,
                state.educatorId,
                state.assistantId,
                id,
            );
        } catch (e) {
            if (handleDbError(e, res)) return;
            throw e;
        }

        res.status(200).json(
            db.prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id),
        );
    },
);

// DELETE /groups/:id
app.delete(
    '/groups/:id',
    authenticate,
    requireRole(...STAFF_ROLES),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID групи' });
        }

        if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id)) {
            return res.status(404).json({ error: 'Групу не знайдено' });
        }

        const hasChildren = db
            .prepare('SELECT 1 FROM children WHERE groupId = ? LIMIT 1')
            .get(id);

        const hasSchedule = db
            .prepare('SELECT 1 FROM schedule_slots WHERE groupId = ? LIMIT 1')
            .get(id);

        if (hasChildren || hasSchedule) {
            return res.status(409).json({
                error: 'Неможливо видалити групу, оскільки існують пов’язані записи',
            });
        }

        try {
            db.prepare('DELETE FROM groups WHERE id = ?').run(id);
        } catch (e) {
            if (handleDbError(e, res)) return;
            throw e;
        }

        res.status(204).send();
    },
);

// ==========================================
// ДІТИ
// ==========================================

function validateChild(data, isUpdate = false) {
    const allowed = [
        'fullName',
        'birthDate',
        'parentId',
        'groupId',
        'discountPercent',
        'paymentPlan',
        'notes',
        'isActive',
    ];

    for (const field of Object.keys(data)) {
        if (!allowed.includes(field)) {
            return `Невідоме поле: ${field}`;
        }
    }

    if (!isUpdate || data.fullName !== undefined) {
        if (typeof data.fullName !== 'string' || data.fullName.trim() === '') {
            return 'Вкажіть коректне ПІБ дитини';
        }
    }

    if (!isUpdate || data.birthDate !== undefined) {
        const birthDate = parseBirthDate(data.birthDate);

        if (!birthDate) {
            return 'Дата народження має бути коректною та у форматі YYYY-MM-DD';
        }

        if (birthDate > new Date()) {
            return 'Дата народження не може бути в майбутньому';
        }
    }

    if (!isUpdate || data.parentId !== undefined) {
        if (parseId(data.parentId) === null) {
            return 'Вкажіть коректний parentId';
        }
    }

    if (
        data.groupId !== undefined &&
        data.groupId !== null &&
        parseId(data.groupId) === null
    ) {
        return 'Некоректний groupId';
    }

    if (
        data.discountPercent !== undefined &&
        ![0, 10, 20, 30].includes(data.discountPercent)
    ) {
        return 'Знижка може бути лише 0, 10, 20 або 30';
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

// Перевірка зв'язків дитини (батько, група, вік).
// Повертає { status, message } або null.
function checkChildRelations(state, checkAge = true) {
    if (!db.prepare('SELECT 1 FROM parents WHERE id = ?').get(state.parentId)) {
        return { status: 400, message: 'Батька з таким ID не існує' };
    }

    if (state.groupId !== null) {
        const group = db
            .prepare('SELECT ageCategory FROM groups WHERE id = ?')
            .get(state.groupId);

        if (!group) {
            return { status: 400, message: 'Групи з таким ID не існує' };
        }

        if (ENFORCE_AGE_MATCH && checkAge) {
            const age = calcAge(parseBirthDate(state.birthDate));

            if (age !== group.ageCategory) {
                return {
                    status: 409,
                    message: `Вік дитини (${age}) не відповідає віковій категорії групи (${group.ageCategory})`,
                };
            }
        }
    }

    return null;
}

// Чи має користувач право бачити цю дитину
function canAccessChild(user, child) {
    if (STAFF_ROLES.includes(user.role)) return true;

    return (
        isParent(user) &&
        user.parentId !== null &&
        child.parentId === user.parentId
    );
}

// GET /children
// admin/manager - усі (фільтри ?groupId= ?parentId= ?isActive=0|1)
// parent - лише власні діти
app.get(
    '/children',
    authenticate,
    requireRole(...STAFF_ROLES, 'parent'),
    (req, res) => {
        const conditions = [];
        const params = [];

        if (isParent(req.user)) {
            if (!req.user.parentId) {
                return res.status(403).json({ error: 'Недостатньо прав' });
            }

            conditions.push('parentId = ?');
            params.push(req.user.parentId);
        } else {
            for (const field of ['groupId', 'parentId']) {
                if (req.query[field] !== undefined) {
                    const value = parseId(req.query[field]);

                    if (value === null) {
                        return res.status(400).json({
                            error: `Некоректний параметр ${field}`,
                        });
                    }

                    conditions.push(`${field} = ?`);
                    params.push(value);
                }
            }

            if (req.query.isActive !== undefined) {
                if (!['0', '1'].includes(req.query.isActive)) {
                    return res.status(400).json({
                        error: 'isActive має бути 0 або 1',
                    });
                }

                conditions.push('isActive = ?');
                params.push(Number(req.query.isActive));
            }
        }

        const where = conditions.length
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        const children = db
            .prepare(`SELECT * FROM children ${where}`)
            .all(...params);

        res.status(200).json(children);
    },
);

// GET /children/:id
app.get(
    '/children/:id',
    authenticate,
    requireRole(...STAFF_ROLES, 'parent'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID дитини' });
        }

        const child = db.prepare('SELECT * FROM children WHERE id = ?').get(id);

        // Чужа дитина = "не знайдено", щоб не розкривати існування запису
        if (!child || !canAccessChild(req.user, child)) {
            return res.status(404).json({ error: 'Дитину не знайдено' });
        }

        res.status(200).json(child);
    },
);

// GET /parents/:id/children - діти конкретного батька
app.get(
    '/parents/:id/children',
    authenticate,
    requireRole(...STAFF_ROLES, 'parent'),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID батька' });
        }

        if (isParent(req.user) && req.user.parentId !== id) {
            return res.status(403).json({ error: 'Недостатньо прав' });
        }

        if (!db.prepare('SELECT 1 FROM parents WHERE id = ?').get(id)) {
            return res.status(404).json({ error: 'Батька не знайдено' });
        }

        const children = db
            .prepare('SELECT * FROM children WHERE parentId = ?')
            .all(id);

        res.status(200).json(children);
    },
);

// POST /children
app.post('/children', authenticate, requireRole(...STAFF_ROLES), (req, res) => {
    const data = req.body;

    if (!isPlainObject(data)) {
        return res.status(400).json({ error: 'Некоректне тіло запиту' });
    }

    const error = validateChild(data);

    if (error) {
        return res.status(400).json({ error });
    }

    const state = {
        fullName: data.fullName.trim(),
        birthDate: data.birthDate,
        parentId: parseId(data.parentId),
        groupId: data.groupId == null ? null : parseId(data.groupId),
        discountPercent: data.discountPercent ?? 0,
        paymentPlan: data.paymentPlan ?? 'monthly',
        notes: data.notes?.trim() || null,
        isActive: data.isActive === undefined ? 1 : data.isActive ? 1 : 0,
    };

    if (!state.isActive && state.groupId !== null) {
        return res.status(400).json({
            error: 'Неактивну дитину не можна додати до групи',
        });
    }

    const relationError = checkChildRelations(state);

    if (relationError) {
        return res
            .status(relationError.status)
            .json({ error: relationError.message });
    }

    let result;

    try {
        result = db
            .prepare(
                `
                INSERT INTO children
                    (fullName, birthDate, parentId, groupId,
                     discountPercent, paymentPlan, notes, isActive)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            )
            .run(
                state.fullName,
                state.birthDate,
                state.parentId,
                state.groupId,
                state.discountPercent,
                state.paymentPlan,
                state.notes,
                state.isActive,
            );
    } catch (e) {
        if (handleDbError(e, res)) return;
        throw e;
    }

    res.status(201).json(
        db
            .prepare('SELECT * FROM children WHERE id = ?')
            .get(result.lastInsertRowid),
    );
});

// PATCH /children/:id
app.patch(
    '/children/:id',
    authenticate,
    requireRole(...STAFF_ROLES),
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

        const isActive =
            data.isActive === undefined
                ? child.isActive
                : data.isActive
                  ? 1
                  : 0;

        let groupId =
            data.groupId === undefined
                ? child.groupId
                : data.groupId === null
                  ? null
                  : parseId(data.groupId);

        if (!isActive) {
            // Неактивна дитина автоматично залишає групу
            if (data.groupId !== undefined && data.groupId !== null) {
                return res.status(400).json({
                    error: 'Неактивну дитину не можна додати до групи',
                });
            }

            groupId = null;
        }

        const state = {
            fullName:
                data.fullName !== undefined
                    ? data.fullName.trim()
                    : child.fullName,
            birthDate: data.birthDate ?? child.birthDate,
            parentId:
                data.parentId !== undefined
                    ? parseId(data.parentId)
                    : child.parentId,
            groupId,
            discountPercent: data.discountPercent ?? child.discountPercent,
            paymentPlan: data.paymentPlan ?? child.paymentPlan,
            notes:
                data.notes !== undefined
                    ? data.notes?.trim() || null
                    : child.notes,
            isActive,
        };

        // Вік перевіряємо лише якщо змінилась дата народження або група
        const checkAge =
            data.birthDate !== undefined || state.groupId !== child.groupId;

        const relationError = checkChildRelations(state, checkAge);

        if (relationError) {
            return res
                .status(relationError.status)
                .json({ error: relationError.message });
        }

        try {
            db.prepare(
                `
                UPDATE children
                SET fullName = ?, birthDate = ?, parentId = ?, groupId = ?,
                    discountPercent = ?, paymentPlan = ?, notes = ?,
                    isActive = ?
                WHERE id = ?
            `,
            ).run(
                state.fullName,
                state.birthDate,
                state.parentId,
                state.groupId,
                state.discountPercent,
                state.paymentPlan,
                state.notes,
                state.isActive,
                id,
            );
        } catch (e) {
            if (handleDbError(e, res)) return;
            throw e;
        }

        res.status(200).json(
            db.prepare('SELECT * FROM children WHERE id = ?').get(id),
        );
    },
);

// DELETE /children/:id
// Для звичайного "виписування" краще PATCH { "isActive": false },
// щоб зберегти історію (рахунки, платежі).
app.delete(
    '/children/:id',
    authenticate,
    requireRole(...STAFF_ROLES),
    (req, res) => {
        const id = parseId(req.params.id);

        if (id === null) {
            return res.status(400).json({ error: 'Некоректний ID дитини' });
        }

        if (!db.prepare('SELECT 1 FROM children WHERE id = ?').get(id)) {
            return res.status(404).json({ error: 'Дитину не знайдено' });
        }

        try {
            db.prepare('DELETE FROM children WHERE id = ?').run(id);
        } catch (e) {
            if (handleDbError(e, res)) return;
            throw e;
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
