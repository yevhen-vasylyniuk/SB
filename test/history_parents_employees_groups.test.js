// Автотест історії змін parents, employees і groups (таблиця data_history).
// Запуск: npm test. Сервер стартує на тимчасовій базі, kindergarten.db і .env не змінюються.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ADMIN_PASSWORD = 'test-admin-password-123';
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE_URL = `http://localhost:${PORT}`;

let tmpDir;
let server;
let db;
let token;

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

async function api(method, url, body) {
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

// Поточний рядок таблиці з бази: з ним порівнюємо oldData і newData
function row(tableName, id) {
    return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) ?? null;
}

function recordHistory(tableName, id) {
    return db
        .prepare(`
            SELECT action, oldData, newData
            FROM data_history
            WHERE tableName = ? AND recordId = ?
            ORDER BY id
        `)
        .all(tableName, String(id))
        .map((r) => ({
            action: r.action,
            oldData: r.oldData === null ? null : JSON.parse(r.oldData),
            newData: r.newData === null ? null : JSON.parse(r.newData),
        }));
}

function tableHistoryCount(tableName) {
    return db.prepare('SELECT COUNT(*) AS n FROM data_history WHERE tableName = ?').get(tableName).n;
}

// Повний цикл: створити, змінити, змінити тими самими даними, видалити
async function checkFullCycle(tableName, url, createBody, updateBody) {
    const created = await api('POST', url, createBody);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    const afterInsert = row(tableName, id);

    assert.deepEqual(recordHistory(tableName, id), [
        { action: 'INSERT', oldData: null, newData: afterInsert },
    ]);

    const updated = await api('PATCH', `${url}/${id}`, updateBody);
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const afterUpdate = row(tableName, id);

    const same = await api('PATCH', `${url}/${id}`, updateBody);
    assert.equal(same.status, 200, JSON.stringify(same.body));

    const deleted = await api('DELETE', `${url}/${id}`);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
    assert.equal(row(tableName, id), null);

    assert.deepEqual(recordHistory(tableName, id), [
        { action: 'INSERT', oldData: null, newData: afterInsert },
        { action: 'UPDATE', oldData: afterInsert, newData: afterUpdate },
        { action: 'DELETE', oldData: afterUpdate, newData: null },
    ]);
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-'));
    const dbPath = path.join(tmpDir, 'test.db');

    server = await startServer(dbPath);
    db = new Database(dbPath, { readonly: true });

    const login = await api('POST', '/auth/login', { login: 'admin', password: ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    token = login.body.token;
});

after(() => {
    db?.close();
    server?.removeAllListeners('exit');
    server?.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('parents: INSERT, UPDATE і DELETE записуються повним станом, UPDATE без змін ні', async () => {
    await checkFullCycle(
        'parents',
        '/parents',
        { fullName: 'Історія Батько', phone: '+380501234567', email: 'history@example.com' },
        { phone: '+380671112233', relationNote: 'знайомий' },
    );
});

test('employees: INSERT, UPDATE і DELETE записуються повним станом, UPDATE без змін ні', async () => {
    await checkFullCycle(
        'employees',
        '/employees',
        { fullName: 'Історія Викладач', position: 'teacher', salaryRate: 40000 },
        { salaryRate: 45000 },
    );
});

test('groups: INSERT, UPDATE і DELETE записуються повним станом, UPDATE без змін ні', async () => {
    await checkFullCycle(
        'groups',
        '/groups',
        { name: 'Історія Група', ageCategory: 4 },
        { capacity: 15 },
    );
});

test('невдалі операції не залишають історії', async () => {
    const parent = await api('POST', '/parents', { fullName: 'Історія Без змін' });
    const educator = await api('POST', '/employees', { fullName: 'Історія Вихователь', position: 'educator' });
    const group = await api('POST', '/groups', { name: 'Історія Зайнята', ageCategory: 3, educatorId: educator.body.id });
    assert.equal(parent.status, 201);
    assert.equal(educator.status, 201);
    assert.equal(group.status, 201, JSON.stringify(group.body));

    const before = {
        parents: tableHistoryCount('parents'),
        employees: tableHistoryCount('employees'),
        groups: tableHistoryCount('groups'),
    };

    // parents: помилка валідації і неіснуючий запис
    assert.equal((await api('PATCH', `/parents/${parent.body.id}`, { email: 'not-an-email' })).status, 400);
    assert.equal((await api('DELETE', '/parents/999999')).status, 404);

    // employees: вихователь закріплений за групою, видалити не можна
    assert.equal((await api('DELETE', `/employees/${educator.body.id}`)).status, 409);
    assert.equal((await api('PATCH', `/employees/${educator.body.id}`, { salaryRate: -1 })).status, 400);

    // groups: дубль назви (UNIQUE) і вихователь, уже закріплений за іншою групою
    assert.equal((await api('POST', '/groups', { name: 'Історія Зайнята', ageCategory: 3 })).status, 409);
    assert.equal(
        (await api('POST', '/groups', { name: 'Історія Друга', ageCategory: 3, educatorId: educator.body.id })).status,
        409,
    );

    assert.deepEqual(
        {
            parents: tableHistoryCount('parents'),
            employees: tableHistoryCount('employees'),
            groups: tableHistoryCount('groups'),
        },
        before,
    );
});
