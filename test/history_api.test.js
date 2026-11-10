// Автотести HTTP API історії змін БД. Покласти у test/history_api.test.js.
// Запуск: npm test. Тести використовують окрему тимчасову SQLite-базу.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'history-api-tests-secret-at-least-32-characters';
const ADMIN_PASSWORD = 'history-test-admin-password';
const MANAGER_PASSWORD = 'history-test-manager-password';

let server;
let tmpDir;
let db;
let adminToken;
let managerToken;
let roomInsertId;
let roomUpdateId;
let roomDeleteId;
let parentInsertId;
let usersUpdateId;
let childParentsId;

function startServer(dbPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['index.js'], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                PORT: String(PORT),
                DB_PATH: dbPath,
                JWT_SECRET,
                ADMIN_PASSWORD
            }
        });
        let output = '';
        let settled = false;
        const timer = setTimeout(() => fail(new Error(`Не запустився сервер:\n${output}`)), 15000);

        function fail(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            reject(error);
        }
        const onOutput = (chunk) => {
            output += String(chunk);
            if (!settled && output.includes('Server running')) {
                settled = true;
                clearTimeout(timer);
                resolve(child);
            }
        };
        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);
        child.on('error', fail);
        child.on('exit', (code) => {
            if (!settled) fail(new Error(`Сервер завершився (${code}):\n${output}`));
        });
    });
}

async function request(url, token) {
    const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
    const response = await fetch(BASE_URL + url, { headers });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

async function login(username, password) {
    const response = await fetch(BASE_URL + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: username, password })
    });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.ok(json.token);
    return json.token;
}

