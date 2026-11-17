// Автотест історії змін children та child_parents (таблиця data_history).
// Запуск: node --test children_history.test.js

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

// Помічник для історії дітей
function childHistory(childId) {
    return history
        .prepare(`
            SELECT action, oldData, newData
            FROM data_history
            WHERE tableName = 'children' AND recordId = ?
            ORDER BY id
        `)
        .all(String(childId))
        .map((row) => ({
            action: row.action,
            oldData: row.oldData === null ? null : JSON.parse(row.oldData),
            newData: row.newData === null ? null : JSON.parse(row.newData),
        }));
}

// Помічник для історії опікунів (складений ключ childId:parentId)
function childParentsHistory(childId, parentId) {
    return history
        .prepare(`
            SELECT action, oldData, newData
            FROM data_history
            WHERE tableName = 'child_parents' AND recordId = ?
            ORDER BY id
        `)
        .all(`${childId}:${parentId}`)
        .map((row) => ({
            action: row.action,
            oldData: row.oldData === null ? null : JSON.parse(row.oldData),
            newData: row.newData === null ? null : JSON.parse(row.newData),
        }));
}

function historyCount() {
    return history.prepare("SELECT COUNT(*) AS n FROM data_history WHERE tableName IN ('children', 'child_parents')").get().n;
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-child-'));
    const dbPath = path.join(tmpDir, 'test.db');

    server = await startServer(dbPath);
    history = new Database(dbPath, { readonly: true });

    const login = await api('POST', '/auth/login', { login: 'admin', password: ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    token = login.body.token;
});

after(async () => {
    history?.close();
    if (server) {
        server.removeAllListeners('exit');
        const exitPromise = new Promise((resolve) => server.on('exit', resolve));
        server.kill();
        await exitPromise;
    }
    if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('INSERT, UPDATE і DELETE дитини записуються повним станом', async () => {
    // 1. Спочатку створюємо батька
    const parent = await api('POST', '/parents', { fullName: 'Батько для тесту історії' });
    const parentId = parent.body.id;

    // 2. Створюємо дитину (INSERT)
    const created = await api('POST', '/children', { 
        fullName: 'Дитина Історія А', 
        birthDate: '2021-05-05', 
        parentId: parentId 
    });
    assert.equal(created.status, 201);
    const childId = created.body.id;

    // Перевіряємо тригер INSERT для children
    const cHist = childHistory(childId);
    assert.equal(cHist.length, 1);
    assert.equal(cHist[0].action, 'INSERT');
    assert.equal(cHist[0].oldData, null);
    assert.equal(cHist[0].newData.fullName, 'Дитина Історія А');
    assert.equal(cHist[0].newData.id, childId);

    // Перевіряємо тригер INSERT для child_parents
    const cpHist = childParentsHistory(childId, parentId);
    assert.equal(cpHist.length, 1);
    assert.equal(cpHist[0].action, 'INSERT');
    assert.equal(cpHist[0].newData.childId, childId);
    assert.equal(cpHist[0].newData.parentId, parentId);

    // 3. Оновлюємо дитину (UPDATE)
    const updated = await api('PATCH', `/children/${childId}`, { notes: 'Нова нотатка' });
    assert.equal(updated.status, 200);

    const cHistUpdate = childHistory(childId);
    assert.equal(cHistUpdate.length, 2);
    assert.equal(cHistUpdate[1].action, 'UPDATE');
    assert.equal(cHistUpdate[1].oldData.notes, null); // було порожньо
    assert.equal(cHistUpdate[1].newData.notes, 'Нова нотатка'); // стало так

    // 4. Видаляємо дитину (DELETE) - це каскадно видалить і запис з child_parents
    const deleted = await api('DELETE', `/children/${childId}`);
    assert.equal(deleted.status, 204);

    const cHistDelete = childHistory(childId);
    assert.equal(cHistDelete.length, 3);
    assert.equal(cHistDelete[2].action, 'DELETE');
    assert.equal(cHistDelete[2].newData, null);
    assert.equal(cHistDelete[2].oldData.notes, 'Нова нотатка');

    // Перевіряємо каскадний DELETE у child_parents
    const cpHistDelete = childParentsHistory(childId, parentId);
    assert.equal(cpHistDelete.length, 2);
    assert.equal(cpHistDelete[1].action, 'DELETE');
    assert.equal(cpHistDelete[1].oldData.childId, childId);
});

test('UPDATE без змін не записується', async () => {
    const parent = await api('POST', '/parents', { fullName: 'Батько Б' });
    
    const created = await api('POST', '/children', { 
        fullName: 'Дитина Б', 
        birthDate: '2022-01-01', 
        parentId: parent.body.id,
        notes: 'Стара нотатка'
    });
    const childId = created.body.id;

    // Відправляємо ті самі дані
    const same = await api('PATCH', `/children/${childId}`, { notes: 'Стара нотатка' });
    assert.equal(same.status, 200);

    // Має залишитися тільки 1 запис (INSERT), UPDATE не спрацював
    assert.deepEqual(
        childHistory(childId).map((row) => row.action),
        ['INSERT']
    );
});

test('невдалі операції не залишають історії', async () => {
    const countBefore = historyCount();

    // Помилка валідації: дата в майбутньому
    const invalidInsert = await api('POST', '/children', { 
        fullName: 'Дитина В', 
        birthDate: '2050-01-01', 
        parentId: 1 
    });
    assert.equal(invalidInsert.status, 400);

    // Неіснуючий запис
    const missingDelete = await api('DELETE', '/children/999999');
    assert.equal(missingDelete.status, 404);

    assert.equal(historyCount(), countBefore); // Кількість записів не змінилася
});