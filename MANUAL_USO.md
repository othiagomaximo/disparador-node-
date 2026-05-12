# 📡 Disparador WhatsApp — Manual do Usuário

Sistema de disparo em massa pela API oficial do WhatsApp (Meta Cloud API).
Online 24/7, acessível de qualquer computador com internet.

---

## 🌐 Como acessar

Abra o navegador (Chrome, Edge, Safari) e digite:

**https://moccasin-chinchilla-561405.hostingersite.com**

Vai aparecer uma tela de login.

### Login

- **Usuário:** `maximo`
- **Senha:** *(pergunte ao admin)*

---

## 📋 Antes de começar, você precisa ter 3 coisas

| O que | Como obter |
|---|---|
| **Access Token** | No Meta Business Manager → Configurações → Usuários do Sistema → seu usuário → **Gerar token** com permissão `whatsapp_business_messaging` |
| **Phone Number ID** | No WhatsApp Manager → **Números de telefone** → ali aparece o ID (15-16 dígitos) |
| **Nome do template aprovado** | No WhatsApp Manager → **Modelos de mensagem** → status "APROVADO" |

> ⚠️ Sem esses 3 valores, o sistema não dispara nada. Eles vêm da SUA conta Meta.

---

## 🎯 Passo a passo do disparo (4 etapas)

### ETAPA 1 — Configuração

Aba **Config** (primeira aba do topo).

Preencha:

| Campo | O que colocar |
|---|---|
| **Access Token** | Cole o token completo (começa com `EAA...`, uns 250 caracteres) |
| **Phone Number ID** | Cole o ID (uns 15-16 dígitos) |
| **Nome do Template** | Exato como aprovado (ex: `registrodeclientes`) |
| **Idioma** | `pt_BR` (deixa esse se for português Brasil) |
| **Threads paralelas** | `10` (mais rápido = mais arriscado pra BM. 10 é seguro) |

Clica **💾 Salvar configuração**.

Deve aparecer "✅ Salvo!" embaixo do botão.

---

### ETAPA 2 — CSV + Mapear variáveis

Aba **CSV + Mapear** (segunda aba).

#### 2.1 — Prepare o CSV

O arquivo precisa ser assim:
- **Formato:** `.csv` (planilha exportada do Excel/Numbers/Google Sheets)
- **Encoding:** UTF-8
- **Separador:** ponto-e-vírgula `;` (recomendado) ou vírgula `,`
- **Primeira linha:** nomes das colunas (cabeçalho)

**📄 Tem um arquivo `leads_exemplo.csv` pronto** que você pode usar como modelo. Ele tá assim:

```
celular;nome;plano;valor
5511999990001;João Silva;Premium;99.90
5511988880002;Maria Santos;Básico;49.90
5521977770003;Pedro Costa;Premium;99.90
5531966660004;Ana Oliveira;Empresarial;199.90
5541955550005;Carlos Souza;Básico;49.90
... (e mais 5 linhas)
```

**Como criar o seu CSV (3 caminhos):**

##### 🟢 Opção A — Editar o exemplo no Numbers/Excel (mais fácil)

1. Baixa o `leads_exemplo.csv`
2. Abre no **Numbers** (Mac) ou **Excel**
3. **Apaga as linhas de exemplo**, mantém só o cabeçalho na primeira linha
4. **Cola seus leads** (cada lead em uma linha)
5. Salva como **CSV UTF-8 (separado por vírgulas)** — o sistema converte o separador automaticamente

##### 🟢 Opção B — Exportar do Google Sheets

1. Sua planilha com leads → **Arquivo → Fazer download → Valores separados por vírgula (.csv)**
2. Tem que ter a coluna do celular + as colunas das variáveis

##### 🟢 Opção C — Criar do zero no Bloco de Notas

1. Abre o **Editor de Texto** (Mac) ou **Bloco de Notas** (Windows)
2. Primeira linha: nomes das colunas separadas por `;`
   ```
   celular;nome;plano;valor
   ```
3. Próximas linhas: dados, separados pelo mesmo `;`
   ```
   5511999990001;João Silva;Premium;99.90
   ```
4. Salva como `meus_leads.csv` (com extensão `.csv`)

**Regras importantes:**

- ✅ Coluna `celular` (ou similar) é **obrigatória** — pode chamar `telefone`, `phone`, `whatsapp` etc, você escolhe qual é na hora
- ✅ Números com ou sem `55`: o sistema normaliza automaticamente
  - `11999998888` vira `5511999998888`
  - `+55 (11) 99999-8888` vira `5511999998888`
- ✅ Demais colunas viram **variáveis do template** (`{{1}}`, `{{2}}`, etc — você escolhe a ordem)
- ❌ Não use vírgula NO MEIO de um campo sem aspas: tipo `Olá, tudo bem?` quebra. Se precisar, põe entre aspas: `"Olá, tudo bem?"`
- ❌ Não duplique a coluna do telefone

**Exemplo de mapeamento:**

