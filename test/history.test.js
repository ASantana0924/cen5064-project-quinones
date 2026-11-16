// The "Value over time" chart: daily price history (prices.getHistory), the value
// and invested amount per day (domain.buildValueHistory), and the service that
// joins them for one user (service.getValueHistory).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const service = require('../src/service.js');
const { buildValueHistory, consolidateHoldings } = require('../src/domain.js');

data.configure(loadConfig({ DB_FILE: ':memory:' }));

beforeEach(() => {
  data.closeDb();
  prices.clearCacheForTests();
});

// ---- Domain: value per day ----

const closes = (pairs) => pairs.map(([date, close]) => ({ date, close }));
const manual = (ticker, shares, purchasePrice, purchaseDate) => ({ ticker, shares, purchasePrice, purchaseDate, kind: 'manual' });

test('counts each purchase from its date on, in both value and invested', () => {
  const rows = consolidateHoldings([
    manual('AAPL', 10, 100, '2026-01-01'),
    manual('AAPL', 5, 120, '2026-01-06'),
  ]);
  const history = new Map([['AAPL', closes([['2026-01-05', 110], ['2026-01-06', 120], ['2026-01-07', 130]])]]);
  const { points, missing } = buildValueHistory(rows, history);
  assert.deepStrictEqual(points, [
    { date: '2026-01-05', value: 1100, invested: 1000 },
    { date: '2026-01-06', value: 1800, invested: 1600 },
    { date: '2026-01-07', value: 1950, invested: 1600 },
  ]);
  assert.deepStrictEqual(missing, []);
});

test('drops the days before anything was owned', () => {
  const rows = consolidateHoldings([manual('MSFT', 2, 400, '2026-03-03')]);
  const history = new Map([['MSFT', closes([['2026-03-02', 390], ['2026-03-03', 410], ['2026-03-04', 420]])]]);
  assert.deepStrictEqual(buildValueHistory(rows, history).points.map((p) => p.date), ['2026-03-03', '2026-03-04']);
});

test('a synced position (no purchase date) counts on every day', () => {
  const rows = consolidateHoldings([{ ticker: 'VTI', shares: 3, purchasePrice: 200, purchaseDate: null, kind: 'synced' }]);
  const history = new Map([['VTI', closes([['2026-02-02', 210], ['2026-02-03', 215]])]]);
  assert.deepStrictEqual(buildValueHistory(rows, history).points, [
    { date: '2026-02-02', value: 630, invested: 600 },
    { date: '2026-02-03', value: 645, invested: 600 },
  ]);
});

test('carries a close forward over a day that ticker did not trade', () => {
  const rows = consolidateHoldings([manual('AAA', 1, 10, '2026-01-01'), manual('BBB', 1, 20, '2026-01-01')]);
  const history = new Map([
    ['AAA', closes([['2026-01-05', 11], ['2026-01-06', 12]])],
    ['BBB', closes([['2026-01-05', 21]])], // no close on the 6th
  ]);
  assert.deepStrictEqual(buildValueHistory(rows, history).points.at(-1), { date: '2026-01-06', value: 33, invested: 30 });
});

test('the last day uses the live price, so the chart ends on the summary total', () => {
  const rows = consolidateHoldings([manual('AAPL', 2, 100, '2026-01-01')]);
  const history = new Map([['AAPL', closes([['2026-01-05', 110], ['2026-01-06', 120]])]]);
  const { points } = buildValueHistory(rows, history, { livePrices: new Map([['AAPL', 125.5]]) });
  assert.deepStrictEqual(points.map((p) => p.value), [220, 251]);
});

test('holdings with no history are listed as missing and left out of both lines', () => {
  const rows = consolidateHoldings([manual('AAPL', 1, 100, '2026-01-01'), manual('ZZZZ', 1, 999, '2026-01-01')]);
  const history = new Map([['AAPL', closes([['2026-01-05', 110], ['2026-01-06', 111]])]]);
  const { points, missing } = buildValueHistory(rows, history);
  assert.deepStrictEqual(missing, ['ZZZZ']);
  assert.deepStrictEqual(points[0], { date: '2026-01-05', value: 110, invested: 100 });
});

