// Vercel Serverless Function — Market data via Yahoo Finance (server-side)
// v2: multi-endpoint fallback (v10 query2 → v10 query1 → v8 chart per price)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Prova a ottenere un crumb Yahoo (necessario su alcune region) ────────────
async function getYahooCrumb() {
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
    });
    if (r.ok) {
      const text = await r.text();
      if (text && text.length < 50) return text.trim();
    }
  } catch (_) { /* ignore */ }
  return null;
}

// ── quoteSummary con retry su entrambi i subdomain ───────────────────────────
async function fetchQuoteSummary(ticker, crumb) {
  const modules = [
    'price', 'summaryDetail', 'defaultKeyStatistics',
    'financialData', 'calendarEvents', 'recommendationTrend', 'earnings',
  ].join(',');

  const endpoints = [
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}${crumb ? `&crumb=${encodeURIComponent(crumb)}` : ''}`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}${crumb ? `&crumb=${encodeURIComponent(crumb)}` : ''}`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!r.ok) continue;
      const body = await r.json();
      const result = body?.quoteSummary?.result?.[0];
      if (result) return result;
    } catch (_) { continue; }
  }
  return null;
}

// ── Fallback: v8/finance/chart per soli prezzo + 52w high ───────────────────
async function fetchChartFallback(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const body = await r.json();
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      regularMarketPrice: { raw: meta.regularMarketPrice ?? null },
      fiftyTwoWeekHigh:   { raw: meta.fiftyTwoWeekHigh   ?? null },
    };
  } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker mancante' });

  try {
    // Prova a ottenere crumb (non bloccante se fallisce)
    const crumb = await getYahooCrumb();

    // Fetch dati completi
    const result = await fetchQuoteSummary(ticker, crumb);

    const pr  = result?.price              || {};
    const sd  = result?.summaryDetail      || {};
    const ks  = result?.defaultKeyStatistics || {};
    const cal = result?.calendarEvents     || {};
    const rt  = result?.recommendationTrend || {};
    const ea  = result?.earnings           || {};

    // ── Prezzo — se quoteSummary manca, fallback a v8/chart ────────────────
    let prezzo   = pr.regularMarketPrice?.raw ?? null;
    let high52   = sd.fiftyTwoWeekHigh?.raw   ?? null;
    if (prezzo === null) {
      const chart = await fetchChartFallback(ticker);
      if (chart) {
        prezzo = chart.regularMarketPrice?.raw ?? null;
        high52 = chart.fiftyTwoWeekHigh?.raw   ?? null;
      }
    }

    const calo_da_high_pct = (prezzo && high52)
      ? +((1 - prezzo / high52) * 100).toFixed(1)
      : null;

    // ── Valutazione ──────────────────────────────────────────────────────────
    const fd = result?.financialData || {};
    const pe_forward    = sd.forwardPE?.raw   ?? fd.forwardPE?.raw    ?? null;
    const pe_trailing   = sd.trailingPE?.raw  ?? fd.trailingPE?.raw   ?? null;
    const eps_consenso  = ks.forwardEps?.raw  ?? null;
    const eps_anno_prec = ks.trailingEps?.raw ?? null;
    const shares_M      = ks.sharesOutstanding?.raw
      ? +(ks.sharesOutstanding.raw / 1e6).toFixed(1) : null;

    // ── Short interest ───────────────────────────────────────────────────────
    const short_interest_pct = ks.shortPercentOfFloat?.raw
      ? +(ks.shortPercentOfFloat.raw * 100).toFixed(2) : null;

    // ── Giorni al prossimo earnings ──────────────────────────────────────────
    const earningsArr = cal.earnings?.earningsDate || [];
    let giorni_al_prossimo_earnings = null;
    for (const d of earningsArr) {
      const ts = d.raw;
      if (!ts) continue;
      const diff = Math.round((ts * 1000 - Date.now()) / 86400000);
      if (diff >= 0) { giorni_al_prossimo_earnings = diff; break; }
    }

    // ── Revisioni analisti ───────────────────────────────────────────────────
    let revisioni_rialzo_90g = null, revisioni_ribasso_90g = null;
    const trends = rt.trend || [];
    if (trends.length > 0) {
      // Usa solo il periodo corrente (0m = ultimi 30gg), non la somma di tutti i periodi
      const latest = trends.find(t => t.period === '0m') || trends[0];
      if (latest) {
        revisioni_rialzo_90g  = (latest.strongBuy  || 0) + (latest.buy   || 0);
        revisioni_ribasso_90g = (latest.strongSell || 0) + (latest.sell  || 0);
      }
    }

    // ── EPS trimestrali ──────────────────────────────────────────────────────
    const epsHistory = ea.earningsChart?.quarterly || [];
    const eps_ultimi_4q = epsHistory.slice(-4).map(q => q.actual?.raw ?? null);
    while (eps_ultimi_4q.length < 4) eps_ultimi_4q.unshift(null);

    return res.status(200).json({
      prezzo,
      pe_forward,
      pe_trailing,
      eps_consenso,
      eps_anno_prec,
      eps_ultimi_4q,
      shares_M,
      short_interest_pct,
      calo_da_high_pct,
      giorni_al_prossimo_earnings,
      revisioni_rialzo_90g,
      revisioni_ribasso_90g,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Errore interno market.js' });
  }
};
