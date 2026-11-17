// Автотест історії змін activities та schedule_slots (таблиця data_history).
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

function parseRows(rows) {
    return rows.map((row) => ({
        action: row.action,
        oldData: row.oldData === null ? null : JSON.parse(row.oldData),
        newData: row.newData === null ? null : JSON.parse(row.newData),
    }));
}

// Історія одного запису таблиці (recordId текстовий)
function recordHistory(tableName, recordId) {
    return parseRows(
        history
            .prepare(`
                SELECT action, oldData, newData
                FROM data_history
                WHERE tableName = ? AND recordId = ?
                ORDER BY id
            `)
            .all(tableName, String(recordId)),
    );
}

// Уся історія таблиці у порядку запису
function tableHistory(tableName) {
    return parseRows(
        history
            .prepare('SELECT action, oldData, newData FROM data_history WHERE tableName = ? ORDER BY id')
            .all(tableName),
    );
}

function historyCount() {
    return history
        .prepare("SELECT COUNT(*) AS n FROM data_history WHERE tableName IN ('activities', 'schedule_slots')")
        .get().n;
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-sched-'));
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

test('початкові дисципліни з seed потрапляють в історію як INSERT', () => {
    const seeded = tableHistory('activities').filter((row) => row.action === 'INSERT');
    const names = seeded.map((row) => row.newData.name);

    assert.deepEqual(names, ['Музика', 'Англійська', 'Фізкультура', 'Вільна боротьба', 'Шахи']);
    assert.equal(seeded[0].oldData, null);
    assert.equal(seeded[0].newData.teacherId, null);
    assert.equal(seeded[0].newData.roomId, null);
});

test('INSERT, UPDATE і DELETE дисципліни записуються повним станом', async () => {
    const room = await api('POST', '/rooms', { name: 'Зал історії А', type: 'specialized' });
    const teacher = await api('POST', '/employees', { fullName: 'Викладач історії А', position: 'teacher' });
    assert.equal(room.status, 201);
    assert.equal(teacher.status, 201);

    // INSERT
    const created = await api('POST', '/activities', { name: 'Гурток історії' });
    assert.equal(created.status, 201);
    const activityId = created.body.id;

    let rows = recordHistory('activities', activityId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'INSERT');
    assert.equal(rows[0].oldData, null);
    assert.deepEqual(rows[0].newData, { id: activityId, name: 'Гурток історії', teacherId: null, roomId: null });

    // UPDATE: призначили викладача й зал
    const updated = await api('PATCH', `/activities/${activityId}`, {
        teacherId: teacher.body.id,
        roomId: room.body.id,
    });
    assert.equal(updated.status, 200);

    rows = recordHistory('activities', activityId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].action, 'UPDATE');
    assert.deepEqual(rows[1].oldData, { id: activityId, name: 'Гурток історії', teacherId: null, roomId: null });
    assert.deepEqual(rows[1].newData, {
        id: activityId,
        name: 'Гурток історії',
        teacherId: teacher.body.id,
        roomId: room.body.id,
    });

    // UPDATE: очистили викладача (null теж змінює стан)
    const cleared = await api('PATCH', `/activities/${activityId}`, { teacherId: null });
    assert.equal(cleared.status, 200);

    rows = recordHistory('activities', activityId);
    assert.equal(rows.length, 3);
    assert.equal(rows[2].oldData.teacherId, teacher.body.id);
    assert.equal(rows[2].newData.teacherId, null);

    // DELETE
    const deleted = await api('DELETE', `/activities/${activityId}`);
    assert.equal(deleted.status, 204);

    rows = recordHistory('activities', activityId);
    assert.equal(rows.length, 4);
    assert.equal(rows[3].action, 'DELETE');
    assert.equal(rows[3].newData, null);
    assert.equal(rows[3].oldData.name, 'Гурток історії');
    assert.equal(rows[3].oldData.roomId, room.body.id);
});

test('UPDATE дисципліни без змін не записується', async () => {
    const created = await api('POST', '/activities', { name: 'Гурток без змін' });
    const activityId = created.body.id;

    const same = await api('PATCH', `/activities/${activityId}`, { name: 'Гурток без змін' });
    assert.equal(same.status, 200);

    assert.deepEqual(
        recordHistory('activities', activityId).map((row) => row.action),
        ['INSERT'],
    );
});

test('невдалі операції з дисциплінами не залишають історії', async () => {
    const countBefore = historyCount();

    const duplicate = await api('POST', '/activities', { name: 'Музика' });
    assert.equal(duplicate.status, 409);

    const invalid = await api('POST', '/activities', { name: '' });
    assert.equal(invalid.status, 400);

    const missingPatch = await api('PATCH', '/activities/999999', { name: 'Немає' });
    assert.equal(missingPatch.status, 404);

    const missingDelete = await api('DELETE', '/activities/999999');
    assert.equal(missingDelete.status, 404);

    assert.equal(historyCount(), countBefore);
});