Se seu template é:
> "Olá {{1}}, seu plano {{2}} foi confirmado no valor de R$ {{3}}."

E seu CSV tem `celular;nome;plano;valor`, então:
- Coluna do telefone → `celular`
- `{{1}}` → `nome`
- `{{2}}` → `plano`
- `{{3}}` → `valor`

Resultado pra cada lead:
> "Olá João Silva, seu plano Premium foi confirmado no valor de R$ 99.90."

#### 2.2 — Faça upload

Clica em **Escolher arquivo** → seleciona o `.csv` → clica **📤 Subir CSV**.

Vai aparecer:
- Quantas linhas tem
- Preview das primeiras 5 linhas

#### 2.3 — Mapeie as colunas

- **Coluna do telefone:** seleciona qual coluna do seu CSV tem o número (ex: `celular`)
- **Variáveis do template:** se seu template tem `{{1}}`, `{{2}}`, `{{3}}`, mapeia cada um pra uma coluna do CSV

Exemplo:
- Seu template diz: `"Olá {{1}}, seu plano {{2}} foi confirmado."`
- `{{1}}` → coluna `nome`
- `{{2}}` → coluna `plano`

Clica **+ Adicionar variável** se precisar de mais.

> 💡 Se o seu template não tem variáveis, deixa vazio.

---

### ETAPA 3 — Disparo

Aba **Disparo** (terceira aba).

Clica **▶️ Iniciar disparo**.

Vai aparecer confirmação → **OK**.

Aí você vê **tudo ao vivo**:

| Card | Significa |
|---|---|
| **Total** | Quantos leads no CSV |
| **Enviados** ✅ | Já foram com sucesso |
| **Falhas** ❌ | Deram erro (número errado, sem WhatsApp, etc) |
| **Pulados** ⏭️ | Já tinham sido enviados antes (sistema lembra) |

A barra de progresso enche conforme dispara. No log embaixo aparece cada envio em tempo real.

#### Pra parar no meio

Clica **⏹ Parar**. O disparo para imediatamente.

#### Quando termina

Aparece "🏁 FINALIZADO" no log.

---

### ETAPA 4 — Relatório

Aba **Relatório** (quarta aba).

Vai aparecer a lista de disparos que você já fez. Clica num pra ver detalhes.

- Vê quem foi enviado, com que status
- Botão **⬇️ Baixar CSV** baixa um relatório completo (telefone, status, motivo)

---

## ⚠️ Avisos importantes

### Códigos de erro Meta — quando o sistema para sozinho

Se a Meta retornar um desses códigos críticos, o disparo **para automaticamente** pra proteger sua BM:

| Código | O que significa |
|---|---|
| **368** | Conta temporariamente bloqueada |
| **131048** | Limite de spam |
| **131049** | Limite de pares |
| **131056** | Violação |
| **131031** | Conta restrita permanentemente |
| **133000** | Conta travada |
| **132012** | Variável errada no template |
| **132015** | Template pausado pela Meta |
| **132016** | Template desabilitado |
| **190** | Token expirado |

Se isso acontecer, **NÃO INSISTA**. Pare e investigue antes.

### Boas práticas

1. **Sempre teste primeiro com 5 números seus** antes de disparar pra lista grande
2. **Não dispare em horário ruim** (madrugada, feriado) — chance maior de denúncia
3. **Lista tem que ter opt-in** (as pessoas concordaram em receber) — senão a Meta bloqueia
4. **Templates de marketing têm limite menor** que utility/auth
5. **Comece com 100-500 disparos/dia** se a BM é nova. Aumenta gradualmente

### Limites da Meta (tier de envio)

A Meta libera mais conforme você dispara sem problema:

- Novo: **250 disparos/dia**
- Tier 1: **1.000/dia**
- Tier 2: **10.000/dia**
- Tier 3: **100.000/dia**
- Tier 4: ilimitado

---

## 🆘 Problemas comuns

### "Configure token, phone ID e template antes"

Você não salvou a configuração. Volta na aba 1, preenche tudo, clica **💾 Salvar**.

### "Suba o CSV primeiro"

Você precisa subir o CSV antes de disparar. Volta na aba 2.

### Nenhuma mensagem chegou

Vai na aba 4 (Relatório) → vê os motivos das falhas. Comum:
- Token expirou (gera outro na Meta)
- Phone Number ID errado
- Template com nome errado
- Variável `{{N}}` com formato diferente do aprovado

### "Já existe disparo em andamento"

Já tem um disparo rodando. Vai na aba 3 e espera terminar (ou clica **⏹ Parar**).

### Cliquei em "Iniciar" mas nada acontece

Recarrega a página (F5) → faz login de novo → tenta de novo.

---

## 🚪 Sair

No canto direito do topo, clica em **Sair**.

---

## 📞 Suporte

Se algo não funciona ou tem dúvida, pede ajuda ao admin que configurou o sistema.

---

**Bons disparos!** 🚀
