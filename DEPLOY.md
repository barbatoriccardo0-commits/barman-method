# Deploy su Vercel — Metodo Berman
### Protezioni attive: password segreta + rate limit per IP (Upstash Redis)

---

## Struttura del progetto

```
berman-vercel/
├── api/
│   └── analyze.js        ← backend serverless (proxy OpenAI + protezioni)
├── public/
│   └── index.html        ← il sito completo (con modal di accesso)
├── vercel.json           ← configurazione routing
└── DEPLOY.md             ← questo file
```

---

## Passo 1 — Crea un account Vercel

Vai su [vercel.com](https://vercel.com) e registrati (gratis, basta un account GitHub).

---

## Passo 2 — Crea il database Redis gratuito su Upstash

Upstash è il provider Redis ufficialmente consigliato da Vercel. Piano gratuito: 10.000 richieste/giorno.

1. Vai su [console.upstash.com](https://console.upstash.com) e registrati
2. Clicca **"Create Database"**
3. Nome: `berman-ratelimit` · Tipo: **Regional** · Regione: `eu-west-1` (o la più vicina)
4. Clicca **Create**
5. Una volta creato, vai su **REST API** e copia:
   - `UPSTASH_REDIS_REST_URL` (es. `https://xxxx.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN` (token lungo)

---

## Passo 3 — Carica il progetto su GitHub

1. Crea un repository GitHub (anche privato)
2. Carica l'intera cartella `berman-vercel/` come contenuto del repo
   ```bash
   cd berman-vercel
   git init
   git add .
   git commit -m "Berman Method platform"
   git remote add origin https://github.com/TUO_USERNAME/berman-method.git
   git push -u origin main
   ```

---

## Passo 4 — Importa su Vercel

1. Vai su [vercel.com/new](https://vercel.com/new)
2. Clicca **"Import Git Repository"** e seleziona il tuo repo
3. Clicca **Deploy**

---

## Passo 5 — Configura le variabili d'ambiente (CRITICO)

Nel dashboard Vercel → **Settings → Environment Variables**, aggiungi queste variabili:

| Nome | Valore | Descrizione |
|------|--------|-------------|
| `OPENAI_API_KEY` | `sk-proj-...` | La tua chiave OpenAI |
| `SITE_PASSWORD` | una password a scelta | Password che gli utenti devono inserire per accedere |
| `UPSTASH_REDIS_REST_URL` | copiato dal passo 2 | URL del database Redis |
| `UPSTASH_REDIS_REST_TOKEN` | copiato dal passo 2 | Token di autenticazione Redis |
| `OPENAI_MODEL` | `gpt-4o` | Opzionale: modello da usare |
| `RATE_LIMIT_PER_DAY` | `20` | Opzionale: max analisi per IP al giorno (default 20) |

Seleziona **Production, Preview, Development** per tutte le variabili. Poi clicca **Save**.

---

## Passo 6 — Redeploy

Vai su **Deployments** → tre puntini sull'ultimo deploy → **Redeploy**.

Il sito è ora online con:
- 🔒 Modal di accesso con password all'apertura
- ⏱ Max 20 analisi al giorno per IP (configurabile)
- 🔑 Chiave OpenAI mai visibile agli utenti

---

## Come funziona

```
Browser utente
    │
    │  1. Inserisce password → verificata dal backend
    │  2. POST /api/analyze { prompt } + header X-Site-Password
    ▼
Vercel Serverless Function (api/analyze.js)
    ├── Verifica password contro SITE_PASSWORD
    ├── Controlla rate limit su Upstash Redis (per IP, resetta a mezzanotte UTC)
    └── Se tutto ok → chiama OpenAI con OPENAI_API_KEY
    ▼
OpenAI API → risposta → browser → renderizzata nel sito
```

---

## Costi stimati

| Componente | Costo |
|------------|-------|
| Vercel hosting | **Gratis** (piano Hobby) |
| Upstash Redis | **Gratis** fino a 10.000 req/giorno |
| OpenAI GPT-4o | ~$0.01–0.05 per analisi |
| OpenAI GPT-4o mini | ~$0.001–0.005 per analisi |

---

## FAQ

**Posso cambiare la password senza toccare il codice?**
Sì — basta aggiornare la variabile `SITE_PASSWORD` su Vercel e fare redeploy.

**Come condivido l'accesso?**
Comunica semplicemente la password agli utenti autorizzati.

**Il rate limit è per utente o per IP?**
Per IP. Se tutti gli utenti sono dietro lo stesso router (NAT), condividono il limite. In quel caso aumenta `RATE_LIMIT_PER_DAY`.

**Cosa succede se supero il limite?**
Gli utenti vedono un messaggio: "Limite giornaliero raggiunto. Riprova domani." Il limite si azzera a mezzanotte UTC.
