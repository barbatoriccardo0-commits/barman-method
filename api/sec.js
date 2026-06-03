
// Vercel Serverless Function — SEC EDGAR XBRL data (server-side)
// Necessario perché il browser non può impostare User-Agent e SEC restituisce 403
 
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const ticker = (req.query.ticker || '').trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker mancante' });
 
  const UA = 'MetodoBerman/1.0 riccardobarbato27@gmail.com';
 
  try {
    // ── 1. Trova CIK dal ticker ────────────────────────────────────────────
    const r1 = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': UA }
    });
    if (!r1.ok) return res.status(502).json({ error: `SEC tickers HTTP ${r1.status}` });
    const tMap = await r1.json();
 
    let cik = null;
    for (const k of Object.keys(tMap)) {
      if ((tMap[k].ticker || '').toUpperCase() === ticker) {
        cik = String(tMap[k].cik_str).padStart(10, '0');
        break;
      }
    }
    if (!cik) return res.status(404).json({ error: `CIK non trovato per ${ticker}` });
 
    // ── 2. Scarica company facts XBRL ─────────────────────────────────────
    const r2 = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { 'User-Agent': UA }
    });
    if (!r2.ok) return res.status(502).json({ error: `SEC facts HTTP ${r2.status}` });
    const facts = await r2.json();
 
    const gaap = facts.facts?.['us-gaap'];
    if (!gaap) return res.status(404).json({ error: 'Nessun dato us-gaap per ' + ticker });
 
    // ── 3. Helper: estrae serie trimestrale (ultimi ≤12 Q) ────────────────
    function getQ(tags, unit = 'USD') {
      for (const tag of tags) {
        const d = gaap[tag];
        if (!d?.units?.[unit]) continue;
        const byPeriod = {};
        for (const x of d.units[unit]) {
          if (x.form !== '10-Q' || !x.fp || !x.fy) continue;
          const key = `${x.fy}-${x.fp}`;
          if (!byPeriod[key] || x.filed > byPeriod[key].filed) byPeriod[key] = x;
        }
        const sorted = Object.values(byPeriod)
          .sort((a, b) => new Date(a.end) - new Date(b.end))
          .slice(-12);
        if (sorted.length >= 4) return sorted;
      }
      return [];
    }
 
    function getQPerShare(tags) {
      for (const tag of tags) {
        const d = gaap[tag];
        if (!d?.units) continue;
        const unitKey = Object.keys(d.units).find(k => k.includes('/shares') || k.includes('shares'));
        if (!unitKey) continue;
        const byPeriod = {};
        for (const x of d.units[unitKey]) {
          if (x.form !== '10-Q' || !x.fp || !x.fy) continue;
          const key = `${x.fy}-${x.fp}`;
          if (!byPeriod[key] || x.filed > byPeriod[key].filed) byPeriod[key] = x;
        }
        const sorted = Object.values(byPeriod)
          .sort((a, b) => new Date(a.end) - new Date(b.end))
          .slice(-12);
        if (sorted.length >= 2) return sorted;
      }
      return [];
    }
 
    function getQShares(tags) {
      for (const tag of tags) {
        const d = gaap[tag];
        if (!d?.units?.shares) continue;
        const byPeriod = {};
        for (const x of d.units.shares) {
          if (x.form !== '10-Q' || !x.fp || !x.fy) continue;
          const key = `${x.fy}-${x.fp}`;
          if (!byPeriod[key] || x.filed > byPeriod[key].filed) byPeriod[key] = x;
        }
        const sorted = Object.values(byPeriod)
          .sort((a, b) => new Date(a.end) - new Date(b.end))
          .slice(-4);
        if (sorted.length >= 1) return sorted;
      }
      return [];
    }
 
    // ── 4. Estrai ogni metrica ────────────────────────────────────────────
    const inv    = getQ(['InventoryNet']);
    const cogs   = getQ(['CostOfRevenue','CostOfGoodsSold','CostOfGoodsAndServicesSold']);
    const rev    = getQ(['Revenues','SalesRevenueNet','RevenueFromContractWithCustomerExcludingAssessedTax','SalesRevenueGoodsNet']);
    const gp     = getQ(['GrossProfit']);
    const ap     = getQ(['AccountsPayableCurrent']);
    const ocf    = getQ(['NetCashProvidedByUsedInOperatingActivities']);
    const ar     = getQ(['AccountsReceivableNetCurrent','ReceivablesNetCurrent']);
    const debtLT = getQ(['LongTermDebt','LongTermDebtNoncurrent','LongTermDebtAndCapitalLeaseObligations']);
    const debtST = getQ(['ShortTermBorrowings','CommercialPaper','NotesPayableToBanksCurrent']);
    const cash   = getQ(['CashAndCashEquivalentsAtCarryingValue','CashAndCashEquivalents']);
    const epsQ   = getQPerShare(['EarningsPerShareDiluted','EarningsPerShareBasic']);
    const sharesArr = getQShares(['CommonStockSharesOutstanding','CommonStockSharesIssued']);
 
    // Usa inventario come riferimento, fallback a ricavi
    const ref = inv.length >= 4 ? inv : (rev.length >= 4 ? rev : null);
    if (!ref) return res.status(404).json({ error: 'Dati insufficienti (< 4 trimestri)' });
 
    // ── 5. Allineamento per fy+fp ─────────────────────────────────────────
    function lookup(arr, item) {
      const m = arr.find(d => d.fp === item.fp && d.fy === item.fy);
      return m !== undefined ? +(m.val / 1e6).toFixed(1) : null;
    }
 
    const periodi = ref.map(d => `${d.fp} FY${d.fy}`);
    const inv_M   = ref.map(d => lookup(inv, d));
    const cogs_M  = ref.map(d => lookup(cogs, d));
    const rev_M   = ref.map(d => lookup(rev, d));
    const ap_M    = ref.map(d => lookup(ap, d));
    const ocf_M   = ref.map(d => lookup(ocf, d));
    const ar_M    = ref.map(d => lookup(ar, d));
 
    const gm_pct = ref.map(d => {
      const r = lookup(rev, d), g = (() => { const m = gp.find(x => x.fp===d.fp && x.fy===d.fy); return m ? +(m.val/1e6).toFixed(1) : null; })(), c = lookup(cogs, d);
      if (g !== null && r) return +((g / r) * 100).toFixed(1);
      if (r && c !== null) return +((1 - c / r) * 100).toFixed(1);
      return null;
    });
 
    const nd_M = ref.map(d => {
      const lt = lookup(debtLT, d), st = lookup(debtST, d), c = lookup(cash, d);
      if (lt === null && st === null) return null;
      return +(((lt || 0) + (st || 0) - (c || 0))).toFixed(1);
    });
 
    // EPS per share (val già in $/share, non dividere per 1e6)
    const eps_4q_raw = ref.map(d => {
      const m = epsQ.find(e => e.fp === d.fp && e.fy === d.fy);
      return m ? +m.val.toFixed(2) : null;
    });
    const last4eps = eps_4q_raw.filter(v => v !== null).slice(-4);
    while (last4eps.length < 4) last4eps.unshift(null);
 
    // Shares più recente ($M)
    const latestShares = sharesArr.length
      ? +(sharesArr[sharesArr.length - 1].val / 1e6).toFixed(1)
      : null;
 
    return res.status(200).json({
      cik,
      periodi,
      inv_M,
      cogs_M,
      rev_M,
      gm_pct,
      ap_M,
      ocf_M,
      ar_M,
      nd_M,
      eps_4q: last4eps,
      latestShares,
    });
 
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Errore interno sec.js' });
  }
};
