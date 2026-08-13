# Plano de modularização incremental — Multilanguage Tool

**Objetivo:** reduzir o `index.html` (hoje ~12.8k linhas / ~708KB inline) tirando blocos coesos
para `modules/*.js`, **sem build, sem framework, sem quebrar o deploy** (GitHub Pages estático).
Não é reescrita: é recortar-e-colar guiado por testes.

> **Estado:** não urgente. Fazer quando começar a doer (typo derrubando tudo, tempo caçando código).
> Um módulo por vez, cada um deployado e validado antes do próximo.

---

## 1. O padrão (já existente — seguir, não reinventar)

A modularização **já começou**. O padrão está provado em 4 arquivos:

| Módulo | Tamanho | O que é |
|---|---|---|
| `modules/translation-engine.js` | 104KB | tagging + preview + CSV + Liquid + merge de linhas |
| `modules/approval-canvas.js` | 74KB | Approval View (canvas Figma, pins, presença) |
| `modules/folders.js` | 13KB | camada "Pasta" (IIFE + fachada `window.*`) |
| `modules/strings.js` | 7KB | i18n / textos centralizados |

**Regras do padrão (documentadas nos headers desses arquivos):**
- É **classic script de escopo global** (`<script src>`), **NÃO** ES module, **NÃO** IIFE isolado
  (exceto `folders.js`, que é opt-in). Funções continuam **globais** (chamadas por `onclick=` no
  HTML e por bare-name a partir do index) e leem os globais do app (`S`, `authCurrentUser`,
  `sbClient`, `currentProjectId`, `_campaign`, …) **por bare-name**.
- Carregado **DEPOIS** do `<script>` inline (as referências só acontecem em runtime, então a ordem
  entre módulos quase nunca importa — ver §5).
- Cada arquivo abre com um **header** explicando o que é e de quais globais depende em runtime.
- **Sem build**: continua `git push` → GitHub Pages serve. Zero toolchain.

Por que isso funciona: classic scripts compartilham o mesmo ambiente léxico global — mover uma
função pra outro arquivo `<script>` não muda nada em runtime, contanto que carregue na ordem certa.

---

## 2. Mapa do que ainda está inline (candidatos, em ordem de extração)

Faixas de linha aproximadas (banners `═══` do `index.html`) — reconferir na hora, o arquivo muda.

| # | Bloco | Linhas ~ | Módulo destino | Acoplamento | Risco |
|---|---|---|---|---|---|
| A | Version history (project_versions) | 5045–5464 | `modules/version-history.js` | baixo (usa sbClient, projGetAll) | **baixo** |
| B | Recently deleted (restaurar deletados) | 5465–6052 | `modules/recently-deleted.js` | baixo | **baixo** |
| C | Notifications (sino + painel) | 3651–4265 | `modules/notifications.js` | médio (notifAdd usado por vários) | baixo |
| D | Request Access + roteamento por URL | ~4266–4575 | `modules/access-routing.js` | médio (enterApp, projOpen, goToDashboard) | baixo |
| E | Compressão do cache (LZString + _lsGet/Set) | 4576–5044 | `modules/storage.js` | **alto** (todo save/pull usa) | médio |
| F | Presença ao vivo (Realtime Presence) | 3500–3650 | `modules/presence.js` | médio | médio |
| G | CAS / optimistic locking (rev) | 3041–3499 | `modules/sync-cas.js` | alto (save de projeto/usuário) | médio |
| H | Auth (sessão, login, users, roles) | 2366–2680 | `modules/auth.js` | alto (authCurrentUser em todo lugar) | médio |
| I | Projects/sharing/lock (dashboard data) | 2681–3040 | `modules/projects.js` | alto | médio |
| J | Campaign editor (abas email/inapp/push) | 6053–7774 | `modules/campaign-editor.js` | **muito alto** (S, DOM, render) | **alto** |
| K | Loose project editor + projOpen | 7775–9150 | `modules/project-editor.js` | muito alto | **alto** |
| L | State + Navigation + wizard (upload/origin/targets) | 9151–fim | `modules/wizard.js` | muito alto | **alto** |

