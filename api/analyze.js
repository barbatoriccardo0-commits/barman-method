// Vercel Serverless Function — Metodo Berman
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
    return null; // Redis non raggiungibile → skip rate limit
  }
}

// ── Rate limit: max RATE_LIMIT richieste per IP al giorno ──────────────────
async function checkRateLimit(ip) {
  const key = `berman:rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const count = await redisCmd('INCR', key);
  if (count === 1) await redisCmd('EXPIRE', key, '86400');
  return count;
}

// ── Handler principale ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Site-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Verifica password ─────────────────────────────────────────────────
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
  if (prompt.length > 60000) {
    return res.status(400).json({ error: 'Prompt troppo lungo.' });
  }

  // 3. Rate limit — solo per prompt reali (non ping di verifica password) ─
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

  // 4. Chiave OpenAI ─────────────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  const model  = process.env.OPENAI_MODEL || 'gpt-4o';
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY non configurata sul server.' });
  }

  // 5. Chiamata OpenAI ───────────────────────────────────────────────────
  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.2,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({
        error: err.error?.message || `Errore OpenAI (${upstream.status})`,
      });
    }

    const data    = await upstream.json();
    const content = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ content });

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Errore interno.' });
  }
};
