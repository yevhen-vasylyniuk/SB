// Автотест історії змін rooms (таблиця data_history).
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
let history;
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

function roomHistory(roomId) {
    return history
        .prepare(`
            SELECT action, oldData, newData
            FROM data_history
            WHERE tableName = 'rooms' AND recordId = ?
            ORDER BY id
        `)
        .all(String(roomId))
        .map((row) => ({
            action: row.action,
            oldData: row.oldData === null ? null : JSON.parse(row.oldData),
            newData: row.newData === null ? null : JSON.parse(row.newData),
        }));
}

function historyCount() {
    return history.prepare('SELECT COUNT(*) AS n FROM data_history').get().n;
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-'));
    const dbPath = path.join(tmpDir, 'test.db');

    server = await startServer(dbPath);
    history = new Database(dbPath, { readonly: true });

    const login = await api('POST', '/auth/login', { login: 'admin', password: ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    token = login.body.token;
});

after(async () => {
    history?.close();
    server?.removeAllListeners('exit');
    if (server && server.exitCode === null && server.signalCode === null) {
        await new Promise((resolve) => {
            server.once('close', resolve);
            server.kill();
        });
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('INSERT, UPDATE і DELETE кімнати записуються повним станом', async () => {
    const created = await api('POST', '/rooms', { name: 'Історія А', type: 'base', rent: 50000 });
    assert.equal(created.status, 201);
    const room = created.body;

    assert.deepEqual(roomHistory(room.id), [{ action: 'INSERT', oldData: null, newData: room }]);

    const updated = await api('PATCH', `/rooms/${room.id}`, { rent: 60000 });
    assert.equal(updated.status, 200);

    assert.deepEqual(roomHistory(room.id)[1], {
        action: 'UPDATE',
        oldData: room,
        newData: updated.body,
    });

    const deleted = await api('DELETE', `/rooms/${room.id}`);
    assert.equal(deleted.status, 204);

    const rows = roomHistory(room.id);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[2], { action: 'DELETE', oldData: updated.body, newData: null });
});

test('UPDATE без змін не записується', async () => {
    const created = await api('POST', '/rooms', { name: 'Історія Б', type: 'base', rent: 50000 });
    assert.equal(created.status, 201);

    const same = await api('PATCH', `/rooms/${created.body.id}`, { rent: 50000 });
    assert.equal(same.status, 200);

    assert.deepEqual(
        roomHistory(created.body.id).map((row) => row.action),
        ['INSERT'],
    );
});

test('невдалі операції не залишають історії', async () => {
    const first = await api('POST', '/rooms', { name: 'Історія В', type: 'base', rent: 50000 });
    const second = await api('POST', '/rooms', { name: 'Історія Г', type: 'base', rent: 50000 });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const countBefore = historyCount();

    // Помилки на рівні БД (UNIQUE): тригер спрацював би, але вся операція відкочується
    const duplicateInsert = await api('POST', '/rooms', { name: 'Історія В', type: 'base', rent: 1 });
    assert.equal(duplicateInsert.status, 409);

    const duplicateRename = await api('PATCH', `/rooms/${second.body.id}`, { name: 'Історія В' });
    assert.equal(duplicateRename.status, 409);

    // Помилки валідації й неіснуючий запис
    const invalid = await api('PATCH', `/rooms/${first.body.id}`, { rent: -1 });
    assert.equal(invalid.status, 400);

    const missing = await api('DELETE', '/rooms/999999');
    assert.equal(missing.status, 404);

    assert.equal(historyCount(), countBefore);
    assert.deepEqual(
        roomHistory(second.body.id).map((row) => row.action),
        ['INSERT'],
    );
});
