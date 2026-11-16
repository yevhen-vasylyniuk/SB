// Автотест генератора розкладу (POST /schedules/generate, README розділ 5).
// Перевіряє формулу ТЗ, відсутність колізій і роботу зі спільними залами та викладачами.
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
const SLOT_TIMES = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00'];

let tmpDir;
let server;
let db;
let token;
let activities;
let teachers;
let rooms;
let groups;

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

async function created(method, url, body) {
    const res = await api(method, url, body);
    assert.equal(res.status, 201, `${method} ${url}: ${JSON.stringify(res.body)}`);
    return res.body;
}

// Призначає дисциплінам (за id) викладачів і зали за індексами
async function assign(teacherIdx, roomIdx) {
    for (let a = 0; a < activities.length; a++) {
        const res = await api('PATCH', `/activities/${activities[a].id}`, {
            teacherId: teachers[teacherIdx[a]].id,
            roomId: rooms[roomIdx[a]].id,
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
    }
}

function scheduleRows() {
    return db
        .prepare('SELECT groupId, activityId, teacherId, roomId, dayOfWeek, startTime, durationMin FROM schedule_slots ORDER BY id')
        .all();
}

// Інваріанти ТЗ: 5 різних занять на тиждень, по одному на день, 30 хв, сітка 09:30-12:00, без колізій
function assertValidSchedule(rows) {
    assert.equal(rows.length, groups.length * 5);

    for (const group of groups) {
        const own = rows.filter((r) => r.groupId === group.id);
        assert.deepEqual(own.map((r) => r.dayOfWeek).sort(), [0, 1, 2, 3, 4], `група ${group.name}`);
        assert.equal(new Set(own.map((r) => r.activityId)).size, 5, `група ${group.name}`);
    }

    const seen = new Set();
    for (const r of rows) {
        assert.ok(SLOT_TIMES.includes(r.startTime), `час ${r.startTime} поза сіткою`);
        assert.equal(r.durationMin, 30);
        for (const key of [`g${r.groupId}`, `t${r.teacherId}`, `r${r.roomId}`]) {
            const id = `${key}:${r.dayOfWeek}:${r.startTime}`;
            assert.ok(!seen.has(id), `колізія ${id}`);
            seen.add(id);
        }
    }
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-'));
    const dbPath = path.join(tmpDir, 'test.db');
    server = await startServer(dbPath);
    db = new Database(dbPath, { readonly: true });

    const login = await api('POST', '/auth/login', { login: 'admin', password: ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    token = login.body.token;

    activities = (await api('GET', '/activities')).body;
    assert.equal(activities.length, 5);

    teachers = [];
    rooms = [];
    for (let k = 0; k < 5; k++) {
        teachers.push(await created('POST', '/employees', { fullName: `Викладач ${k + 1}`, position: 'teacher' }));
        rooms.push(await created('POST', '/rooms', { name: `Зал ${k + 1}`, type: 'specialized' }));
    }
});

after(async () => {
    db?.close();
    server?.removeAllListeners('exit');
    if (server && server.exitCode === null && server.signalCode === null) {
        await new Promise((resolve) => {
            server.once('close', resolve);
            server.kill();
        });
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('без жодної групи генерація повертає 409', async () => {
    await assign([0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);

    const res = await api('POST', '/schedules/generate');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Немає жодної групи/);
    assert.equal(scheduleRows().length, 0);
});

test('свій зал і викладач у кожної дисципліни: розклад точно за формулою ТЗ', async () => {
    // Порядок створення навмисно не за віком: генератор сортує від старших до молодших
    groups = [];
    for (const [name, ageCategory] of [['Г2-а', 2], ['Г5-а', 5], ['Г4-а', 4], ['Г5-б', 5], ['Г3-а', 3], ['Г4-б', 4], ['Г3-б', 3], ['Г2-б', 2]]) {
        groups.push(await created('POST', '/groups', { name, ageCategory }));
    }
    const ordered = [...groups].sort((a, b) => b.ageCategory - a.ageCategory || a.id - b.id);

    const res = await api('POST', '/schedules/generate');
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const rows = scheduleRows();
    assertValidSchedule(rows);

    // activityIndex = (i + d) mod 5; однаковий предмет іде підряд від 09:30, старші першими
    for (let d = 0; d < 5; d++) {
        ordered.forEach((group, i) => {
            const slot = rows.find((r) => r.groupId === group.id && r.dayOfWeek === d);
            assert.equal(slot.activityId, activities[(i + d) % 5].id, `день ${d}, група ${group.name}`);
            assert.equal(slot.startTime, SLOT_TIMES[Math.floor(i / 5)], `день ${d}, група ${group.name}`);
        });
    }
});

test('8 груп і лише 2 спільні зали (мінімум з прогнозу): розклад без колізій', async () => {
    // 3 дисципліни в залі 1, 2 дисципліни в залі 2; викладач 1 веде дві дисципліни
    await assign([0, 0, 2, 3, 4], [0, 0, 0, 1, 1]);

    const res = await api('POST', '/schedules/generate');
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const rows = scheduleRows();
    assertValidSchedule(rows);
    assert.deepEqual([...new Set(rows.map((r) => r.roomId))].sort(), [rooms[0].id, rooms[1].id].sort());

    // У спільному залі заняття йдуть одне за одним від 09:30 без пропусків
    for (let d = 0; d < 5; d++) {
        const times = rows.filter((r) => r.dayOfWeek === d && r.roomId === rooms[0].id).map((r) => r.startTime).sort();
        assert.deepEqual(times, SLOT_TIMES.slice(0, times.length), `день ${d}`);
    }

    const forecast = await api('GET', '/admin/forecast?children=150&groupSize=20');
    assert.equal(forecast.body.groups.count, 8);
    assert.equal(forecast.body.optimization.minSpecializedRooms, 2);
});

test('один зал на 8 груп: 409 з поясненням, старий розклад не зникає', async () => {
    const previous = scheduleRows();
    await assign([0, 1, 2, 3, 4], [0, 0, 0, 0, 0]);

    const res = await api('POST', '/schedules/generate');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Не вистачає слотів 09:30–12:00/);
    assert.match(res.body.error, /Зал 1/);
    assert.match(res.body.error, /щонайменше 2 спеціалізованих залів/);
    assert.doesNotMatch(res.body.error, /UNIQUE|SQLITE/);

    assert.deepEqual(scheduleRows(), previous);
});

test('один викладач на всі дисципліни для 8 груп: 409 замість помилки бази', async () => {
    await assign([0, 0, 0, 0, 0], [0, 1, 2, 3, 4]);

    const res = await api('POST', '/schedules/generate');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Викладач 1/);
    assert.doesNotMatch(res.body.error, /UNIQUE|SQLITE/);
});