function addHistory({ tableName, recordId, action, oldData = null, newData = null }) {
    const info = db.prepare(`
        INSERT INTO data_history (tableName, recordId, action, oldData, newData)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        tableName,
        recordId,
        action,
        oldData === null ? null : JSON.stringify(oldData),
        newData === null ? null : JSON.stringify(newData)
    );
    return Number(info.lastInsertRowid);
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-api-'));
    server = await startServer(path.join(tmpDir, 'test.db'));
    db = new Database(path.join(tmpDir, 'test.db'));

    db.prepare('INSERT INTO users (login, passwordHash, role) VALUES (?, ?, ?)')
        .run('history_manager', bcrypt.hashSync(MANAGER_PASSWORD, 4), 'manager');

    adminToken = await login('admin', ADMIN_PASSWORD);
    managerToken = await login('history_manager', MANAGER_PASSWORD);

    roomInsertId = addHistory({ tableName: 'rooms', recordId: '10', action: 'INSERT', newData: { id: 10, name: 'Сонечко' } });
    roomUpdateId = addHistory({ tableName: 'rooms', recordId: '10', action: 'UPDATE', oldData: { id: 10, name: 'Сонечко' }, newData: { id: 10, name: 'Веселка' } });
    roomDeleteId = addHistory({ tableName: 'rooms', recordId: '11', action: 'DELETE', oldData: { id: 11, name: 'Місяць' } });
    parentInsertId = addHistory({ tableName: 'parents', recordId: '20', action: 'INSERT', newData: { id: 20, fullName: 'Тестовий батько' } });
    childParentsId = addHistory({ tableName: 'child_parents', recordId: '20:5', action: 'INSERT', newData: { childId: 20, parentId: 5 } });
    usersUpdateId = addHistory({ tableName: 'users', recordId: '30', action: 'UPDATE',
        oldData: { id: 30, login: 'old-login', password: 'old-secret', passwordHash: 'old-hash', role: 'admin' },
        newData: { id: 30, login: 'new-login', password: 'new-secret', passwordHash: 'new-hash', role: 'admin' }
    });
});

after(async () => {
    // У Windows файл SQLite неможливо видалити, поки його тримає процес сервера.
    if (server && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((resolve) => server.once('exit', resolve));
        server.kill();
        await exited;
    }
    db?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('GET /history: admin отримує список у порядку від новіших до старіших', async () => {
    const res = await request('/history?tableName=rooms', adminToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((item) => item.id), [roomDeleteId, roomUpdateId, roomInsertId]);
    assert.deepEqual(res.body.map((item) => item.action), ['DELETE', 'UPDATE', 'INSERT']);
    assert.deepEqual(res.body[1].oldData, { id: 10, name: 'Сонечко' });
    assert.deepEqual(res.body[1].newData, { id: 10, name: 'Веселка' });
});

test('GET /history/:id: admin отримує один запис із JSON-об’єктами', async () => {
    const res = await request(`/history/${roomInsertId}`, adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, roomInsertId);
    assert.equal(res.body.tableName, 'rooms');
    assert.equal(res.body.recordId, '10');
    assert.equal(res.body.oldData, null);
    assert.deepEqual(res.body.newData, { id: 10, name: 'Сонечко' });
});

test('Обидва маршрути без токена повертають 401', async () => {
    for (const url of ['/history', `/history/${roomInsertId}`]) {
        const res = await request(url);
        assert.equal(res.status, 401, url);
        assert.ok(res.body.error);
    }
});

test('Обидва маршрути з недійсним токеном повертають 401', async () => {
    for (const url of ['/history', `/history/${roomInsertId}`]) {
        assert.equal((await request(url, 'bad-token')).status, 401, url);
    }
});

test('Обидва маршрути для manager повертають 403', async () => {
    for (const url of ['/history', `/history/${roomInsertId}`]) {
        const res = await request(url, managerToken);
        assert.equal(res.status, 403, url);
        assert.ok(res.body.error);
    }
});

test('Фільтри tableName, recordId та action працюють окремо та разом', async () => {
    const cases = [
        ['/history?tableName=parents', [parentInsertId]],
        ['/history?tableName=rooms&recordId=10', [roomUpdateId, roomInsertId]],
        ['/history?tableName=rooms&action=DELETE', [roomDeleteId]],
        ['/history?tableName=rooms&recordId=10&action=UPDATE', [roomUpdateId]],
        ['/history?tableName=child_parents&recordId=20%3A5', [childParentsId]]
    ];
    for (const [url, ids] of cases) {
        const res = await request(url, adminToken);
        assert.equal(res.status, 200, url);
        assert.deepEqual(res.body.map((row) => row.id), ids, url);
    }
});

test('Пагінація limit і offset працює', async () => {
    const firstPage = await request('/history?tableName=rooms&limit=2&offset=0', adminToken);
    const secondPage = await request('/history?tableName=rooms&limit=2&offset=2', adminToken);
    assert.equal(firstPage.status, 200);
    assert.equal(secondPage.status, 200);
    assert.deepEqual(firstPage.body.map((row) => row.id), [roomDeleteId, roomUpdateId]);
    assert.deepEqual(secondPage.body.map((row) => row.id), [roomInsertId]);
});

test('Порожня вибірка повертає 200 і []', async () => {
    const res = await request('/history?tableName=rooms&recordId=999999999', adminToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
});

test('Некоректні query-параметри повертають 400', async () => {
    const invalid = [
        'tableName=unknown', 'action=UPSERT', 'recordId=%20%20',
        'limit=0', 'limit=101', 'limit=-1', 'limit=1.5',
        'offset=-1', 'offset=1.5', 'offset=01'
    ];
    for (const query of invalid) {
        const url = `/history?${query}`;
        const res = await request(url, adminToken);
        assert.equal(res.status, 400, url);
        assert.ok(res.body.error, url);
    }
});

test('Некоректний ID події повертає 400', async () => {
    for (const id of ['abc', '0', '01', '-1', '1.5']) {
        const url = `/history/${id}`;
        const res = await request(url, adminToken);
        assert.equal(res.status, 400, url);
    }
});

test('Неіснуючий ID події повертає 404', async () => {
    const res = await request('/history/999999999', adminToken);
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
});

test('У user-історії ніколи не повертаються password та passwordHash', async () => {
    const res = await request(`/history/${usersUpdateId}`, adminToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.oldData, { id: 30, login: 'old-login', role: 'admin' });
    assert.deepEqual(res.body.newData, { id: 30, login: 'new-login', role: 'admin' });
    assert.ok(!JSON.stringify(res.body).includes('old-secret'));
    assert.ok(!JSON.stringify(res.body).includes('new-hash'));
});

test('Пошкоджений JSON повертає контрольовану 500, сервер продовжує працювати', async () => {
    const badId = Number(db.prepare(`
        INSERT INTO data_history (tableName, recordId, action, oldData, newData)
        VALUES ('rooms', 'broken-history', 'UPDATE', ?, ?)
    `).run('{malformed-json', '{"id": 100}').lastInsertRowid);

    const one = await request(`/history/${badId}`, adminToken);
    assert.equal(one.status, 500);
    assert.deepEqual(one.body, { error: 'Пошкоджені дані історії' });

    const list = await request('/history?tableName=rooms&recordId=broken-history', adminToken);
    assert.equal(list.status, 500);
    assert.deepEqual(list.body, { error: 'Пошкоджені дані історії' });

    const badNewId = Number(db.prepare(`
        INSERT INTO data_history (tableName, recordId, action, oldData, newData)
        VALUES ('rooms', 'broken-new-data', 'UPDATE', ?, ?)
    `).run('{"id": 101}', '{broken-json').lastInsertRowid);
    const badNew = await request(`/history/${badNewId}`, adminToken);
    assert.equal(badNew.status, 500);
    assert.deepEqual(badNew.body, { error: 'Пошкоджені дані історії' });

    const stillWorks = await request(`/history/${roomInsertId}`, adminToken);
    assert.equal(stillWorks.status, 200);
    assert.equal(stillWorks.body.id, roomInsertId);
});
