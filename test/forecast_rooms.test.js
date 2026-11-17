// Автотест прогнозу (GET /admin/forecast): мінімальна кількість спеціалізованих
// кабінетів і мінімальна окупна кількість кімнат (ТЗ, етап 4, пункт 14).
// Запуск: npm test. Сервер стартує на тимчасовій базі, kindergarten.db і .env не змінюються.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADMIN_PASSWORD = 'test-admin-password-123';
const MANAGER_PASSWORD = 'test-manager-password-123';
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE_URL = `http://localhost:${PORT}`;

let tmpDir;
let server;
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

async function forecast(query) {
    const res = await api(adminToken, 'GET', `/admin/forecast?${new URLSearchParams(query)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-forecast-'));
    server = await startServer(path.join(tmpDir, 'test.db'));

    adminToken = await login('admin', ADMIN_PASSWORD);

    const manager = await api(adminToken, 'POST', '/users', {
        login: 'forecast-manager',
        password: MANAGER_PASSWORD,
        role: 'manager',
    });
    assert.equal(manager.status, 201, JSON.stringify(manager.body));
    managerToken = await login('forecast-manager', MANAGER_PASSWORD);
});

after(() => {
    server?.removeAllListeners('exit');
    server?.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('150 дітей по 5 років: 8 груп, 2 кабінети замість 5, прибуток з мінімумом кімнат', async () => {
    const result = await forecast({ children: 150, age: 5 });

    // Наявні поля прогнозу не змінились
    assert.equal(result.groups.count, 8);
    assert.deepEqual(result.rooms, { base: 8, specialized: 5, total: 13 });
    assert.equal(result.income, 2250000);
    assert.equal(result.netProfit, 536000);

    // 8 занять на день, кабінет вміщує 6, тож потрібно 2 кабінети; економія 3 × 50 000
    assert.equal(result.optimization.lessonsPerDay, 8);
    assert.equal(result.optimization.lessonSlotsPerRoom, 6);
    assert.equal(result.optimization.minSpecializedRooms, 2);
    assert.equal(result.optimization.minTotalRooms, 10);
    assert.equal(result.optimization.netProfitWithMinRooms, 686000);
});

test('мінімум кабінетів: 6 груп дають 1 кабінет, 7 груп дають 2, 30 груп дають 5', async () => {
    const cases = [
        { children: 120, groups: 6, minSpecializedRooms: 1 },
        { children: 121, groups: 7, minSpecializedRooms: 2 },
        { children: 600, groups: 30, minSpecializedRooms: 5 },
    ];

    for (const { children, groups, minSpecializedRooms } of cases) {
        const result = await forecast({ children, groupSize: 20 });
        assert.equal(result.groups.count, groups, `children=${children}`);
        assert.equal(result.optimization.minSpecializedRooms, minSpecializedRooms, `children=${children}`);
    }
});

test('мінімум кабінетів як у генераторі: 11-12 груп дають 3, 16-24 групи дають 5 (не ceil(груп / 6))', async () => {
    // Дисципліна закріплена за залом, а за формулою (i + d) mod 5 занять кожної дисципліни
    // щодня різна кількість, тому навантаження не завжди вдається розкласти рівно по 6
    const cases = [
        { children: 200, groups: 10, minSpecializedRooms: 2 },
        { children: 220, groups: 11, minSpecializedRooms: 3 },
        { children: 240, groups: 12, minSpecializedRooms: 3 },
        { children: 260, groups: 13, minSpecializedRooms: 3 },
        { children: 320, groups: 16, minSpecializedRooms: 5 },
        { children: 480, groups: 24, minSpecializedRooms: 5 },
    ];

    for (const { children, groups, minSpecializedRooms } of cases) {
        const result = await forecast({ children, groupSize: 20 });
        assert.equal(result.groups.count, groups, `children=${children}`);
        assert.equal(result.optimization.minSpecializedRooms, minSpecializedRooms, `children=${children}`);
        assert.equal(result.optimization.minTotalRooms, groups + minSpecializedRooms, `children=${children}`);
    }
});

test('окупна кількість кімнат: 3 повні групи по 20 і 1 кабінет, прибуток 96 000', async () => {
    const result = await forecast({ children: 150, age: 5, groupSize: 20 });

    // 1 група: 300 000 - 158 000 - 280 000 - 50 000 < 0; 2 групи: -46 000; 3 групи: +96 000
    assert.deepEqual(result.optimization.breakEvenRooms, {
        groups: 3,
        children: 60,
        baseRooms: 3,
        specializedRooms: 1,
        totalRooms: 4,
        netProfit: 96000,
    });
});

test('окупна кількість кімнат залежить від тарифу: 30% і yearly потребують більше груп', async () => {
    const result = await forecast({ children: 150, groupSize: 20, discountPercent: 30, paymentPlan: 'yearly' });
    const breakEven = result.optimization.breakEvenRooms;

    // Дитина приносить 9 240 на місяць: маржа групи 184 800 - 158 000 = 26 800
    assert.ok(breakEven, 'окупність має існувати');
    assert.ok(breakEven.groups > 3);
    assert.ok(breakEven.netProfit >= 0);
    assert.equal(breakEven.totalRooms, breakEven.baseRooms + breakEven.specializedRooms);
});

test('якщо садок не окупається навіть з 30 групами, breakEvenRooms = null', async () => {
    // Група з 1 дитини: дохід 9 240, а лише оренда кімнати 50 000
    const result = await forecast({ children: 10, groupSize: 1, discountPercent: 30, paymentPlan: 'yearly' });
    assert.equal(result.optimization.breakEvenRooms, null);
});

test('права: без токена 401, manager 403', async () => {
    const noToken = await api(null, 'GET', '/admin/forecast?children=150');
    assert.equal(noToken.status, 401);

    const asManager = await api(managerToken, 'GET', '/admin/forecast?children=150');
    assert.equal(asManager.status, 403);
});
