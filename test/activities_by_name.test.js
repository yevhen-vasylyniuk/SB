// Автотест пошуку та операцій за назвою для дисциплін (/activities/by-name/:name, GET /activities?name=).
// Запуск: npm test. Сервер стартує на тимчасовій базі, kindergarten.db і .env не змінюються.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADMIN_PASSWORD = 'test-admin-password-123';
const USER_PASSWORD = 'test-user-password-123';
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE_URL = `http://localhost:${PORT}`;

let tmpDir;
let server;
let adminToken;
let managerToken;
let teacherToken;

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

// token: undefined це адмін, null це запит без токена
async function api(method, url, body, token = adminToken) {
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

const byName = (name) => `/activities/by-name/${encodeURIComponent(name)}`;

async function login(loginName, password) {
    const res = await api('POST', '/auth/login', { login: loginName, password }, null);
    assert.equal(res.status, 200);
    return res.body.token;
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-activities-name-'));
    server = await startServer(path.join(tmpDir, 'test.db'));

    adminToken = await login('admin', ADMIN_PASSWORD);

    const manager = await api('POST', '/users', { login: 'mgr-by-name', password: USER_PASSWORD, role: 'manager' });
    assert.equal(manager.status, 201);
    managerToken = await login('mgr-by-name', USER_PASSWORD);

    const employee = await api('POST', '/employees', { fullName: 'Викладач для назв', position: 'teacher' });
    const teacher = await api('POST', '/users', {
        login: 'tea-by-name',
        password: USER_PASSWORD,
        role: 'teacher',
        employeeId: employee.body.id,
    });
    assert.equal(teacher.status, 201);
    teacherToken = await login('tea-by-name', USER_PASSWORD);
});

after(async () => {
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

test('пошук GET /activities?name= за частиною назви без урахування регістру', async () => {
    const names = async (query) => {
        const res = await api('GET', `/activities?name=${encodeURIComponent(query)}`);
        assert.equal(res.status, 200);
        return res.body.map((activity) => activity.name);
    };

    assert.deepEqual(await names('муз'), ['Музика']);
    assert.deepEqual(await names('МУЗИКА'), ['Музика']);
    assert.deepEqual(await names('бор'), ['Вільна боротьба']);
    assert.deepEqual(await names(' Шах '), ['Шахи']); // пробіли по краях обрізаються
    assert.deepEqual(await names('такої немає'), []); // нічого не знайдено: 200 і []

    const all = await api('GET', '/activities');
    assert.equal(all.status, 200);
    assert.equal(all.body.length, 5);
});

test('пошук із некоректною назвою дає 400', async () => {
    for (const query of ['?name=', '?name=%20%20', '?name=а&name=б']) {
        const res = await api('GET', `/activities${query}`);
        assert.equal(res.status, 400, query);
        assert.equal(typeof res.body.error, 'string');
    }
});

test('GET за назвою повертає ту саму дисципліну, що й за id', async () => {
    const list = await api('GET', '/activities');
    const music = list.body.find((activity) => activity.name === 'Музика');

    const found = await api('GET', byName('Музика'));
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, music);
    assert.deepEqual((await api('GET', `/activities/${music.id}`)).body, music);

    // назва з пробілом у шляху
    const wrestling = await api('GET', byName('Вільна боротьба'));
    assert.equal(wrestling.status, 200);
    assert.equal(wrestling.body.name, 'Вільна боротьба');
});

test('неіснуюча назва дає 404, а не пошук за схожою', async () => {
    for (const name of ['Немає такої', 'музика', 'Муз']) {
        const res = await api('GET', byName(name));
        assert.equal(res.status, 404, name);
        assert.equal(res.body.error, 'Дисципліну не знайдено');
    }

    assert.equal((await api('PATCH', byName('Немає такої'), { teacherId: null })).status, 404);
    assert.equal((await api('DELETE', byName('Немає такої'))).status, 404);

    // порожня назва в шляху це помилка запиту, а не 404
    assert.equal((await api('GET', '/activities/by-name/%20')).status, 400);
});

test('назва зі слешем знаходиться через закодований шлях', async () => {
    const created = await api('POST', '/activities', { name: 'Гурток А/Б' });
    assert.equal(created.status, 201);

    const found = await api('GET', byName('Гурток А/Б'));
    assert.equal(found.status, 200);
    assert.equal(found.body.id, created.body.id);
});

test('дублікати назви: POST і перейменування дають 409', async () => {
    // створення з назвою, що вже є (також з пробілами по краях)
    assert.equal((await api('POST', '/activities', { name: 'Музика' })).status, 409);
    assert.equal((await api('POST', '/activities', { name: '  Музика  ' })).status, 409);

    // перейменування за назвою на назву, що вже є
    const created = await api('POST', '/activities', { name: 'Гурток для дубліката' });
    const renameToExisting = await api('PATCH', byName('Гурток для дубліката'), { name: 'Шахи' });
    assert.equal(renameToExisting.status, 409);

    // запис не змінився: він лишився під старою назвою
    const stillThere = await api('GET', byName('Гурток для дубліката'));
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.id, created.body.id);

    // перейменування за id на існуючу назву теж 409
    assert.equal((await api('PATCH', `/activities/${created.body.id}`, { name: 'Англійська' })).status, 409);
});

