// Vercel Serverless Function — SEC EDGAR XBRL (server-side, bypassa CORS + User-Agent)
// v3: aggrega TUTTI i tag XBRL in un pool unico, prende i 12 TRIMESTRI PIÙ RECENTI.
// Risolve il problema dati storici (2010) quando la company cambia tag nel tempo.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker mancante' });

  const UA = 'MetodoBerman/1.0 riccardobarbato27@gmail.com';

  try {
    // ── 1. CIK dal ticker ──────────────────────────────────────────────────
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

    // ── 2. Company facts XBRL ─────────────────────────────────────────────
    const r2 = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { 'User-Agent': UA }
    });
    if (!r2.ok) return res.status(502).json({ error: `SEC facts HTTP ${r2.status}` });
    const facts = await r2.json();

    const gaap = facts.facts?.['us-gaap'];
    if (!gaap) return res.status(404).json({ error: 'Nessun dato us-gaap per ' + ticker });

    // ── 3. Helpers ─────────────────────────────────────────────────────────

    // getQ: aggrega TUTTI i tag candidati in un unico pool, poi prende i 12 più recenti.
    // Per item duration (income statement, con x.start): filtra a ~3 mesi (Q trimestrale puro).
    // Per item instant (balance sheet, senza x.start): passa sempre.
    function getQ(tags) {
      const pool = {}; // key = "fy-fp", valore = entry più recente
      for (const tag of tags) {
        const d = gaap[tag];
        if (!d?.units?.USD) continue;
        for (const x of d.units.USD) {
          if (x.form !== '10-Q' || !x.fp || !x.fy || !x.end) continue;
          // Duration item → solo periodi ~3 mesi
          if (x.start) {
            const days = (new Date(x.end) - new Date(x.start)) / 86400000;
            if (days < 60 || days > 110) continue;
          }
          const key = `${x.fy}-${x.fp}`;
          if (!pool[key] || x.filed > pool[key].filed) pool[key] = x;
        }
      }
      // Prendi i 12 più recenti (sort DESCENDING per data fine, slice(0,12), poi riporta in ordine cronologico)
      const sorted = Object.values(pool)
        .sort((a, b) => new Date(b.end) - new Date(a.end))
        .slice(0, 12)
        .sort((a, b) => new Date(a.end) - new Date(b.end));
      return sorted.length >= 2 ? sorted : [];
    }

    // getQFromYTD: per item che sono sempre YTD (OCF, COGS se non disponibili trimestrali).
    // Aggrega tutti i tag, poi per ogni fiscal year deriva i valori trimestrali per differenza.
    function getQFromYTD(tags) {
      // Pool globale per fy: tutti gli YTD filing da tutti i tag
      const byFYFP = {}; // key = "fy-fp", valore = entry più recente
      for (const tag of tags) {
        const d = gaap[tag];
        if (!d?.units?.USD) continue;
        for (const x of d.units.USD) {
          if (x.form !== '10-Q' || !x.fp || !x.fy || !x.start || !x.end) continue;
          const days = (new Date(x.end) - new Date(x.start)) / 86400000;
          if (days < 55) continue; // scarta rumori
          const key = `${x.fy}-${x.fp}`;
          if (!byFYFP[key] || x.filed > byFYFP[key].filed) byFYFP[key] = x;
        }
      }

      // Raggruppa per fiscal year
      const byFY = {};
      for (const x of Object.values(byFYFP)) {
        if (!byFY[x.fy]) byFY[x.fy] = [];
        byFY[x.fy].push(x);
      }

      // Per ogni FY calcola i valori trimestrali per differenza YTD
      const quarterly = [];
      for (const fy of Object.keys(byFY).sort()) {
        const periods = byFY[fy].sort((a, b) =>
          (new Date(a.end) - new Date(a.start)) - (new Date(b.end) - new Date(b.start))
        );
        let prevYTD = 0;
        for (const x of periods) {
          const qVal = x.val - prevYTD;
          prevYTD = x.val;
          quarterly.push({ fy: x.fy, fp: x.fp, end: x.end, filed: x.filed, val: qVal });
        }
      }

      const sorted = quarterly
        .sort((a, b) => new Date(b.end) - new Date(a.end))  // descending → più recenti per primi
        .slice(0, 12)
        .sort((a, b) => new Date(a.end) - new Date(b.end)); // back to ascending cronologico
      return sorted.length >= 2 ? sorted : [];
    }

    // Variante per EPS (unità USD/shares) — aggrega tutti i tag
    function getQPerShare(tags) {
      const pool = {};
      for (const tag of tags) {
        const d = gaap[tag];
        if (!d?.units) continue;
        const unitKey = Object.keys(d.units).find(k => k.toLowerCase().includes('shares'));
        if (!unitKey) continue;
        for (const x of d.units[unitKey]) {
          if (x.form !== '10-Q' || !x.fp || !x.fy) continue;
          if (x.start && x.end) {
            const days = (new Date(x.end) - new Date(x.start)) / 86400000;
            if (days < 60 || days > 110) continue;
          }
          const key = `${x.fy}-${x.fp}`;
          if (!pool[key] || x.filed > pool[key].filed) pool[key] = x;
        }
      }
      return Object.values(pool)
        .sort((a, b) => new Date(a.end) - new Date(b.end))
        .slice(-12);
    }

    // Variante per shares outstanding (unità shares)
    function getQShares(tags) {
      const pool = {};
      for (const tag of tags) {
        const d = gaap[tag];
        if (!d?.units?.shares) continue;
        for (const x of d.units.shares) {
          if (x.form !== '10-Q' || !x.fp || !x.fy) continue;
          const key = `${x.fy}-${x.fp}`;
          if (!pool[key] || x.filed > pool[key].filed) pool[key] = x;
        }
      }
      return Object.values(pool)
        .sort((a, b) => new Date(a.end) - new Date(b.end))
        .slice(-4);
    }

    // ── 4. Estrai ogni metrica ─────────────────────────────────────────────
    const inv = getQ([
      'InventoryNet','Inventories','InventoriesNet',
      'InventoryFinishedGoods','InventoryFinishedGoodsNetOfReserves',
    ]);

    // COGS: prova trimestrale diretto, fallback YTD-diff
    let cogs = getQ([
      'CostOfRevenue','CostOfGoodsSold','CostOfGoodsAndServicesSold',
      'CostOfGoodsSoldExcludingDepletionDepreciationAndAmortization',
    ]);
    if (cogs.length < 2) cogs = getQFromYTD([
      'CostOfRevenue','CostOfGoodsSold','CostOfGoodsAndServicesSold',
    ]);

    // Revenues: prova trimestrale diretto, fallback YTD-diff
    let rev = getQ([
      'Revenues','SalesRevenueNet','NetRevenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueGoodsNet','SalesRevenueServicesNet',
      'RevenueNotFromContractWithCustomer',
    ]);
    if (rev.length < 2) rev = getQFromYTD([
      'Revenues','SalesRevenueNet','NetRevenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
    ]);

    const gp = getQ(['GrossProfit','GrossProfitLoss']);

    const ap = getQ([
      'AccountsPayableCurrent','AccountsPayable',
      'AccountsPayableAndAccruedLiabilitiesCurrent',
      'AccountsPayableRelatedPartiesCurrent',
    ]);

    // OCF: sempre YTD nel cash flow → usa YTD-diff
    const ocf = getQFromYTD([
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByOperatingActivities',
      'NetCashFromOperatingActivities',
    ]);

    const ar = getQ([
      'AccountsReceivableNetCurrent','ReceivablesNetCurrent',
      'AccountsReceivableNet','TradeReceivablesNetCurrent',
      'AccountsReceivableGrossCurrent',
    ]);

    const debtLT = getQ([
      'LongTermDebt','LongTermDebtNoncurrent',
      'LongTermDebtAndCapitalLeaseObligations',
      'LongTermNotesPayable','LongTermDebtCurrent',
    ]);

    const debtST = getQ([
      'ShortTermBorrowings','CommercialPaper',
      'NotesPayableToBanksCurrent','ShortTermDebt',
      'LinesOfCredit',
    ]);

    const cashArr = getQ([
      'CashAndCashEquivalentsAtCarryingValue',
      'CashAndCashEquivalents','Cash',
      'CashCashEquivalentsAndShortTermInvestments',
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    ]);

    const epsArr    = getQPerShare(['EarningsPerShareDiluted','EarningsPerShareBasic']);
    const sharesArr = getQShares(['CommonStockSharesOutstanding','CommonStockSharesIssued']);

    // ── 5. Sceglie il riferimento temporale ───────────────────────────────
    // Prende la serie con più dati recenti. Preferisce inventario, poi ricavi.
    function mostRecentEnd(arr) {
      if (!arr.length) return 0;
      return Math.max(...arr.map(x => new Date(x.end).getTime()));
    }
    let ref = null;
    if (inv.length >= 2 && rev.length >= 2) {
      // Prendi quella con i dati più recenti
      ref = mostRecentEnd(inv) >= mostRecentEnd(rev) ? inv : rev;
    } else if (inv.length >= 2) {
      ref = inv;
    } else if (rev.length >= 2) {
      ref = rev;
    }
    if (!ref) return res.status(404).json({ error: 'Dati insufficienti per ' + ticker });

    // ── 6. Allineamento fy+fp ─────────────────────────────────────────────
    function lookup(arr, item) {
      const m = arr.find(d => d.fp === item.fp && d.fy === item.fy);
      return (m !== undefined && m !== null) ? +(m.val / 1e6).toFixed(2) : null;
    }

    const periodi = ref.map(d => `${d.fp} FY${d.fy}`);
    const inv_M   = ref.map(d => lookup(inv,  d));
    const cogs_M  = ref.map(d => lookup(cogs, d));
    const rev_M   = ref.map(d => lookup(rev,  d));
    const ap_M    = ref.map(d => lookup(ap,   d));
    const ocf_M   = ref.map(d => lookup(ocf,  d));
    const ar_M    = ref.map(d => lookup(ar,   d));

    const gm_pct = ref.map(d => {
      const r = lookup(rev, d);
      const g = lookup(gp,  d);
      const c = lookup(cogs, d);
      if (g !== null && r) return +((g / r) * 100).toFixed(2);
      if (r && c !== null) return +((1 - c / r) * 100).toFixed(2);
      return null;
    });

    const nd_M = ref.map(d => {
      const lt = lookup(debtLT, d), st = lookup(debtST, d), c = lookup(cashArr, d);
      if (lt === null && st === null) return null;
      return +(((lt || 0) + (st || 0) - (c || 0))).toFixed(2);
    });

    // EPS (già in $/share — non dividere per 1e6)
    const eps_all = ref.map(d => {
      const m = epsArr.find(e => e.fp === d.fp && e.fy === d.fy);
      return m ? +m.val.toFixed(2) : null;
    });
    const last4eps = eps_all.filter(v => v !== null).slice(-4);
    while (last4eps.length < 4) last4eps.unshift(null);

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
