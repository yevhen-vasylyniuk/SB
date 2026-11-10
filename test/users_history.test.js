const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('users: історія змін без passwordHash', async () => {
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'sb-users-history-')
    );
    const dbPath = path.join(tmpDir, 'test.db');

    const server = spawn(process.execPath, ['index.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            DB_PATH: dbPath,
            PORT: '0',
            ADMIN_PASSWORD: 'test-admin-password-123',
            JWT_SECRET: 'test-jwt-secret-at-least-32-characters'
        }
    });

    let db;

    try {
        // Чекаємо, поки застосунок створить таблиці й тригери.
        await new Promise((resolve, reject) => {
            let output = '';

            const timeout = setTimeout(() => {
                reject(new Error(`Сервер не запустився: ${output}`));
            }, 10000);

            const onData = (chunk) => {
                output += chunk.toString();

                if (output.includes('Server running')) {
                    clearTimeout(timeout);
                    resolve();
                }
            };

            server.stdout.on('data', onData);
            server.stderr.on('data', onData);

            server.once('exit', (code) => {
                clearTimeout(timeout);
                reject(new Error(
                    `Сервер завершився з кодом ${code}: ${output}`
                ));
            });
        });

        db = new Database(dbPath);

        const history = (id) => db.prepare(`
            SELECT action, oldData, newData
            FROM data_history
            WHERE tableName = 'users' AND recordId = ?
            ORDER BY id
        `).all(String(id)).map((row) => ({
            action: row.action,
            oldData: row.oldData ? JSON.parse(row.oldData) : null,
            newData: row.newData ? JSON.parse(row.newData) : null
        }));

        // Початковий admin також має потрапити в історію.
        const admin = db.prepare(`
            SELECT id FROM users WHERE login = 'admin'
        `).get();

        assert.ok(admin);
        assert.equal(history(admin.id)[0].action, 'INSERT');

        // INSERT
        const created = db.prepare(`
            INSERT INTO users (login, passwordHash, role)
            VALUES (?, ?, ?)
        `).run('history-test', 'SECRET_HASH_1', 'manager');

        const id = created.lastInsertRowid;

        assert.equal(history(id).length, 1);
        assert.equal(history(id)[0].action, 'INSERT');
        assert.equal(history(id)[0].newData.login, 'history-test');

        // UPDATE: зміна ролі
        db.prepare(`
            UPDATE users SET role = ? WHERE id = ?
        `).run('admin', id);

        assert.equal(history(id).length, 2);
        assert.equal(history(id)[1].oldData.role, 'manager');
        assert.equal(history(id)[1].newData.role, 'admin');

        // UPDATE: зміна лише passwordHash
        db.prepare(`
            UPDATE users SET passwordHash = ? WHERE id = ?
        `).run('SECRET_HASH_2', id);

        assert.equal(history(id).length, 3);
        assert.equal(history(id)[2].action, 'UPDATE');

        // UPDATE без змін не створює нової події
        db.prepare(`
            UPDATE users SET role = ? WHERE id = ?
        `).run('admin', id);

        assert.equal(history(id).length, 3);

        // DELETE
        db.prepare('DELETE FROM users WHERE id = ?').run(id);

        const events = history(id);
        assert.deepEqual(
            events.map((event) => event.action),
            ['INSERT', 'UPDATE', 'UPDATE', 'DELETE']
        );

        assert.equal(events[3].newData, null);
        assert.equal(events[3].oldData.role, 'admin');

        // Перевіряємо, що жоден запис не містить хешів.
        const rawHistory = db.prepare(`
            SELECT oldData, newData
            FROM data_history
            WHERE tableName = 'users'
        `).all();

        for (const entry of rawHistory) {
            const json = JSON.stringify(entry);

            assert.equal(json.includes('passwordHash'), false);
            assert.equal(json.includes('SECRET_HASH_1'), false);
            assert.equal(json.includes('SECRET_HASH_2'), false);
        }
    } finally {
        db?.close();

        if (server.exitCode === null && server.signalCode === null) {
            const exited = new Promise((resolve) => {
                server.once('exit', resolve);
            });
            server.kill();
            await exited;
        }

        fs.rmSync(tmpDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100
        });
    }
});
