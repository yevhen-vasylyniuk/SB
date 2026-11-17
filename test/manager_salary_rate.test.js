// Автотест прав на ставку зарплати: менеджер не може встановлювати чи змінювати
// salaryRate у POST /employees і PATCH /employees/:id (ТЗ, розділ 2), admin може.
// Запуск: npm test. Сервер стартує на тимчасовій базі, kindergarten.db і .env не змінюються.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ADMIN_PASSWORD = 'test-admin-password-123';
const MANAGER_PASSWORD = 'test-manager-password-123';
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE_URL = `http://localhost:${PORT}`;

let tmpDir;
let server;
let db;
let adminToken;
let managerToken;

function startServer(dbPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['index.js'], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                PORT: String(PORT),
                DB_PATH: dbPath,
                ADMIN_PASSWORD,
                JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
            },
        });

        let output = '';
        const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 10000);

        const onData = (chunk) => {
            output += chunk;
            if (output.includes('Server running')) {
                clearTimeout(timer);
                resolve(child);
            }
        };

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Server exited with code ${code}:\n${output}`));
        });
    });
}

async function api(token, method, url, body) {
    const res = await fetch(BASE_URL + url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(loginName, password) {
    const res = await api(null, 'POST', '/auth/login', { login: loginName, password });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.token;
}

function employeeRow(id) {
    return db.prepare('SELECT * FROM employees WHERE id = ?').get(id) ?? null;
}

function employeesCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-salary-'));
    const dbPath = path.join(tmpDir, 'test.db');

    server = await startServer(dbPath);
    db = new Database(dbPath, { readonly: true });

    adminToken = await login('admin', ADMIN_PASSWORD);

    const manager = await api(adminToken, 'POST', '/users', {
        login: 'salary-manager',
        password: MANAGER_PASSWORD,
        role: 'manager',
    });
    assert.equal(manager.status, 201, JSON.stringify(manager.body));
    managerToken = await login('salary-manager', MANAGER_PASSWORD);
});

after(() => {
    db?.close();
    server?.removeAllListeners('exit');
    server?.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('manager: POST /employees із salaryRate повертає 403 і нічого не створює', async () => {
    const countBefore = employeesCount();

    for (const salaryRate of [30000, 0, null]) {
        const res = await api(managerToken, 'POST', '/employees', {
            fullName: 'Ставка Менеджер',
            position: 'teacher',
            salaryRate,
        });
        assert.equal(res.status, 403, `salaryRate=${salaryRate}: ${JSON.stringify(res.body)}`);
        assert.equal(typeof res.body.error, 'string');
    }

    assert.equal(employeesCount(), countBefore);
});

test('manager: POST /employees без salaryRate створює працівника', async () => {
    const res = await api(managerToken, 'POST', '/employees', {
        fullName: 'Без ставки',
        position: 'teacher',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(employeeRow(res.body.id).salaryRate, null);
});

test('manager: PATCH /employees/:id із salaryRate повертає 403 і не змінює ставку', async () => {
    const created = await api(adminToken, 'POST', '/employees', {
        fullName: 'Ставка Адмін',
        position: 'teacher',
        salaryRate: 40000,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const before = employeeRow(created.body.id);

    for (const body of [{ salaryRate: 50000 }, { salaryRate: null }, { fullName: 'Нове ПІБ', salaryRate: 1 }]) {
        const res = await api(managerToken, 'PATCH', `/employees/${created.body.id}`, body);
        assert.equal(res.status, 403, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
    }

    assert.deepEqual(employeeRow(created.body.id), before);
});

test('manager: PATCH /employees/:id без salaryRate працює', async () => {
    const created = await api(adminToken, 'POST', '/employees', {
        fullName: 'Ставка Збережена',
        position: 'teacher',
        salaryRate: 40000,
    });
    assert.equal(created.status, 201);

    const res = await api(managerToken, 'PATCH', `/employees/${created.body.id}`, { fullName: 'Оновлене ПІБ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = employeeRow(created.body.id);
    assert.equal(row.fullName, 'Оновлене ПІБ');
    assert.equal(row.salaryRate, 40000);
});

test('admin: встановлює й змінює salaryRate', async () => {
    const created = await api(adminToken, 'POST', '/employees', {
        fullName: 'Адмінська ставка',
        position: 'teacher',
        salaryRate: 40000,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const updated = await api(adminToken, 'PATCH', `/employees/${created.body.id}`, { salaryRate: 45000 });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(employeeRow(created.body.id).salaryRate, 45000);
});
