#!/usr/bin/env node
'use strict';

/**
 * Free S&P 500 dataset builder (no paid market API):
 * - Constituents: DataHub CSV (+ GitHub raw mirror fallback)
 * - Quotes: Yahoo Finance batch (if allowed) else Stooq (last close + prior-session % change) + SEC shares ≈ cap
 * - TTM revenue / net income: SEC EDGAR company facts (us-gaap quarterly)
 *
 * Required for SEC (fair access): set SEC_CONTACT_EMAIL in .env to your email.
 *
 * Optional env:
 *   OUT_FILE=./data.json
 *   CONSTITUENTS_CSV_URLS=url1,url2
 *   YAHOO_BATCH_SIZE=40
 *   SEC_REQUEST_DELAY_MS=150
 *   YAHOO_USER_AGENT=Mozilla/5.0 ...
 *   SEC_USER_AGENT=Custom full User-Agent string (overrides SEC_CONTACT_EMAIL-based default)
 */

const fs = require('node:fs/promises');
const path = require('node:path');

function loadDotEnvFile() {
  const dotenvPath = path.resolve(process.cwd(), '.env');
  try {
    const text = require('node:fs').readFileSync(dotenvPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (_) { /* no .env */ }
}

loadDotEnvFile();

const DEFAULT_CONSTITUENTS_URLS = [
  'https://datahub.io/core/s-and-p-500-companies/r/constituents.csv',
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv'
];

const CONSTITUENTS_CSV_URLS = (
  process.env.CONSTITUENTS_CSV_URLS
    ? process.env.CONSTITUENTS_CSV_URLS.split(',').map(s => s.trim()).filter(Boolean)
    : [process.env.CONSTITUENTS_CSV_URL].filter(Boolean)
).length
  ? (
      process.env.CONSTITUENTS_CSV_URLS
        ? process.env.CONSTITUENTS_CSV_URLS.split(',').map(s => s.trim()).filter(Boolean)
        : [process.env.CONSTITUENTS_CSV_URL || DEFAULT_CONSTITUENTS_URLS[0]]
    )
  : DEFAULT_CONSTITUENTS_URLS;

const OUT_FILE = path.resolve(process.cwd(), process.env.OUT_FILE || 'data.json');
const YAHOO_BATCH_SIZE = Math.min(80, Math.max(10, Number(process.env.YAHOO_BATCH_SIZE || 40)));
const SEC_REQUEST_DELAY_MS = Math.max(80, Number(process.env.SEC_REQUEST_DELAY_MS || 150));

const YAHOO_UA = process.env.YAHOO_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SEC_CONTACT = process.env.SEC_CONTACT_EMAIL || '';
const SEC_UA = process.env.SEC_USER_AGENT
  || (SEC_CONTACT
    ? `S&P500BubbleChart/1.0 (contact: ${SEC_CONTACT})`
    : '');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace('.', '-');
}

/** Yahoo often uses BRK-B; our CSV uses the same after normalize. */
function yahooSymbol(sym) {
  return String(sym || '').trim().toUpperCase();
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = (cols[j] || '').trim();
    }
    if (row.Symbol || row.symbol) out.push(row);
  }
  return out;
}