test('назви, що відрізняються регістром, вважаються різними (точний збіг)', async () => {
    const created = await api('POST', '/activities', { name: 'музика' });
    assert.equal(created.status, 201);

    const lower = await api('GET', byName('музика'));
    const upper = await api('GET', byName('Музика'));
    assert.equal(lower.body.id, created.body.id);
    assert.notEqual(upper.body.id, created.body.id);
});

test('PATCH за назвою: призначення викладача й залу та перейменування', async () => {
    const room = await api('POST', '/rooms', { name: 'Зал для назв', type: 'specialized' });
    const teacher = await api('POST', '/employees', { fullName: 'Викладач PATCH', position: 'teacher' });
    const created = await api('POST', '/activities', { name: 'Гурток PATCH' });

    const assigned = await api('PATCH', byName('Гурток PATCH'), {
        teacherId: teacher.body.id,
        roomId: room.body.id,
    });
    assert.equal(assigned.status, 200);
    assert.deepEqual(assigned.body, {
        id: created.body.id,
        name: 'Гурток PATCH',
        teacherId: teacher.body.id,
        roomId: room.body.id,
    });
    assert.deepEqual((await api('GET', `/activities/${created.body.id}`)).body, assigned.body);

    // перейменування: стара назва зникає, нова працює
    const renamed = await api('PATCH', byName('Гурток PATCH'), { name: 'Гурток PATCH 2' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.id, created.body.id);
    assert.equal((await api('GET', byName('Гурток PATCH'))).status, 404);
    assert.equal((await api('GET', byName('Гурток PATCH 2'))).body.id, created.body.id);

    // менеджер теж може змінювати
    const byManager = await api('PATCH', byName('Гурток PATCH 2'), { teacherId: null }, managerToken);
    assert.equal(byManager.status, 200);
    assert.equal(byManager.body.teacherId, null);
});

test('PATCH за назвою: некоректне тіло дає 400, викладач не з посадою teacher 409', async () => {
    await api('POST', '/activities', { name: 'Гурток валідація' });

    assert.equal((await api('PATCH', byName('Гурток валідація'), {})).status, 400);
    assert.equal((await api('PATCH', byName('Гурток валідація'), { foo: 1 })).status, 400);
    assert.equal((await api('PATCH', byName('Гурток валідація'), { name: '' })).status, 400);
    assert.equal((await api('PATCH', byName('Гурток валідація'), { teacherId: 999999 })).status, 404);

    const educator = await api('POST', '/employees', { fullName: 'Вихователь не викладач', position: 'educator' });
    assert.equal((await api('PATCH', byName('Гурток валідація'), { teacherId: educator.body.id })).status, 409);
});

test('DELETE за назвою: 204, повторно 404', async () => {
    await api('POST', '/activities', { name: 'Гурток DELETE' });

    const deleted = await api('DELETE', byName('Гурток DELETE'));
    assert.equal(deleted.status, 204);
    assert.equal(deleted.body, null);

    assert.equal((await api('GET', byName('Гурток DELETE'))).status, 404);
    assert.equal((await api('DELETE', byName('Гурток DELETE'))).status, 404);
});

test('права: без токена 401, викладач 403, менеджер не видаляє', async () => {
    assert.equal((await api('GET', byName('Музика'), undefined, null)).status, 401);
    assert.equal((await api('GET', byName('Музика'), undefined, teacherToken)).status, 403);
    assert.equal((await api('PATCH', byName('Музика'), { teacherId: null }, teacherToken)).status, 403);
    assert.equal((await api('GET', '/activities?name=муз', undefined, teacherToken)).status, 403);

    // менеджер читає, але не видаляє (як і для id)
    assert.equal((await api('GET', byName('Музика'), undefined, managerToken)).status, 200);
    assert.equal((await api('DELETE', byName('Музика'), undefined, managerToken)).status, 403);
    assert.equal((await api('GET', byName('Музика'))).status, 200);
});
