#!/usr/bin/env node
'use strict';

/**
 * Update S&P 500 chart dataset using DataHub constituents + FMP stable APIs.
 *
 * Required env:
 *   FMP_API_KEY=...
 *
 * Optional env:
 *   FMP_BASE_URL=https://financialmodelingprep.com/stable
 *   CONSTITUENTS_CSV_URL=https://datahub.io/core/s-and-p-500-companies/r/constituents.csv
 *   OUT_FILE=./data.json
 *   CONCURRENCY=8
 */

const fs = require('node:fs/promises');
const path = require('node:path');

function loadDotEnvFile() {
  // Minimal .env loader (no dependency) so `node scripts/update-data.js` works locally.
  // Format: KEY=VALUE, ignores blank lines and comments (# ...).
  const dotenvPath = path.resolve(process.cwd(), '.env');
  try {
    const text = require('node:fs').readFileSync(dotenvPath, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (_) {
    // ignore if no .env exists
  }
}

loadDotEnvFile();

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = process.env.FMP_BASE_URL || 'https://financialmodelingprep.com/stable';
const CONSTITUENTS_CSV_URL = process.env.CONSTITUENTS_CSV_URL || 'https://datahub.io/core/s-and-p-500-companies/r/constituents.csv';
const OUT_FILE = path.resolve(process.cwd(), process.env.OUT_FILE || 'data.json');
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

if (!API_KEY) {
  console.error('Missing FMP_API_KEY environment variable.');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${url}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: 'text/csv,text/plain,*/*' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${url}`);
  }
  return res.text();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace('.', '-');
}

async function mapConcurrent(items, worker, concurrency) {
  const out = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await worker(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, run));
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      // CSV escape for quotes: "" within quoted field
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
    // Expect at least Symbol/ Security
    if (row.Symbol || row.symbol) out.push(row);
  }

  return out;
}

async function loadConstituents() {
  const csvText = await fetchText(CONSTITUENTS_CSV_URL);
  const rows = parseCsv(csvText);
  if (!rows.length) {
    throw new Error('No constituents returned from DataHub CSV.');
  }

  // Keep first seen ticker to avoid duplicates.
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
  return list;
}

async function loadQuote(symbol) {
  const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(API_KEY)}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { price: 0, market_cap_b: 0, price_change_pct: 0 };
  }
  const row = rows[0];
  return {
    price: toNumber(row.price),
    market_cap_b: toNumber(row.marketCap) / 1e9,
    price_change_pct: toNumber(row.changePercentage, toNumber(row.changesPercentage))
  };
}

async function loadIncomeTTM(symbol) {
  const url = `${BASE_URL}/income-statement?symbol=${encodeURIComponent(symbol)}&period=quarter&limit=4&apikey=${encodeURIComponent(API_KEY)}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ttm_revenue_b: 0, ttm_net_income_b: 0 };
  }
  const revenue = rows.reduce((acc, r) => acc + toNumber(r.revenue), 0);
  const netIncome = rows.reduce((acc, r) => acc + toNumber(r.netIncome), 0);
  return {
    ttm_revenue_b: revenue / 1e9,
    ttm_net_income_b: netIncome / 1e9
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
  console.log('Loading S&P 500 constituents...');
  const constituents = await loadConstituents();
  const symbols = constituents.map(c => c.symbol);
  console.log(`Constituents: ${symbols.length}`);

  const merged = constituents.map(c => {
    return {
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      ttm_revenue_b: 0,
      ttm_net_income_b: 0,
      market_cap_b: 0,
      price_change_pct: 0,
      price: 0,
      profit_margin: 0
    };
  });

  console.log('Loading quote + TTM fields from FMP stable...');
  const enriched = await mapConcurrent(
    merged,
    async (row, i) => {
      if ((i + 1) % 25 === 0) {
        console.log(`  progress: ${i + 1}/${merged.length}`);
      }

      let quote = { price: 0, market_cap_b: 0, price_change_pct: 0 };
      let fin = { ttm_revenue_b: 0, ttm_net_income_b: 0 };

      try {
        quote = await loadQuote(row.symbol);
      } catch (_) {
        // Keep defaults for missing quote rows.
      }
      await sleep(60);

      try {
        fin = await loadIncomeTTM(row.symbol);
      } catch (_) {
        // Keep defaults for missing filing rows.
      }

      const ttmRevenue = toNumber(fin.ttm_revenue_b);
      const ttmIncome = toNumber(fin.ttm_net_income_b);
      return {
        ...row,
        ttm_revenue_b: ttmRevenue,
        ttm_net_income_b: ttmIncome,
        market_cap_b: toNumber(quote.market_cap_b),
        price_change_pct: toNumber(quote.price_change_pct),
        price: toNumber(quote.price),
        profit_margin: ttmRevenue > 0 ? (ttmIncome / ttmRevenue) * 100 : 0
      };
    },
    CONCURRENCY
  );

  // Keep rows that can render properly and sort by ticker.
  const cleaned = enriched
    .filter(r => r.symbol && Number.isFinite(r.market_cap_b))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const validationErrors = validate(cleaned);
  if (validationErrors.length) {
    throw new Error(`Validation failed: ${validationErrors.slice(0, 5).join('; ')}`);
  }

  const payload = {
    as_of: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    data_source: 'Constituents: DataHub CSV, Metrics: Financial Modeling Prep stable API',
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