async function fetchTextWithRetry(url, maxRetries = 3) {
  let lastErr = null;
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      const res = await fetch(url, { headers: { Accept: 'text/csv,text/plain,*/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${url}`);
      return res.text();
    } catch (e) {
      lastErr = e;
      if (i < maxRetries) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

async function loadConstituents() {
  let csvText = null;
  let lastErr = null;
  for (const url of CONSTITUENTS_CSV_URLS) {
    try {
      csvText = await fetchTextWithRetry(url, 2);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!csvText) throw lastErr || new Error('Failed to download constituents CSV.');

  const rows = parseCsv(csvText);
  const seen = new Set();
  const list = [];
  for (const row of rows) {
    const symbol = normalizeSymbol(row.Symbol || row.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    list.push({
      symbol,
      name: row.Security || row.name || symbol,
      sector: row['GICS Sector'] || row.sector || 'Unknown'
    });
  }
  if (list.length < 450) {
    throw new Error(`Unexpected constituents count: ${list.length}`);
  }
  return list;
}

async function fetchSecJson(url) {
  if (!SEC_UA) {
    throw new Error(
      'Set SEC_CONTACT_EMAIL (or SEC_USER_AGENT) in .env for SEC EDGAR access. See https://www.sec.gov/os/accessing-edgar-data'
    );
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': SEC_UA,
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`SEC HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function yahooBrowserHeaders() {
  return {
    'User-Agent': YAHOO_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://finance.yahoo.com/',
    Origin: 'https://finance.yahoo.com'
  };
}

async function loadSecCikMap() {
  const data = await fetchSecJson('https://www.sec.gov/files/company_tickers.json');
  const map = new Map();
  for (const k of Object.keys(data)) {
    const row = data[k];
    const t = String(row.ticker || '').trim().toUpperCase();
    if (t) map.set(t, Number(row.cik_str));
  }
  return map;
}

async function fetchYahooQuotesFromHost(symbols, host) {
  const joined = symbols.map(yahooSymbol).join(',');
  const url = `https://${host}/v7/finance/quote?symbols=${encodeURIComponent(joined)}`;
  const res = await fetch(url, { headers: yahooBrowserHeaders() });
  if (!res.ok) {
    throw new Error(`Yahoo HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const results = body?.quoteResponse?.result;
  if (!Array.isArray(results)) {
    throw new Error('Yahoo: unexpected quote response shape');
  }
  return results;
}

async function fetchYahooQuotes(symbols) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr = null;
  for (const host of hosts) {
    try {
      return await fetchYahooQuotesFromHost(symbols, host);
    } catch (e) {
      lastErr = e;
      if (!String(e.message).includes('401') && !String(e.message).includes('403')) {
        throw e;
      }
    }
  }
  throw lastErr || new Error('Yahoo quote failed');
}

/** Map Yahoo 52-week change to chart's price_change_pct (percent points). */
function yahooChangePercent(q) {
  if (!q || typeof q !== 'object') return 0;
  const a = toNumber(q.fiftyTwoWeekChangePercent, NaN);
  if (Number.isFinite(a)) {
    if (Math.abs(a) <= 1 && a !== 0) return a * 100;
    return a;
  }
  const b = toNumber(q.fiftyTwoWeekChange, NaN);
  if (Number.isFinite(b)) return b * 100;
  const c = toNumber(q.fiftyTwoWeekHighChangePercent, NaN);
  if (Number.isFinite(c)) return c;
  return 0;
}

async function loadAllYahooQuotes(symbols) {
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < symbols.length; i += YAHOO_BATCH_SIZE) {
    chunks.push(symbols.slice(i, i + YAHOO_BATCH_SIZE));
  }
  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c];
    let attempt = 0;
    while (attempt < 5) {
      try {
        const rows = await fetchYahooQuotes(chunk);
        for (const row of rows) {
          const sym = normalizeSymbol(row.symbol);
          if (!sym) continue;
          map.set(sym, {
            price: toNumber(row.regularMarketPrice),
            market_cap_b: toNumber(row.marketCap) / 1e9,
            price_change_pct: yahooChangePercent(row)
          });
        }
        break;
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes('401') || msg.includes('403')) {
          console.warn('Yahoo blocked this environment (401/403). Will use Stooq + SEC shares for price/market cap.');
          return map;
        }
        attempt += 1;
        if (attempt >= 5) throw e;
        await sleep(2000 * attempt);
      }
    }
    await sleep(600);
    if ((c + 1) % 5 === 0) {
      console.log(`  Yahoo batches: ${c + 1}/${chunks.length}`);
    }
  }
  return map;
}

function stooqSymbol(sym) {
  return `${String(sym).trim().toLowerCase()}.us`;
}

function formatStooqCalendarDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Last close and % change vs previous session close (Stooq daily CSV, ~2 weeks window).
 * Falls back to live quote endpoint + 0% change if daily history fails.
 */
async function fetchStooqCloseAndPctChange(symbol) {
  const s = stooqSymbol(symbol);
  const d2 = new Date();
  const d1 = new Date();
  d1.setDate(d1.getDate() - 14);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&d1=${formatStooqCalendarDate(d1)}&d2=${formatStooqCalendarDate(d2)}&i=d`;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': YAHOO_UA, Accept: 'text/csv,*/*' }
      });
      if (!res.ok) throw new Error(`Stooq daily HTTP ${res.status}`);
      const text = await res.text();
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 3) throw new Error('Stooq daily: not enough rows');
      const closes = [];
      for (let i = 1; i < lines.length; i += 1) {
        const cols = lines[i].split(',');
        if (cols.length < 5) continue;
        const close = toNumber(cols[4], NaN);
        if (Number.isFinite(close) && close > 0) closes.push(close);
      }
      if (closes.length < 2) throw new Error('Stooq daily: not enough closes');
      const last = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      const pctChange = prev > 0 ? ((last - prev) / prev) * 100 : 0;
      return { close: last, pctChange };
    } catch (e) {
      lastErr = e;
      await sleep(200 * (attempt + 1));
    }
  }
  const close = await fetchStooqClose(symbol);
  return { close: toNumber(close), pctChange: 0 };
}

async function fetchStooqClose(symbol) {
  const s = stooqSymbol(symbol);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlc&h&e=csv`;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': YAHOO_UA, Accept: 'text/csv,*/*' }
      });
      if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
      const text = await res.text();
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) throw new Error('Stooq: empty');
      const cols = lines[lines.length - 1].split(',');
      const closeIdx = 6;
      const close = toNumber(cols[closeIdx], NaN);
      if (!Number.isFinite(close) || close <= 0) throw new Error('Stooq: no close');
      return close;
    } catch (e) {
      lastErr = e;
      await sleep(200 * (attempt + 1));
    }
  }
  return 0;
}

function latestSharesOutstanding(facts) {
  const tags = [
    'CommonStockSharesOutstanding',
    'EntityCommonStockSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingBasic'
  ];
  let bestVal = 0;
  let bestFiled = '';
  for (const t of tags) {
    const s = pickSharesCountSeries(facts, t);
    for (const r of s) {
      if (!r || r.val == null) continue;
      const fd = String(r.filed || r.end || '');
      if (fd >= bestFiled && toNumber(r.val) > 0) {
        bestFiled = fd;
        bestVal = toNumber(r.val);
      }
    }
    if (bestVal > 0) return bestVal;
  }
  return bestVal;
}

function pickUsdSeries(facts, tag) {
  const node = facts?.facts?.['us-gaap']?.[tag];
  const u = node?.units;
  if (!u) return [];
  const usd = u.USD || u.usd;
  return Array.isArray(usd) ? usd : [];
}

/** Share-count facts use `units.shares`, not USD (pickUsdSeries would return []). */
function pickSharesCountSeries(facts, tag) {
  const node = facts?.facts?.['us-gaap']?.[tag];
  const u = node?.units;
  if (!u) return [];
  const sh = u.shares || u.Shares;
  return Array.isArray(sh) ? sh : [];
}

function ttmFromQuarterlyFacts(usdSeries) {
  if (!usdSeries.length) return 0;
  const qRows = usdSeries.filter(r =>
    r && r.fp && /^Q[1-4]$/i.test(String(r.fp).trim()) && (r.form === '10-Q' || r.form === '10-K')
  );
  if (!qRows.length) return 0;
  qRows.sort((a, b) => String(b.filed || b.end || '').localeCompare(String(a.filed || a.end || '')));
  const seen = new Set();
  const picked = [];
  for (const r of qRows) {
    const key = `${r.fy}|${String(r.fp).toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(r);
    if (picked.length >= 4) break;
  }
  return picked.reduce((s, r) => s + toNumber(r.val), 0);
}

function ttmRevenueFromFacts(facts) {
  const tags = [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'OperatingRevenues'
  ];
  for (const t of tags) {
    const s = pickUsdSeries(facts, t);
    if (s.length) {
      const v = ttmFromQuarterlyFacts(s);
      if (v > 0) return v;
    }
  }
  return 0;
}

function ttmNetIncomeFromFacts(facts) {
  const tags = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];
  for (const t of tags) {
    const s = pickUsdSeries(facts, t);
    if (s.length) {
      const v = ttmFromQuarterlyFacts(s);
      if (v !== 0 && Number.isFinite(v)) return v;
    }
  }
  return 0;
}

async function loadSecFundamentals(cik) {
  const padded = String(cik).padStart(10, '0');
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  const facts = await fetchSecJson(url);
  const rev = ttmRevenueFromFacts(facts);
  const ni = ttmNetIncomeFromFacts(facts);
  const shares = latestSharesOutstanding(facts);
  return {
    ttm_revenue_b: rev / 1e9,
    ttm_net_income_b: ni / 1e9,
    shares_outstanding: shares
  };
}

function sanitizeRecord(r) {
  const ttmRevenue = toNumber(r.ttm_revenue_b);
  const ttmIncome = toNumber(r.ttm_net_income_b);
  return {
    symbol: r.symbol,
    name: r.name,
    sector: r.sector,
    ttm_revenue_b: ttmRevenue,
    ttm_net_income_b: ttmIncome,
    market_cap_b: toNumber(r.market_cap_b),
    price_change_pct: toNumber(r.price_change_pct),
    price: toNumber(r.price),
    profit_margin: ttmRevenue > 0 ? (ttmIncome / ttmRevenue) * 100 : 0
  };
}

function validate(records) {
  const errors = [];
  const symbols = new Set();
  for (const row of records) {
    if (!row.symbol) errors.push('symbol missing');
    if (symbols.has(row.symbol)) errors.push(`duplicate symbol: ${row.symbol}`);
    symbols.add(row.symbol);
    const nums = [
      row.ttm_revenue_b,
      row.ttm_net_income_b,
      row.market_cap_b,
      row.price_change_pct,
      row.price,
      row.profit_margin
    ];
    if (nums.some(v => !Number.isFinite(v))) {
      errors.push(`invalid numeric fields: ${row.symbol}`);
    }
  }
  return errors;
}

async function main() {
  if (!SEC_CONTACT && !process.env.SEC_USER_AGENT) {
    console.error(
      'Missing SEC_CONTACT_EMAIL (or SEC_USER_AGENT). SEC requires an identifying User-Agent. Add to .env, e.g. SEC_CONTACT_EMAIL=you@example.com'
    );
    process.exit(1);
  }

  console.log('Loading S&P 500 constituents (DataHub / mirror)...');
  const constituents = await loadConstituents();
  console.log(`Constituents: ${constituents.length}`);

  console.log('Loading SEC ticker → CIK map...');
  const cikMap = await loadSecCikMap();
  await sleep(SEC_REQUEST_DELAY_MS);

  const symbols = constituents.map(c => c.symbol);
  console.log(`Loading Yahoo quotes (${YAHOO_BATCH_SIZE} symbols per batch, optional)...`);
  const yahooMap = await loadAllYahooQuotes(symbols);
  const yahooHits = symbols.filter(s => (yahooMap.get(s)?.market_cap_b || 0) > 0).length;
  console.log(`Yahoo market cap present: ${yahooHits}/${symbols.length}`);
  if (yahooHits < 80) {
    console.log('Falling back to Stooq (last close) + SEC shares for market cap where needed.');
  }

  console.log('Loading SEC company facts + Stooq fallback (sequential)...');
  const rows = [];
  for (let i = 0; i < constituents.length; i += 1) {
    const c = constituents[i];
    if ((i + 1) % 50 === 0) console.log(`  progress: ${i + 1}/${constituents.length}`);

    const y = yahooMap.get(c.symbol) || { price: 0, market_cap_b: 0, price_change_pct: 0 };
    let fin = { ttm_revenue_b: 0, ttm_net_income_b: 0, shares_outstanding: 0 };
    const cik = cikMap.get(c.symbol);
    if (cik) {
      try {
        fin = await loadSecFundamentals(cik);
      } catch (_) {
        /* keep zeros */
      }
    }
    await sleep(SEC_REQUEST_DELAY_MS);

    let price = toNumber(y.price);
    let capB = toNumber(y.market_cap_b);
    let chg = toNumber(y.price_change_pct);
    const yahooRowOk = capB > 0 && price > 0;

    if (!yahooRowOk) {
      const st = await fetchStooqCloseAndPctChange(c.symbol);
      await sleep(80);
      price = toNumber(st.close);
      chg = toNumber(st.pctChange);
      if (toNumber(fin.shares_outstanding) > 0 && price > 0) {
        capB = (toNumber(fin.shares_outstanding) * price) / 1e9;
      } else {
        capB = 0;
      }
    }

    const ttmRevenue = toNumber(fin.ttm_revenue_b);
    const ttmIncome = toNumber(fin.ttm_net_income_b);
    rows.push({
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      ttm_revenue_b: ttmRevenue,
      ttm_net_income_b: ttmIncome,
      market_cap_b: capB,
      price_change_pct: chg,
      price,
      profit_margin: ttmRevenue > 0 ? (ttmIncome / ttmRevenue) * 100 : 0
    });
  }

  const cleaned = rows.map(sanitizeRecord).sort((a, b) => a.symbol.localeCompare(b.symbol));

  const withCap = cleaned.filter(r => r.market_cap_b > 0).length;
  const withRev = cleaned.filter(r => r.ttm_revenue_b > 0).length;
  console.log(`Output rows: ${cleaned.length} (market cap > 0: ${withCap}, revenue > 0: ${withRev})`);

  if (withCap < 50) {
    throw new Error('Too few rows have market cap (Yahoo + Stooq/SEC); aborting write.');
  }

  const validationErrors = validate(cleaned);
  if (validationErrors.length) {
    throw new Error(`Validation failed: ${validationErrors.slice(0, 5).join('; ')}`);
  }

  const payload = {
    as_of: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    data_source: yahooHits >= 80
      ? 'Constituents: DataHub CSV; Quotes: Yahoo (unofficial); Fundamentals: SEC EDGAR (TTM quarterly XBRL)'
      : 'Constituents: DataHub CSV; Quotes: Stooq close + prior-session % change; SEC shares (est. cap); Fundamentals: SEC EDGAR (TTM quarterly XBRL)',
    price_change_note_ko: yahooHits >= 80
      ? '버블 색(가격 변동률): Yahoo 기준 52주 변동 근사치.'
      : '버블 색(가격 변동률): Stooq 기준 직전 거래일 종가 대비 등락률.',
    record_count: cleaned.length,
    data: cleaned
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Done. Wrote ${cleaned.length} rows to ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
