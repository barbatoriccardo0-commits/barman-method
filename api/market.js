// Vercel Serverless Function — Market data via Yahoo Finance (server-side)
// Evita CORS e ottiene dati in tempo reale: prezzo, PE, EPS, short interest, ecc.
 
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const ticker = (req.query.ticker || '').trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker mancante' });
 
  try {
    // Yahoo Finance quoteSummary — moduli necessari
    const modules = [
      'price',
      'summaryDetail',
      'defaultKeyStatistics',
      'financialData',
      'calendarEvents',
      'recommendationTrend',
      'earnings',
    ].join(',');
 
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
 
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MetodoBerman/1.0)',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
 
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return res.status(resp.status).json({ error: `Yahoo Finance HTTP ${resp.status}`, detail: text.slice(0, 200) });
    }
 
    const body = await resp.json();
    const result = body?.quoteSummary?.result?.[0];
    if (!result) return res.status(404).json({ error: 'Nessun dato Yahoo per ' + ticker });
 
    const pr  = result.price             || {};
    const sd  = result.summaryDetail     || {};
    const ks  = result.defaultKeyStatistics || {};
    const fd  = result.financialData     || {};
    const cal = result.calendarEvents    || {};
    const rt  = result.recommendationTrend || {};
    const ea  = result.earnings          || {};
 
    // ── Prezzo e variazione da 52w high ──────────────────────────────────
    const prezzo = pr.regularMarketPrice?.raw ?? null;
    const high52 = sd.fiftyTwoWeekHigh?.raw   ?? null;
    const calo_da_high_pct = (prezzo && high52)
      ? +((1 - prezzo / high52) * 100).toFixed(1)
      : null;
 
    // ── Valutazione ───────────────────────────────────────────────────────
    const pe_forward     = sd.forwardPE?.raw    ?? null;
    const pe_trailing    = sd.trailingPE?.raw   ?? null;
    const eps_consenso   = ks.forwardEps?.raw   ?? null;
    const eps_anno_prec  = ks.trailingEps?.raw  ?? null;
    const shares_M       = ks.sharesOutstanding?.raw
      ? +(ks.sharesOutstanding.raw / 1e6).toFixed(1) : null;
 
    // ── Short interest ────────────────────────────────────────────────────
    const short_interest_pct = ks.shortPercentOfFloat?.raw
      ? +(ks.shortPercentOfFloat.raw * 100).toFixed(2) : null;
 
    // ── Giorni al prossimo earnings ───────────────────────────────────────
    const earningsArr = cal.earnings?.earningsDate || [];
    let giorni_al_prossimo_earnings = null;
    for (const d of earningsArr) {
      const ts = d.raw;
      if (!ts) continue;
      const diff = Math.round((ts * 1000 - Date.now()) / 86400000);
      if (diff >= 0) { giorni_al_prossimo_earnings = diff; break; }
    }
 
    // ── Revisioni analisti (ultimi 30 giorni) ─────────────────────────────
    // recommendationTrend ha bucket "0m" (mese corrente), "−1m", "−2m", "−3m"
    let revisioni_rialzo_90g  = null;
    let revisioni_ribasso_90g = null;
    const trends = rt.trend || [];
    let upSum = 0, downSum = 0;
    for (const t of trends) {
      // Periodi 0m, -1m, -2m, -3m ≈ ultimi 90gg
      upSum   += (t.strongBuy  || 0) + (t.buy   || 0);
      downSum += (t.strongSell || 0) + (t.sell  || 0);
    }
    if (trends.length > 0) {
      revisioni_rialzo_90g  = upSum;
      revisioni_ribasso_90g = downSum;
    }
 
    // ── EPS trimestrali (ultimi 4Q dalla sezione earnings) ───────────────
    const epsHistory = ea.earningsChart?.quarterly || [];
    const eps_ultimi_4q = epsHistory
      .slice(-4)
      .map(q => q.actual?.raw ?? null);
    // Pad a 4 se meno di 4 trimestri
    while (eps_ultimi_4q.length < 4) eps_ultimi_4q.unshift(null);
 
    // ── Settore PE (Yahoo non lo restituisce direttamente — stima) ────────
    // Non disponibile in questa API; rimane AI
 
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
