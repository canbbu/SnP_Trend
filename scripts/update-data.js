#!/usr/bin/env node
'use strict';

/**
 * Update S&P 500 chart dataset using Financial Modeling Prep.
 *
 * Required env:
 *   FMP_API_KEY=...
 *
 * Optional env:
 *   FMP_BASE_URL=https://financialmodelingprep.com/api/v3
 *   OUT_FILE=./data.json
 *   CONCURRENCY=8
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = process.env.FMP_BASE_URL || 'https://financialmodelingprep.com/api/v3';
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

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function buildChunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
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

async function loadConstituents() {
  const url = `${BASE_URL}/sp500_constituent?apikey=${encodeURIComponent(API_KEY)}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('No constituents returned from provider.');
  }

  // Keep first seen ticker to avoid duplicates in provider payload.
  const seen = new Set();
  const list = [];
  for (const row of rows) {
    const symbol = normalizeSymbol(row.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    list.push({
      symbol,
      name: row.name || symbol,
      sector: row.sector || 'Unknown'
    });
  }
  return list;
}

async function loadQuotes(symbols) {
  const quoteMap = new Map();
  const symbolChunks = buildChunk(symbols, 100);

  for (const chunk of symbolChunks) {
    const joined = chunk.join(',');
    const url = `${BASE_URL}/quote/${joined}?apikey=${encodeURIComponent(API_KEY)}`;
    const rows = await fetchJson(url);
    if (Array.isArray(rows)) {
      for (const row of rows) {
        quoteMap.set(normalizeSymbol(row.symbol), {
          price: toNumber(row.price),
          market_cap_b: toNumber(row.marketCap) / 1e9,
          price_change_pct: toNumber(row.changesPercentage)
        });
      }
    }
    // Small delay to reduce chance of rate-limit bursts.
    await sleep(120);
  }

  return quoteMap;
}

async function loadIncomeTTM(symbol) {
  const url = `${BASE_URL}/income-statement/${symbol}?period=quarter&limit=4&apikey=${encodeURIComponent(API_KEY)}`;
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

  console.log('Loading quotes (price, market cap, 12m change)...');
  const quoteMap = await loadQuotes(symbols);
  console.log(`Quotes loaded: ${quoteMap.size}`);

  console.log('Loading TTM income statement data...');
  const incomeRows = await mapConcurrent(
    constituents,
    async ({ symbol }, i) => {
      if ((i + 1) % 50 === 0) {
        console.log(`  income progress: ${i + 1}/${constituents.length}`);
      }
      try {
        return { symbol, ...(await loadIncomeTTM(symbol)) };
      } catch (_) {
        return { symbol, ttm_revenue_b: 0, ttm_net_income_b: 0 };
      }
    },
    CONCURRENCY
  );
  const incomeMap = new Map(incomeRows.map(r => [r.symbol, r]));

  const merged = constituents.map(c => {
    const q = quoteMap.get(c.symbol) || {};
    const fin = incomeMap.get(c.symbol) || {};
    const ttmRevenue = toNumber(fin.ttm_revenue_b);
    const ttmIncome = toNumber(fin.ttm_net_income_b);
    const profitMargin = ttmRevenue > 0 ? (ttmIncome / ttmRevenue) * 100 : 0;

    return {
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      ttm_revenue_b: ttmRevenue,
      ttm_net_income_b: ttmIncome,
      market_cap_b: toNumber(q.market_cap_b),
      price_change_pct: toNumber(q.price_change_pct),
      price: toNumber(q.price),
      profit_margin: profitMargin
    };
  });

  // Keep rows that can render properly and sort by ticker.
  const cleaned = merged
    .filter(r => r.symbol && Number.isFinite(r.market_cap_b))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const validationErrors = validate(cleaned);
  if (validationErrors.length) {
    throw new Error(`Validation failed: ${validationErrors.slice(0, 5).join('; ')}`);
  }

  const payload = {
    as_of: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    data_source: 'Financial Modeling Prep API v3',
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
