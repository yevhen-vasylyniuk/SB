
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
app.get('/parents', (req, res) => {
    const parents = db.prepare(
        'SELECT * FROM parents'
    ).all();

    res.status(200).json(parents);
});

// GET /parents/:id - отримати батька за ID
app.get('/parents/:id', (req, res) => {
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
app.post('/parents', (req, res) => {
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
app.patch('/parents/:id', (req, res) => {
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
app.delete('/parents/:id', (req, res) => {
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
app.get('/employees', (req, res) => {
    const employees = db.prepare(
        'SELECT * FROM employees'
    ).all();

    res.status(200).json(employees);
});

// GET /employees/:id - отримати працівника за ID
app.get('/employees/:id', (req, res) => {
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
app.post('/employees', (req, res) => {
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
app.patch('/employees/:id', (req, res) => {
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
app.delete('/employees/:id', (req, res) => {
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
        message: 'Kindergarten API працює'
    });
});

// ==========================================
// 9. ЗАПУСК СЕРВЕРА
// ==========================================

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
