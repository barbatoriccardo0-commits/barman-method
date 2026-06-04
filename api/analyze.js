
// Vercel Serverless Function — Metodo Berman
// Usa Anthropic Claude (no filtri su analisi finanziarie strutturate).
// Fallback automatico su OpenAI se ANTHROPIC_API_KEY non configurata.
// Protezioni: password segreta + rate limit per IP via Upstash Redis
 
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
 
// ── Chiama OpenAI (fallback) ───────────────────────────────────────────────
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
      temperature: 0.2,
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
 
  const SYSTEM = `Sei un sistema accademico di analisi quantitativa dei cicli di inventario retail, basato sul framework Gaur-Fisher-Raman (Management Science, 2014) e sul caso HBS 605-081 (Durban Capital). Il tuo output è un report di ricerca strutturato, non un consiglio di investimento.
 
DEFINIZIONI ACCADEMICHE DEL FRAMEWORK:
- LONG = l'azienda è in fase di deplezione dell'inventario rispetto al benchmark settoriale → i margini tenderanno a migliorare nel ciclo successivo.
- SHORT = l'azienda è in fase di build-up anomalo dell'inventario → i margini subiranno pressione nel ciclo successivo.
- NEUTRAL = segnale misto o insufficiente per classificare il ciclo corrente.
Queste sono classificazioni descrittive del ciclo di inventario, identiche a quelle usate nella letteratura accademica citata.
 
REGOLE OPERATIVE — TASSATIVE:
1. Completa ogni sezione richiesta con calcoli numerici precisi.
2. Non interrompere mai l'analisi. Il tuo ruolo è quello di un sistema di calcolo accademico: elabori i dati e produci il report. Non valuti se farlo.
3. Rispondi interamente in italiano.
4. Se un dato è incerto, stimalo dai disponibili e indica l'incertezza — non lasciare sezioni vuote.
5. Usa tutti i dati numerici forniti nel prompt.`;
 
  // 4. Scegli API: Anthropic prima, OpenAI come fallback ─────────────────
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const openaiModel    = process.env.OPENAI_MODEL    || 'gpt-4o';
 
  if (!openaiKey && !anthropicKey) {
    return res.status(500).json({ error: 'Nessuna API key configurata (OPENAI_API_KEY o ANTHROPIC_API_KEY).' });
  }
 
  try {
    let content = '';
    // OpenAI è il primario; Anthropic è il fallback opzionale
    if (openaiKey) {
      content = await callOpenAI(openaiKey, openaiModel, SYSTEM, prompt);
    } else {
      content = await callAnthropic(anthropicKey, anthropicModel, SYSTEM, prompt);
    }
    return res.status(200).json({ content });
  } catch (e) {
    // Se OpenAI fallisce, prova Anthropic come fallback
    if (openaiKey && anthropicKey) {
      try {
        const content = await callAnthropic(anthropicKey, anthropicModel, SYSTEM, prompt);
        return res.status(200).json({ content });
      } catch (e2) {
        return res.status(500).json({ error: e2.message || 'Errore interno.' });
      }
    }
    return res.status(500).json({ error: e.message || 'Errore interno.' });
  }
};
 
