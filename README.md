# Disparador WhatsApp — Node.js

Sistema profissional de disparo em massa pela WhatsApp Cloud API (Meta), portado pra Node.js + Express com autenticação, SQLite e SSE ao vivo.

## ✨ Features

- 🔐 **Login obrigatório** (1 usuário/senha em variáveis de ambiente)
- 📤 Upload de CSV com detecção automática de delimitador (`;` ou `,`)
- 🎯 Mapeamento visual de variáveis pro template Meta
- ⚡ Disparo concorrente com `p-limit` (configurável)
- 📊 Dashboard ao vivo via SSE
- 🛑 Parada automática em códigos críticos da Meta (368, 131048, 131049, 131056, 131031, 133000, 132012, 132015, 132016, 190)
- 💾 Persistência em SQLite (substitui o `enviados.txt` do Python)
- 🔄 Dedupe automático: pula quem já foi enviado
- 📑 Histórico de runs + download de relatório CSV

## 🚀 Quick start (local)

```bash
# 1. Instala dependências
npm install

# 2. Cria .env
cp .env.example .env

# 3. Gera hash da senha de login
npm run hash-pwd MinhaSenha123!

# Cola o hash no LOGIN_PASSWORD_HASH do .env.
# Gera SESSION_SECRET com: openssl rand -hex 32

# 4. Roda
npm start
```

Abre [http://localhost:3000](http://localhost:3000), faz login e configura na tela.

## ☁️ Deploy na Hostinger (Node.js Premium Business)

### 1. Sobe o código no GitHub

```bash
cd disparador-node
git add .
git commit -m "Initial commit"
git push -u origin main
```

### 2. No painel Hostinger

1. hPanel → seu domínio → **Avançado → Node.js**
2. Clica em **Implantar via GitHub**
3. Autoriza GitHub e seleciona o repositório `disparador-node`
4. Configurações:
   - **Application root**: `/` (raiz)
   - **Startup file**: `index.js`
   - **Node version**: 20 ou maior
   - **Branch**: `main`

### 3. Variáveis de ambiente

Na seção de variáveis, adiciona:

| Variável | Valor |
|---|---|
| `SESSION_SECRET` | (gera com `openssl rand -hex 32`) |
| `LOGIN_USER` | `maximo` (ou outro) |
| `LOGIN_PASSWORD_HASH` | (do `npm run hash-pwd <senha>`) |
| `META_API_VERSION` | `v22.0` |

### 4. Deploy

Hostinger detecta `package.json` e roda `npm install` + `npm start`. Em ~1-2 min tá no ar.

## 🔧 Como gerar credenciais

### Senha de login (hash bcrypt)

```bash
npm run hash-pwd "SuaSenha@2026"
```

Saída:

```
Cole no .env (variável LOGIN_PASSWORD_HASH):

$2a$10$abc123...
```

### Session secret

```bash
openssl rand -hex 32
```

## 📂 Estrutura

```
disparador-node/
├── index.js              # Entry Express
├── package.json
├── lib/
│   ├── db.js             # SQLite init + helpers
│   ├── cloud-api.js      # Chamadas Meta + parada automática
│   ├── disparo-engine.js # Worker pool + SSE events
│   ├── normalize.js      # Normalizar telefone BR
│   └── auth-middleware.js
├── views/
│   ├── login.html
│   ├── login-fail.html
│   └── app.html          # 4 telas em tabs
├── public/
│   ├── style.css
│   └── app.js            # Client-side
├── scripts/
│   └── hash-password.js
├── data/                 # SQLite (gerado)
└── uploads/              # CSVs temporários (gerado)
```

## 🐛 Códigos de erro Meta que param o disparo

Quando a Meta retorna um desses, o disparo PAUSA automaticamente:

| Código | Significa |
|---|---|
| 368 | Account temporarily blocked |
| 131048 | Spam rate limit hit |
| 131049 | Pair rate limit |
| 131056 | Account is in violation |
| 131031 | Account permanently restricted |
| 133000 | Account locked |
| 132012 | Variable mismatch |
| 132015 | Template paused |
| 132016 | Template disabled |
| 190 | Token expired/invalid |

## 📝 Notas

- Banco SQLite local — pra cluster, troca por Postgres/MySQL (`better-sqlite3` → `pg` ou `mysql2`)
- 1 disparo por vez (concorrência interna alta, mas não dois jobs simultâneos)
- Sessions em SQLite também — sobrevive a restart

## 🛡️ Segurança

- ⚠️ **NUNCA** suba com `LOGIN_PASSWORD_HASH` padrão
- ✅ HTTPS automático no Hostinger via Let's Encrypt
- ✅ Token Meta nunca é exposto no frontend (vive só no banco e variáveis)
- ✅ Sessões HttpOnly + SameSite Lax
