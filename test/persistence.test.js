// Users' data is permanent: it's in the database file, not in the server's memory.
// Runs the real server on a real database file, stops it, starts a new server on
// the same file (a restart), and checks that every account, login and portfolio
// is still there and still separate.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config.js');
const prices = require('../src/prices.js');
const news = require('../src/news.js');
const service = require('../src/service.js');
const { createServer } = require('../server.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-persist-'));
const DB_FILE = path.join(dir, 'nested', 'folio.db'); // the folder is created on first start

const offline = async () => { throw new Error('offline'); };
prices.setFetchForTests(offline);
news.setFetchForTests(offline);

after(async () => {
  if (running) await stop({ server: running });
  fs.rmSync(dir, { recursive: true, force: true });
});

let running = null; // closed in after() if a failed assertion skipped stop()

async function start() {
  const server = createServer(loadConfig({ DB_FILE, PORT: '0' }));
  await new Promise((resolve) => server.listen(0, resolve));
  running = server;
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// The same steps as server.js on Ctrl+C.
async function stop({ server }) {
  running = null;
  await new Promise((resolve) => server.close(resolve));
  service.shutdown();
}

// A browser with one cookie, which can outlive a server (the cookie is in the browser).
function browser() {
  let cookie = '';
  const visit = async (app, url, { method = 'GET', body } = {}) => {
    const res = await fetch(app.base + url, {
      method,
      headers: { ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return visit;
}

const buy = (ticker, shares) => ({ method: 'POST', body: { ticker, shares, purchasePrice: '100', purchaseDate: '2025-06-02' } });
const tickers = (res) => res.body.rows.map((r) => `${r.ticker}:${r.shares}`);

test('accounts, logins and each user\'s holdings survive a server restart', async () => {
  const anna = browser();
  const ben = browser();

  // ---- First run ----
  let app = await start();
  await anna(app, '/api/auth/register', { method: 'POST', body: { username: 'anna', password: 'correct horse' } });
  assert.ok(fs.existsSync(DB_FILE), 'the database file is created on disk');
  await ben(app, '/api/auth/register', { method: 'POST', body: { username: 'ben', password: 'battery staple' } });
  await anna(app, '/api/holdings', buy('AAPL', '3'));
  await anna(app, '/api/holdings', buy('MSFT', '1'));
  await ben(app, '/api/holdings', buy('VTI', '10'));
  // An edit and a removal are saved too.
  const annaRows = (await anna(app, '/api/portfolio')).body.rows;
  const msft = annaRows.find((r) => r.ticker === 'MSFT').holdings[0].id;
  await anna(app, `/api/holdings/${msft}`, { method: 'PUT', body: { ticker: 'MSFT', shares: '4', purchasePrice: '100', purchaseDate: '2025-06-02' } });
  await ben(app, '/api/holdings', buy('TSLA', '1'));
  const tsla = (await ben(app, '/api/portfolio')).body.rows.find((r) => r.ticker === 'TSLA').holdings[0].id;
  await ben(app, `/api/holdings/${tsla}`, { method: 'DELETE' });
  await stop(app);

  // ---- After the restart ----
  app = await start();
  // Still logged in: the session is in the database, not in memory.
  assert.strictEqual((await anna(app, '/api/auth/me')).body.user.username, 'anna');
  assert.deepStrictEqual(tickers(await anna(app, '/api/portfolio')), ['AAPL:3', 'MSFT:4']);
  assert.deepStrictEqual(tickers(await ben(app, '/api/portfolio')), ['VTI:10']);

  // The password still works for a fresh login from a new browser.
  const annaElsewhere = browser();
  const login = await annaElsewhere(app, '/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'correct horse' } });
  assert.strictEqual(login.status, 200);
  assert.deepStrictEqual(tickers(await annaElsewhere(app, '/api/portfolio')), ['AAPL:3', 'MSFT:4']);

  // Logging out ends the session for good, across restarts too.
  await anna(app, '/api/auth/logout', { method: 'POST' });
  await stop(app);
  app = await start();
  assert.strictEqual((await anna(app, '/api/portfolio')).status, 401);
  assert.deepStrictEqual(tickers(await ben(app, '/api/portfolio')), ['VTI:10']);
  await stop(app);
});