**Regra de ouro da ordem:** começar pelos de **baixo acoplamento e alto volume** (A, B, C, D) —
melhor risco/retorno. Deixar o editor/wizard/state (J, K, L) por último: são o núcleo entrelaçado
com o `S` global e o DOM; só mexer quando os fáceis já provaram o fluxo e liberaram espaço.

---

## 3. Receita mecânica (por módulo)

1. **Recortar** o bloco inteiro (do banner `═══` até o próximo) do `<script>` inline do `index.html`.
2. **Criar** `modules/<nome>.js` colando o bloco, com um **header** no topo (o que é + de quais
   globais depende em runtime + que continua global/classic script). Copiar o estilo dos headers
   já existentes.
3. **Adicionar** `<script src="modules/<nome>.js"></script>` na lista do fim do `index.html`,
   **depois** do inline e respeitando dependências de load-time (ver §5).
4. **NÃO** embrulhar em IIFE nem renomear função — as globais têm que continuar globais (há
   `onclick=` no HTML apontando pra elas e chamadas bare-name entre blocos).
5. **Testar** (ver §4). Só então commitar + deployar. **Um módulo por commit.**

---

## 4. Guardrails (o que segura o risco)

- **Suíte de testes** já existe: `tests/save-and-concurrency.test.js` (`runSaveTests()`) e
  `runMergeInvariantTests()`. Rodar no console após cada extração — 0 falhas antes de deployar.
- **Smoke no preview** (a cada módulo): login → abrir projeto avulso → abrir pasta → abrir item →
  aprovar algo → voltar pro dashboard. Console sem erro.
- **grep de referências órfãs:** depois de recortar, `grep` o nome de cada função movida no
  `index.html` pra garantir que nada ficou apontando pra um símbolo agora ausente em load-time.
- **Um módulo por vez, deploy entre eles.** Se algo quebrar, o culpado é óbvio e o revert é 1 commit.
- **Banco é real (produção):** testes de escrita rodam sandboxados (neutralizar `sbClient`) —
  ver `change-logs` e a memória do projeto. Nunca disparar save/notif reais em teste.

---

## 5. Ordem de carregamento (a única pegadinha)

Referências em **runtime** (dentro de funções) não ligam pra ordem — tudo já carregou quando o
usuário clica. O que importa é referência em **load-time** (código de topo de módulo que roda ao
carregar), ex: `const X = OUTRO_GLOBAL.algo` no corpo do módulo (não dentro de função).

- Manter os módulos "de dados/infra" (storage, auth, cas) **antes** dos que os consomem no topo.
- Na dúvida, **evitar** trabalho no topo do módulo: embrulhar init em função chamada no
  `DOMContentLoaded` (o app já usa esse padrão). Assim a ordem entre módulos deixa de importar.

---

## 6. Depois do JS: CSS (opcional, fase 2)

Os dois blocos `<style>` (~1.100 + ~40 linhas) podem virar `styles.css` linkado via
`<link rel="stylesheet">`. Baixo risco (CSS é declarativo), mas ganho menor que o JS. Fazer só
depois que o JS estiver modularizado.

---

## 7. Meta e critério de parada

- **Meta prática:** `index.html` só com HTML + o `<script>` inline mínimo de bootstrap (versão,
  tema, wiring de DOMContentLoaded) + a lista de `<script src>`. Alvo: inline < ~2–3k linhas.
- **Critério de parada:** não precisa zerar. Parar quando o arquivo voltar a ser navegável e um
  typo num módulo não derrubar o app inteiro. Perfeição aqui não paga.
- **O que NÃO fazer:** adotar bundler/framework, virar ES modules com `import`/`export` (quebraria
  o `onclick=` global e exigiria build), ou reescrever lógica "de passagem". Isto é só realocação.
