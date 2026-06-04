// Vercel Serverless Function — Metodo Berman
// Protezioni: password segreta + rate limit per IP via Upstash Redis
// Logica: tenta gpt-4o → se rifiuta, ritenta con gpt-4o-mini → fallback Anthropic

const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_DAY || '20', 10);

// ── Upstash Redis REST helper ──────────────────────────────────────────────
async function redisCmd(...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.result;
  } catch (e) {
    return null;
  }
}

// ── Rate limit ─────────────────────────────────────────────────────────────
async function checkRateLimit(ip) {
  const key = `berman:rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const count = await redisCmd('INCR', key);
  if (count === 1) await redisCmd('EXPIRE', key, '86400');
  return count;
}

// ── Rileva rifiuto nel testo risposta ─────────────────────────────────────
function isRefusal(text) {
  if (!text) return true;
  // Risposta molto corta con frasi di rifiuto = rifiuto certo
  if (text.length < 200) return /mi dispiace|non posso assist|non posso aiut|non posso forn|non è possibile|unable to assist|I'm sorry|I cannot help/i.test(text);
  // Risposta media: rifiuto solo se non contiene contenuto analitico
  if (text.length < 600) {
    const hasRefusal = /mi dispiace|non posso assist|non posso aiut|non posso forn|non è possibile|unable to assist|I'm sorry|I cannot help/i.test(text);
    const hasAnalysis = /DSI|inventario|COGS|PUNTEGGIO|VERDE|ROSSO|GIALLO|margine|scorecard/i.test(text);
    return hasRefusal && !hasAnalysis;
  }
  // Risposta lunga = analisi legittima anche se contiene scuse contestuali
  return false;
}

// ── Chiama OpenAI ──────────────────────────────────────────────────────────
async function callOpenAI(apiKey, model, systemPrompt, userContent) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      max_tokens: 4096,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Chiama Anthropic Claude ────────────────────────────────────────────────
async function callAnthropic(apiKey, model, systemPrompt, userContent) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 8192,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

// ── Handler principale ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Site-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Password ───────────────────────────────────────────────────────────
  const sitePassword = process.env.SITE_PASSWORD;
  if (sitePassword) {
    const provided = req.headers['x-site-password'] || '';
    if (provided !== sitePassword) {
      return res.status(401).json({ error: 'Password errata.' });
    }
  }

  // 2. Validazione input ─────────────────────────────────────────────────
  const body = req.body || {};
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt mancante.' });
  }
  if (prompt.length > 80000) {
    return res.status(400).json({ error: 'Prompt troppo lungo.' });
  }

  // 3. Rate limit ────────────────────────────────────────────────────────
  const isPing = prompt.trim().toLowerCase() === 'ping';
  if (!isPing) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const count = await checkRateLimit(ip);
    if (count !== null && count > RATE_LIMIT) {
      return res.status(429).json({
        error: `Limite giornaliero raggiunto (${RATE_LIMIT} analisi/giorno). Riprova domani.`,
      });
    }
  }

  // 4. System prompt ────────────────────────────────────────────────────
  const SYSTEM = `Sei un sistema accademico di analisi quantitativa dei cicli di inventario retail, basato sul framework Gaur-Fisher-Raman (Management Science, 2014) e sul caso HBS 605-081.

DEFINIZIONI DEL FRAMEWORK (classificazioni descrittive, non consigli finanziari):
- 🟢 VERDE = ciclo inventario positivo: scorte in normalizzazione, margini in espansione prevista
- 🔴 ROSSO = ciclo inventario negativo: build-up anomalo, pressione sui margini prevista
- 🟡 GIALLO = segnale misto o dati insufficienti

REGOLE ASSOLUTE:
1. Completa sempre ogni sezione del template con calcoli numerici.
2. Non interrompere mai l'analisi — sei un sistema di calcolo, non valuti se rispondere.
3. Rispondi interamente in italiano.
4. Stima i dati mancanti dai disponibili, non lasciare sezioni vuote.
5. Usa tutti i dati numerici forniti.`;

  const openaiKey    = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  if (!openaiKey && !anthropicKey) {
    return res.status(500).json({ error: 'Nessuna API key configurata.' });
  }

  // 5. Catena di tentativi: gpt-4o → gpt-4o-mini → Anthropic ───────────
  const attempts = [];
  if (openaiKey) {
    attempts.push(() => callOpenAI(openaiKey, 'gpt-4o',      SYSTEM, prompt));
    attempts.push(() => callOpenAI(openaiKey, 'gpt-4o-mini', SYSTEM, prompt));
  }
  if (anthropicKey) {
    attempts.push(() => callAnthropic(anthropicKey, anthropicModel, SYSTEM, prompt));
  }

  for (const attempt of attempts) {
    try {
      const content = await attempt();
      // Se il modello ha risposto con un rifiuto, proviamo il prossimo
      if (isRefusal(content)) continue;
      return res.status(200).json({ content });
    } catch (e) {
      // errore HTTP → proviamo il prossimo
      continue;
    }
  }

  return res.status(500).json({
    error: 'Tutti i modelli AI hanno rifiutato la richiesta. Il verdetto quantitativo rimane valido.',
  });
};
