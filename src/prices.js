// Data tier (external API client): the only file that fetches market prices.
// Sources are tried in the order listed in PROVIDERS: Yahoo Finance first (no key
// needed), then Finnhub when FINNHUB_API_KEY is set. Quotes are cached briefly so page polling
// and repeated loads don't hit rate limits.

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 5000;

let fetchImpl = (...args) => fetch(...args);
let finnhubApiKey = null;
const cache = new Map(); // ticker -> { price, asOf, source, fetchedAt }

// Called once at startup (server.js) or by a test.
function configure(config) {
  finnhubApiKey = config.finnhubApiKey;
}

function setFetchForTests(fake) {
  fetchImpl = fake;
}

function clearCacheForTests() {
  cache.clear();
  historyCache.clear();
}

async function getJson(url) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// asOf is an ISO timestamp of the quote itself (falls back to now if the API omits it).
const isoFromSeconds = (s) => new Date(s > 0 ? s * 1000 : Date.now()).toISOString();

async function fromYahoo(ticker) {
  const body = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  const meta = body.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!(price > 0)) throw new Error('no price');
  const quote = { price, asOf: isoFromSeconds(meta.regularMarketTime), source: 'yahoo' };
  // Yahoo also names the company and says whether it's a stock or a fund; news
  // matching and the diversification score use these when they're there.
  const name = meta.longName || meta.shortName;
  if (name) quote.name = name;
  if (meta.instrumentType) quote.assetType = meta.instrumentType;
  return quote;
}

// Finnhub returns c = 0 for symbols it doesn't know.
async function fromFinnhub(ticker) {
  const body = await getJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(finnhubApiKey)}`);
  const price = Number(body.c);
  if (!(price > 0)) throw new Error('no price');
  return { price, asOf: isoFromSeconds(body.t), source: 'finnhub' };
}

// Price sources, tried in order. Each one says when it can be used, so adding,
// removing, or reordering a source means editing this list, not fetchQuote.
const PROVIDERS = [
  { name: 'yahoo', isEnabled: () => true, fetch: fromYahoo },
  { name: 'finnhub', isEnabled: () => Boolean(finnhubApiKey), fetch: fromFinnhub },
];

// Returns the first quote an enabled provider can give; throws the last
// provider's error if none can.
async function fetchQuote(ticker) {
  let lastErr = new Error('no price source configured');
  for (const provider of PROVIDERS.filter((p) => p.isEnabled())) {
    try {
      return await provider.fetch(ticker);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Returns Map<ticker, { price, asOf, source, name?, assetType? }> for the tickers
// that could be priced.
// A ticker that fails everywhere keeps its last cached quote if there is one;
// otherwise it is logged and left out. This never throws.
// fresh: true ignores the cache (the "Refresh prices" button).
async function getQuotes(tickers, { fresh = false } = {}) {
  const now = Date.now();
  const quotes = new Map();
  const toFetch = [];
  for (const ticker of new Set(tickers.map((t) => t.toUpperCase()))) {
    const hit = cache.get(ticker);
    if (!fresh && hit && now - hit.fetchedAt < CACHE_MS) quotes.set(ticker, hit);
    else toFetch.push(ticker);
  }

  const results = await Promise.allSettled(toFetch.map(fetchQuote));
  results.forEach((r, i) => {
    const ticker = toFetch[i];
    if (r.status === 'fulfilled') {
      const quote = { ...r.value, fetchedAt: now };
      cache.set(ticker, quote);
      quotes.set(ticker, quote);
    } else if (cache.has(ticker)) {
      quotes.set(ticker, cache.get(ticker)); // keep showing the last known price
    } else {
      console.warn(`No live price for ${ticker}: ${r.reason?.message}`);
    }
  });

  return new Map([...quotes].map(([t, { fetchedAt, ...quote }]) => [t, quote]));
}

// ---- Daily price history (for the "Value over time" chart) ----

// The chart's time ranges, as Yahoo names them. Longer ranges use weekly closes so
// the chart stays light.
const HISTORY_RANGES = {
  '1mo': { interval: '1d' },
  '3mo': { interval: '1d' },
  '6mo': { interval: '1d' },
  '1y': { interval: '1d' },
  '5y': { interval: '1wk' },
};
const HISTORY_CACHE_MS = 60 * 60 * 1000; // closes don't change once the day is over
const historyCache = new Map(); // "TICKER|range" -> { closes, fetchedAt }

// [{ date: 'YYYY-MM-DD', close }] oldest first, dated in the exchange's own time zone
// so a close lines up with the purchase dates users type in.
async function historyFromYahoo(ticker, range) {
  const { interval } = HISTORY_RANGES[range];
  const body = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`);
  const result = body.chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const offset = Number(result?.meta?.gmtoffset) || 0;
  const points = [];
  stamps.forEach((s, i) => {
    const close = Number(closes[i]);
    if (!(close > 0)) return; // Yahoo leaves gaps as null
    const date = new Date((s + offset) * 1000).toISOString().slice(0, 10);
    if (points.at(-1)?.date === date) points[points.length - 1] = { date, close }; // keep the day's last
    else points.push({ date, close });
  });
  if (points.length === 0) throw new Error('no history');
  return points;
}

// Returns Map<ticker, [{ date, close }]> for the tickers that have history in that
// range. Like getQuotes: a ticker that fails keeps its last cached history, or is
// left out. Never throws. Unknown ranges fall back to 1y.
async function getHistory(tickers, range = '1y') {
  if (!HISTORY_RANGES[range]) range = '1y';
  const now = Date.now();
  const out = new Map();
  const toFetch = [];
  for (const ticker of new Set(tickers.map((t) => t.toUpperCase()))) {
    const hit = historyCache.get(`${ticker}|${range}`);
    if (hit && now - hit.fetchedAt < HISTORY_CACHE_MS) out.set(ticker, hit.closes);
    else toFetch.push(ticker);
  }
  const results = await Promise.allSettled(toFetch.map((t) => historyFromYahoo(t, range)));
  results.forEach((r, i) => {
    const ticker = toFetch[i];
    const key = `${ticker}|${range}`;
    if (r.status === 'fulfilled') {
      historyCache.set(key, { closes: r.value, fetchedAt: now });
      out.set(ticker, r.value);
    } else if (historyCache.has(key)) {
      out.set(ticker, historyCache.get(key).closes);
    } else {
      console.warn(`No price history for ${ticker}: ${r.reason?.message}`);
    }
  });
  return out;
}

module.exports = { configure, getQuotes, getHistory, HISTORY_RANGES, setFetchForTests, clearCacheForTests };