test('an empty portfolio has no points', () => {
  assert.deepStrictEqual(buildValueHistory([], new Map()), { points: [], missing: [] });
});

// ---- Data: Yahoo daily history ----

// Yahoo's chart response: timestamps at market open (New York, UTC-5 here).
const NY = -18000;
const at = (date) => Date.parse(`${date}T14:30:00Z`) / 1000;
const yahooHistory = (pairs) => ({
  chart: {
    result: [{
      meta: { gmtoffset: NY, regularMarketPrice: pairs.at(-1)[1] },
      timestamp: pairs.map(([d]) => at(d)),
      indicators: { quote: [{ close: pairs.map(([, c]) => c) }] },
    }],
  },
});

function fakeFetch(routes) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const body = routes(url);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.urls = urls;
  return fn;
}

test('reads daily closes from Yahoo, dated in the exchange time zone, skipping gaps', async () => {
  prices.setFetchForTests(fakeFetch(() => yahooHistory([['2026-01-05', 110], ['2026-01-06', null], ['2026-01-07', 112.5]])));
  const history = await prices.getHistory(['aapl'], '1mo');
  assert.deepStrictEqual(history.get('AAPL'), closes([['2026-01-05', 110], ['2026-01-07', 112.5]]));
});

test('asks Yahoo for the chosen range; weekly closes for 5 years; unknown ranges mean 1y', async () => {
  const fetch = fakeFetch(() => yahooHistory([['2026-01-05', 1]]));
  prices.setFetchForTests(fetch);
  await prices.getHistory(['A'], '3mo');
  await prices.getHistory(['B'], '5y');
  await prices.getHistory(['C'], 'forever');
  assert.match(fetch.urls[0], /\/A\?range=3mo&interval=1d$/);
  assert.match(fetch.urls[1], /\/B\?range=5y&interval=1wk$/);
  assert.match(fetch.urls[2], /\/C\?range=1y&interval=1d$/);
});

test('caches history, and keeps the last history when Yahoo later fails', async () => {
  let up = true;
  const fetch = fakeFetch(() => (up ? yahooHistory([['2026-01-05', 50]]) : new Error('down')));
  prices.setFetchForTests(fetch);
  await prices.getHistory(['AAPL'], '1y');
  await prices.getHistory(['AAPL'], '1y');
  assert.strictEqual(fetch.urls.length, 1, 'second call is served from the cache');

  up = false;
  const failing = await prices.getHistory(['MSFT', 'AAPL'], '1y');
  assert.deepStrictEqual([...failing.keys()], ['AAPL'], 'MSFT has no history; AAPL is still there');
});

// ---- Service: one user's value over time ----

test("builds the chart from the user's own holdings only", async () => {
  prices.setFetchForTests(fakeFetch((url) => {
    if (url.includes('range=')) return url.includes('/AAPL') ? yahooHistory([['2026-01-05', 110], ['2026-01-06', 120]]) : new Error('none');
    return new Error('no live quotes in this test');
  }));
  service.addHolding({ ticker: 'AAPL', shares: '2', purchasePrice: '100', purchaseDate: '2025-12-01' }, '1');
  service.addHolding({ ticker: 'MSFT', shares: '9', purchasePrice: '400', purchaseDate: '2025-12-01' }, '2');

  const mine = await service.getValueHistory({ range: '1mo', userId: '1' });
  assert.deepStrictEqual(mine, {
    range: '1mo',
    points: [{ date: '2026-01-05', value: 220, invested: 200 }, { date: '2026-01-06', value: 240, invested: 200 }],
    missing: [],
  });
  assert.deepStrictEqual(await service.getValueHistory({ userId: '3' }), { range: '1y', points: [], missing: [] });
});