test('INSERT, UPDATE і DELETE слотів розкладу записуються повним станом', async () => {
    // Розклад потребує 5 перших дисциплін з викладачем і залом та хоча б однієї групи
    const activities = await api('GET', '/activities');
    const firstFive = activities.body.slice(0, 5);
    assert.equal(firstFive.length, 5);

    for (const [index, activity] of firstFive.entries()) {
        const room = await api('POST', '/rooms', { name: `Зал розкладу ${index}`, type: 'specialized' });
        const teacher = await api('POST', '/employees', {
            fullName: `Викладач розкладу ${index}`,
            position: 'teacher',
        });
        const assigned = await api('PATCH', `/activities/${activity.id}`, {
            teacherId: teacher.body.id,
            roomId: room.body.id,
        });
        assert.equal(assigned.status, 200);
    }

    const group = await api('POST', '/groups', { name: 'Група історії розкладу', ageCategory: 3 });
    assert.equal(group.status, 201);

    // INSERT: генерація створює 5 слотів (по одному на день)
    const generated = await api('POST', '/schedules/generate');
    assert.equal(generated.status, 201);

    const slots = history
        .prepare('SELECT * FROM schedule_slots WHERE groupId = ? ORDER BY dayOfWeek')
        .all(group.body.id);
    assert.equal(slots.length, 5);

    for (const slot of slots) {
        const rows = recordHistory('schedule_slots', slot.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].action, 'INSERT');
        assert.equal(rows[0].oldData, null);
        assert.deepEqual(rows[0].newData, {
            id: slot.id,
            groupId: slot.groupId,
            activityId: slot.activityId,
            teacherId: slot.teacherId,
            roomId: slot.roomId,
            dayOfWeek: slot.dayOfWeek,
            startTime: slot.startTime,
            durationMin: slot.durationMin,
        });
    }

    // UPDATE: переносимо слот понеділка на 10:30
    const monday = slots[0];
    assert.equal(monday.startTime, '09:30');

    const moved = await api('PATCH', `/schedules/${monday.id}`, { startTime: '10:30', dayOfWeek: 0 });
    assert.equal(moved.status, 200);

    let rows = recordHistory('schedule_slots', monday.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].action, 'UPDATE');
    assert.equal(rows[1].oldData.startTime, '09:30');
    assert.equal(rows[1].newData.startTime, '10:30');
    assert.equal(rows[1].oldData.activityId, rows[1].newData.activityId);
    assert.equal(rows[1].newData.id, monday.id);

    // Той самий час ще раз: стан не змінився, запису немає
    const same = await api('PATCH', `/schedules/${monday.id}`, { startTime: '10:30', dayOfWeek: 0 });
    assert.equal(same.status, 200);
    assert.equal(recordHistory('schedule_slots', monday.id).length, 2);

    // Колізія (група вже зайнята о 10:30 у понеділок): 409 і жодного запису
    const tuesday = slots[1];
    const countBefore = historyCount();
    const conflict = await api('PATCH', `/schedules/${tuesday.id}`, { startTime: '10:30', dayOfWeek: 0 });
    assert.equal(conflict.status, 409);
    assert.equal(historyCount(), countBefore);

    // DELETE: повторна генерація видаляє старі слоти й створює нові
    const regenerated = await api('POST', '/schedules/generate');
    assert.equal(regenerated.status, 201);

    rows = recordHistory('schedule_slots', monday.id);
    assert.equal(rows.length, 3);
    assert.equal(rows[2].action, 'DELETE');
    assert.equal(rows[2].newData, null);
    assert.equal(rows[2].oldData.startTime, '10:30'); // у стані на момент видалення

    const all = tableHistory('schedule_slots');
    assert.equal(all.filter((row) => row.action === 'DELETE').length, 5);
    assert.equal(all.filter((row) => row.action === 'INSERT').length, 10);
});

test('невдала генерація розкладу не залишає історії слотів', async () => {
    const created = await api('POST', '/activities', { name: 'Дисципліна без викладача' });
    assert.equal(created.status, 201);

    // Шоста дисципліна не впливає (беруться перші 5), тому ламаємо одну з перших п'яти
    const activities = await api('GET', '/activities');
    const first = activities.body[0];
    const cleared = await api('PATCH', `/activities/${first.id}`, { teacherId: null });
    assert.equal(cleared.status, 200);

    const countBefore = history
        .prepare("SELECT COUNT(*) AS n FROM data_history WHERE tableName = 'schedule_slots'")
        .get().n;

    const failed = await api('POST', '/schedules/generate');
    assert.equal(failed.status, 409);

    const countAfter = history
        .prepare("SELECT COUNT(*) AS n FROM data_history WHERE tableName = 'schedule_slots'")
        .get().n;
    assert.equal(countAfter, countBefore);
});
