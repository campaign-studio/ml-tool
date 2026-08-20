/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * modules/live-coedit.js — CO-EDIÇÃO AO VIVO (Fase 1): trazer a edição do outro pra dentro
 * do editor JÁ ABERTO, sem atropelar quem está digitando.
 *
 * O PROBLEMA QUE ISTO RESOLVE
 * O merge já era correto (mergeItemRows/mergeLooseData fundem célula a célula, com tombstones)
 * e o Realtime já avisava a aba. Só que sbOnProjectsChanged puxava os dados e re-renderizava
 * apenas o DASHBOARD — quem estava com o editor aberto nunca via a mudança do colega. Pior no
 * caso das PASTAS, que não têm trava nenhuma: duas pessoas já editavam a mesma pasta hoje, e
 * cada uma só descobria a edição da outra ao reabrir (_campaign é um snapshot desanexado —
 * projGetAll() faz JSON.parse a cada chamada, então o objeto aberto nunca acompanha o store).
 *
 * AS DUAS REGRAS QUE MANTÊM ISSO SEGURO
 *   1. NUNCA re-renderizar a grade inteira por causa de um patch — perderia foco, cursor e
 *      scroll de quem está digitando. Patch é cirúrgico: uma célula por vez, via data-r/data-c.
 *   2. NUNCA sobrescrever uma célula "suja" (editada aqui e ainda não confirmada pelo banco)
 *      nem a célula que está com o CURSOR dentro. Nessas, o remoto é descartado — a próxima
 *      gravação leva o valor local e o merge decide, exatamente como já decidia.
 *
 * O QUE ESTA FASE NÃO FAZ (de propósito)
 *   - Mudança ESTRUTURAL (linha/idioma criado ou removido pelo outro) não é aplicada à força:
 *     mexer na forma da grade embaixo de quem digita é justamente o que a regra 1 proíbe. Em vez
 *     disso aparece uma barra discreta com "Reload", e a pessoa escolhe a hora.
 *   - Duas pessoas na MESMA célula ao mesmo tempo continua sendo LWW (quem salva por último
 *     vence) — é o comportamento que o merge sempre teve. Fechar isso é a Fase 3 (soft-lock por
 *     célula via presença), não um CRDT.
 *
 * Depende (em runtime, nunca no load) de globais do index.html: S, _campaign,
 * _campaignItemIndex, currentProjectId, _gridBodyId, projGetAll, parseBrazeCsv,
 * sortLangsForDisplay, autoH, syncAllRowHeights, updatePreviewText, updateCampaignPreviewCell.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // Acesso preguiçoso ao estado do app. ATENÇÃO: as variáveis de estado do index.html são
  // declaradas com let/const no topo (S, _campaign, _campaignItemIndex, _gridBodyId,
  // currentProjectId) — e binding let/const de topo NÃO vira propriedade de window. Elas vivem no
  // escopo léxico global, que os <script> clássicos compartilham, então a leitura tem que ser pelo
  // IDENTIFICADOR (com guarda de typeof, senão dá ReferenceError). Mesmo padrão do approval-canvas.js.
  // Já as FUNÇÕES são declarações de função, essas sim expostas em window.
  const gS       = () => (typeof S !== 'undefined' ? S : null);
  const gCamp    = () => (typeof _campaign !== 'undefined' ? _campaign : null);
  const gCampIdx = () => (typeof _campaignItemIndex !== 'undefined' ? _campaignItemIndex : -1);
  const gBodyId  = () => (typeof _gridBodyId !== 'undefined' ? _gridBodyId : null);
  const gProjId  = () => (typeof currentProjectId !== 'undefined' ? currentProjectId : null);
  const gApprv   = () => (typeof _approverMode !== 'undefined' ? !!_approverMode : false);
  const fn = (name) => (typeof global[name] === 'function' ? global[name] : null);

  const APPLY_DEBOUNCE_MS = 150;  // junta a rajada de eventos do Realtime num apply só
  const FLASH_MS = 1600;          // duração do realce da célula que mudou

  // Células editadas AQUI e ainda não confirmadas pelo banco. Enquanto uma célula está nesse
  // mapa, nenhum valor remoto entra nela. Chave: projectId|itemId|rowId|lang.
  const _dirty = new Map();
  // Última "assinatura" do conteúdo remoto já aplicado, por superfície — evita reprocessar
  // (parse de CSV, varredura de linhas) quando o pull não trouxe nada novo pra esta tela.
  const _lastSig = Object.create(null);
  let _applyTimer = null;
  let _pendingStructural = false;

  const _key = (projectId, itemId, rowId, lang) =>
    String(projectId || '') + '|' + String(itemId || '') + '|' + String(rowId || '') + '|' + String(lang || '');

  const _str = (v) => (v == null ? '' : String(v));

  /* ── SUJEIRA (dirty) ───────────────────────────────────────────────────────────────────── */

  // Chamado por setCellV/setCampaignCell a cada tecla. Marca a célula como "minha, ainda não
  // confirmada" — é o que impede o eco do próprio save (ou a edição de um colega) de apagar
  // uma letra que acabou de ser digitada.
  function liveMarkDirty(projectId, itemId, rowId, lang, value) {
    if (!projectId || !rowId || !lang) return;
    _dirty.set(_key(projectId, itemId, rowId, lang), { value: _str(value), at: Date.now() });
  }

  // Chamado quando o banco CONFIRMA a gravação de um projeto (fim do CAS). Só sai da lista de
  // sujas a célula cujo valor confirmado é exatamente o que estava pendente — se a pessoa
  // digitou mais uma letra entre montar o payload e o banco responder, a célula continua suja
  // (senão o próximo patch remoto comeria essa letra).
  function liveOnProjectPersisted(projectId, payload) {
    if (!projectId || !payload || !_dirty.size) return;
    const persisted = _payloadCellMap(payload);
    if (!persisted) return;
    const prefix = String(projectId) + '|';
    _dirty.forEach((entry, key) => {
      if (key.indexOf(prefix) !== 0) return;
      const rest = key.slice(prefix.length);          // itemId|rowId|lang
      if (persisted[rest] !== undefined && persisted[rest] === entry.value) _dirty.delete(key);
    });
  }

  // Mapa "itemId|rowId|lang -> valor" do payload como ele está gravado. Pasta guarda os itens
  // como objetos (fácil); projeto avulso guarda o CSV como STRING, então precisa passar pelo
  // mesmo parser que o reload usa — assim a comparação é contra o que o banco realmente tem.
  function _payloadCellMap(payload) {
    const map = Object.create(null);
    if (payload && payload.kind === 'campaign') {
      (payload.items || []).forEach(it => {
        (it.rows || []).forEach(r => {
          const t = r.translations || {};
          Object.keys(t).forEach(l => { map[String(it.id) + '|' + r.id + '|' + l] = _str(t[l]); });
        });
      });
      return map;
    }
    const csv = payload && payload.data && payload.data.csv;
    const parse = fn('parseBrazeCsv');
    if (!csv || !parse) return null;
    let parsed = null;
    try { parsed = parse(csv); } catch (e) { return null; }
    if (!parsed || !parsed.byLang) return null;
    Object.keys(parsed.byLang).forEach(lang => {
      (parsed.byLang[lang] || []).forEach(r => { map['|' + r.id + '|' + lang] = _str(r.tl); });
    });
    return map;
  }

  /* ── APLICAR O REMOTO ──────────────────────────────────────────────────────────────────── */

  // Ponto de entrada público: chamado depois de todo pull bem-sucedido. Debounced e sempre
  // fora da pilha do pull — um save em andamento (saveCampaignProject faz pull no meio) não
  // pode ser reentrado por um patch no meio do caminho.
  function liveScheduleApply() {
    clearTimeout(_applyTimer);
    _applyTimer = setTimeout(() => { try { liveApplyRemote(); } catch (e) { console.warn('live-coedit:', e); } }, APPLY_DEBOUNCE_MS);
  }

  function liveApplyRemote() {
    const projectId = gProjId();
    if (!projectId) return 0;
    const bodyId = gBodyId();
    const body = bodyId && document.getElementById(bodyId);
    if (!body || !body.offsetParent) return 0; // grade não está na tela → nada a fazer
    // Discrimina a superfície pela GRADE renderizada, não por _campaign: projOpen() abre um
    // projeto avulso SEM zerar _campaign (só goToDashboard zera), então _campaign pode estar
    // preso numa pasta anterior enquanto o editor avulso está na tela — e aí o patch iria pro
    // lugar errado. _gridBodyId é setado por quem montou a grade, então reflete a tela real.
    return (bodyId === 'campGstb') ? _applyCampaign(body) : _applyLoose(body);
  }

  // ── Projeto avulso ──
  function _applyLoose(body) {
    const S = gS();
    const projectId = gProjId();
    if (!S || !S.csv || !Array.isArray(S.csv.rows) || !S.csv.rows.length) return 0;
    const stored = (fn('projGetAll') ? global.projGetAll() : []).find(x => x.id === projectId);
    if (!stored || !stored.data || !stored.data.csv) return 0;

    const sigKey = projectId + '|';
    if (_lastSig[sigKey] === stored.data.csv) return 0; // nada novo desde o último apply
    _lastSig[sigKey] = stored.data.csv;

    const map = _payloadCellMap(stored);
    if (!map) return 0;
    const remote = Object.create(null);
    Object.keys(map).forEach(k => { remote[k.slice(1)] = map[k]; }); // tira o "itemId" vazio

    const langs = fn('sortLangsForDisplay') ? global.sortLangsForDisplay(S.csv.langs) : (S.csv.langs || []);
    const n = _patchCells({
      body, rows: S.csv.rows, langs, remote, projectId, itemId: null,
      // silent: the preview anchor belongs to whoever is TYPING. A teammate's edit must refresh
      // the text without stealing the highlight or scrolling — otherwise everyone's preview jumps
      // to wherever the other person happens to be working.
      onCell: (ri, lang) => { const u = fn('updatePreviewText'); if (u) try { u(ri, lang, { silent: true }); } catch (e) {} }
    });
    _checkStructural(projectId, S.csv.rows, langs, remote);
    if (n) _afterPatch(body, n);
    return n;
  }

  // ── Item de pasta ──
  function _applyCampaign(body) {
    const camp = gCamp();
    const idx = gCampIdx();
    if (!camp || !(idx >= 0)) return 0;
    const item = (camp.items || [])[idx];
    if (!item || !Array.isArray(item.rows) || !item.rows.length) return 0;

    const storedCamp = (fn('projGetAll') ? global.projGetAll() : []).find(x => x.id === camp.id);
    if (!storedCamp) return 0;
    const storedItem = (storedCamp.items || []).find(it => it.id === item.id);
    if (!storedItem || !Array.isArray(storedItem.rows)) return 0;

    // Assinatura barata: updatedAt do item + quantidade de linhas. Toda edição remota passa por
    // touchCampaignItem, que bumpa o updatedAt — então isso pega qualquer mudança real de conteúdo.
    const sigKey = camp.id + '|' + item.id;
    const sig = String(storedItem.updatedAt || 0) + ':' + storedItem.rows.length;
    if (_lastSig[sigKey] === sig) return 0;
    _lastSig[sigKey] = sig;

    const remote = Object.create(null);
    storedItem.rows.forEach(r => {
      const t = r.translations || {};
      Object.keys(t).forEach(l => { remote[r.id + '|' + l] = _str(t[l]); });
    });

    const langs = fn('sortLangsForDisplay') ? global.sortLangsForDisplay(item.langs || []) : (item.langs || []);
    const n = _patchCells({
      body, rows: item.rows, langs, remote, projectId: camp.id, itemId: item.id,
      onCell: (ri, lang) => { try { _silentCampaignPreviewCell(item, item.rows[ri], lang); } catch (e) {} }
    });
    _checkStructural(camp.id, item.rows, langs, remote);
    if (n) _afterPatch(body, n);
    return n;
  }

  // Coração do patch: percorre as células visíveis e aplica só as que mudaram, pulando as que
  // não podem ser tocadas. Atualiza o MODELO junto com o DOM — sem isso o próximo autosave
  // reenviaria o valor velho e desfaria a edição do colega.
  function _patchCells(o) {
    const active = document.activeElement;
    let applied = 0;
    o.rows.forEach((row, ri) => {
      if (!row || !row.id) return;
      o.langs.forEach((lang, ci) => {
        const rv = o.remote[row.id + '|' + lang];
        if (rv === undefined) return;
        row.translations = row.translations || {};
        const cur = _str(row.translations[lang]);
        if (rv === cur) return;
        if (_dirty.has(_key(o.projectId, o.itemId, row.id, lang))) return; // minha edição pendente

        const td = o.body.querySelector('td.tl-cell[data-r="' + ri + '"][data-c="' + ci + '"]');
        const field = td ? td.querySelector('textarea, input.img-url') : null;
        if (field && field === active) return; // cursor está aqui dentro — não puxa o tapete

        row.translations[lang] = rv;
        if (field) {
          field.value = rv;
          const ah = fn('autoH');
          if (ah && field.tagName === 'TEXTAREA') try { ah(field); } catch (e) {}
        }
        if (td) {
          td.classList.toggle('tl-missing', !rv.trim());
          td.classList.remove('mlt-live-updated');
          void td.offsetWidth;                 // reinicia a animação se a mesma célula mudar de novo
          td.classList.add('mlt-live-updated');
          setTimeout(() => td.classList.remove('mlt-live-updated'), FLASH_MS);
        }
        if (o.onCell) o.onCell(ri, lang);
        applied++;
      });
    });
    return applied;
  }

  // Same idea as the loose silent path, for a folder item. Deliberately does NOT call
  // updateCampaignPreviewCell: that one rebuilds the iframe whenever the loaded key doesn't match,
  // and a rebuild resets the scroll position — a jump caused by someone else's edit. If the right
  // preview isn't already loaded we simply skip; it will be correct the next time the user opens it.
  function _silentCampaignPreviewCell(item, row, lang) {
    const viewLang = item._activeLang || (item.langs && item.langs[0]) || null;
    if (lang !== viewLang) return;                       // not the language on screen → nothing to do
    if (item.type === 'push') {                          // push preview is plain DOM, nothing scrolls
      const r = fn('renderCampaignPreview');
      if (r) r(item, viewLang);
      return;
    }
    const iframe = document.getElementById('campaignPreviewFrame');
    const key = item.id + '::' + (viewLang || '');
    const loaded = (typeof _campPreviewLoadedKey !== 'undefined') ? _campPreviewLoadedKey : null;
    if (!iframe || !iframe.contentWindow || loaded !== key) return; // would need a rebuild → skip
    iframe.contentWindow.postMessage({
      type: 'camp-update', tid: row.id,
      text: ((row.translations || {})[lang]) || row.src, src: row.src
    }, '*');
  }

  function _afterPatch(body, n) {
    const sync = fn('syncAllRowHeights');
    if (sync) setTimeout(() => { try { sync(body.id); } catch (e) {} }, 0);
    _toast(n === 1 ? '1 translation updated by a teammate' : n + ' translations updated by a teammate');
  }

  /* ── MUDANÇA ESTRUTURAL (linha/idioma criado ou removido pelo outro) ───────────────────── */

  // Não aplicamos automaticamente: trocar a forma da grade embaixo de quem digita quebra foco,
  // cursor e scroll. Só sinalizamos, e a pessoa recarrega quando quiser.
  function _checkStructural(projectId, rows, langs, remote) {
    let missing = false;
    // Idioma/linha que existe no remoto mas não está montado nesta grade.
    for (const k in remote) {
      const sep = k.lastIndexOf('|');
      const rowId = k.slice(0, sep), lang = k.slice(sep + 1);
      if (langs.indexOf(lang) === -1) { missing = true; break; }
      if (!rows.some(r => r.id === rowId)) { missing = true; break; }
    }
    if (missing && !_pendingStructural) { _pendingStructural = true; _showReloadBar(); }
  }

  function _showReloadBar() {
    if (document.getElementById('mltLiveReloadBar')) return;
    const bar = document.createElement('div');
    bar.id = 'mltLiveReloadBar';
    bar.className = 'mlt-live-bar';
    bar.innerHTML = '<span>A teammate added or removed content in this project.</span>' +
      '<button type="button" onclick="liveReloadNow()">Reload</button>' +
      '<button type="button" class="ghost" onclick="liveDismissReloadBar()">Later</button>';
    document.body.appendChild(bar);
  }

  function liveDismissReloadBar() {
    const bar = document.getElementById('mltLiveReloadBar');
    if (bar) bar.remove();
    _pendingStructural = false; // volta a avisar se vier outra mudança estrutural depois
  }

  // Recarrega a superfície aberta a partir do store já mesclado. Só roda por clique explícito —
  // é uma re-montagem completa da grade, exatamente o que evitamos fazer sozinhos.
  function liveReloadNow() {
    liveDismissReloadBar();
    const projectId = gProjId();
    const stored = (fn('projGetAll') ? global.projGetAll() : []).find(x => x.id === projectId);
    if (!stored) return;
    if (gCamp()) {
      const camp = gCamp();
      const idx = gCampIdx();
      camp.items = stored.items || camp.items;
      const item = (camp.items || [])[idx];
      const render = fn('renderCampaignGrid');
      if (item && render) render(item);
      return;
    }
    const restore = fn('restoreProjectContent'), build = fn('buildTable');
    if (stored.data && restore && build) { restore(stored.data, gApprv()); build(); }
  }

  /* ── AVISO DISCRETO ────────────────────────────────────────────────────────────────────── */

  let _toastTimer = null;
  function _toast(msg) {
    let el = document.getElementById('mltLiveToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mltLiveToast';
      el.className = 'mlt-live-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ── CAMINHO RÁPIDO: transmitir a tecla direto, sem esperar o banco ─────────────────────
   * O caminho normal (digita -> autosave 1500ms -> pull -> gravar -> Realtime -> pull -> aplicar)
   * leva de 3 a 6 segundos: o texto só viaja DEPOIS de persistir. Isso é correto pra durabilidade,
   * mas não é "ao vivo".
   * Aqui vai um atalho SÓ VISUAL: a cada tecla, transmite {rowId, lang, text} pelo canal de
   * presença e o outro lado pinta na hora. O banco continua sendo a fonte da verdade — este
   * broadcast é efêmero, não persiste nada, e quem chegar depois pega o estado real no próximo
   * pull. Se o broadcast se perder, o ciclo normal corrige alguns segundos depois.
   *
   * Por que no canal de presença e não num canal por projeto: evita gerenciar join/leave a cada
   * projeto aberto (fonte clássica de canal vazando). O custo é que a mensagem chega a todo mundo
   * conectado, e o receptor descarta o que não é do seu projeto. Com uma equipe pequena e payload
   * de algumas centenas de bytes throttled, o tráfego é irrelevante. Se a equipe crescer muito,
   * a troca é migrar para um canal por projeto.
   */
  /* Throttle ADAPTATIVO do broadcast. Fixo em 120ms, cada pessoa digitando gera ~8 msg/s; com 10
   * no mesmo projeto dá ~80 msg/s no canal, perto do teto usual de 100/s do Realtime. Crescendo o
   * intervalo com o nº de pessoas presentes, 10 digitando ficam em ~33 msg/s.
   * Custo perceptual: ~300ms em vez de ~120ms pra letra do colega aparecer — imperceptível perto
   * dos 8s de antes, e o ganho é não estourar o canal justamente quando há mais gente. */
  const BROADCAST_THROTTLE_MIN_MS = 120, BROADCAST_THROTTLE_MAX_MS = 320;
  function _broadcastThrottleMs() {
    let outros = 0;
    try {
      const pf = fn('presenceFor'), pid = gProjId();
      if (pf && pid) outros = pf(pid).length;
    } catch (e) {}
    return Math.min(BROADCAST_THROTTLE_MAX_MS, BROADCAST_THROTTLE_MIN_MS + outros * 20);
  }
  let _bcTimers = Object.create(null);   // chave da célula -> timer (throttle por célula)
  let _bcPending = Object.create(null);  // chave da célula -> último valor a enviar
  const _lastApplied = Object.create(null); // chave -> timestamp aplicado (descarta fora de ordem)

  /* CANAL POR PROJETO. Antes o broadcast pegava carona no canal GLOBAL de presença, então a
   * tecla de quem está no projeto A chegava (e era descartada) em quem está no projeto B — puro
   * desperdício, e conta pro teto de mensagens do canal. Agora cada projeto tem o seu
   * 'mlt-cells-<id>'.
   * O risco dessa abordagem é canal vazando ao trocar de projeto, então há UM ponto só que
   * entra/sai (liveCellChannelSet), chamado de presenceSetProject — que o app já chama ao abrir
   * e ao sair de um projeto. */
  let _cellChannel = null, _cellChannelProjectId = null;

  function liveCellChannelSet(projectId) {
    if (projectId === _cellChannelProjectId) return;
    const sb = fn('sbClient') ? global.sbClient() : null;
    if (_cellChannel) { try { _cellChannel.unsubscribe(); } catch (e) {} _cellChannel = null; }
    _cellChannelProjectId = projectId || null;
    if (!projectId || !sb) return;
    _cellChannel = sb.channel('mlt-cells-' + projectId);
    _cellChannel
      .on('broadcast', { event: 'cell' }, ({ payload }) => { try { liveOnRemoteCellBroadcast(payload); } catch (e) {} })
      .subscribe();
  }

  function liveBroadcastCell(projectId, itemId, rowId, lang, text) {
    if (!projectId || !rowId || !lang) return;
    if (projectId !== _cellChannelProjectId) liveCellChannelSet(projectId); // rede de segurança
    const ch = _cellChannel;
    if (!ch || ch.state !== 'joined') return;
    const k = _key(projectId, itemId, rowId, lang);
    _bcPending[k] = _str(text);
    if (_bcTimers[k]) return;                        // já há um envio agendado pra esta célula
    _bcTimers[k] = setTimeout(() => {
      _bcTimers[k] = null;
      const value = _bcPending[k]; delete _bcPending[k];
      try {
        ch.send({ type: 'broadcast', event: 'cell',
                  payload: { projectId, itemId: itemId || null, rowId, lang, text: value, at: Date.now() } });
      } catch (e) {}
    }, _broadcastThrottleMs());
  }

  // Recebe a tecla do colega e pinta na hora — respeitando as MESMAS guardas do patch normal:
  // nada de mexer em célula suja (minha, não confirmada) nem na que está com o cursor.
  function liveOnRemoteCellBroadcast(pl) {
    if (!pl || !pl.rowId || !pl.lang) return;
    if (pl.projectId !== gProjId()) return;          // é de outro projeto → ignora
    const ctx = _ctxForBroadcast();
    if (!ctx) return;
    if ((pl.itemId || null) !== (ctx.itemId || null)) return;  // outro item da mesma pasta
    const k = _key(pl.projectId, pl.itemId, pl.rowId, pl.lang);
    if (_dirty.has(k)) return;                       // estou digitando aqui
    if ((_lastApplied[k] || 0) > (pl.at || 0)) return; // chegou fora de ordem
    _lastApplied[k] = pl.at || Date.now();

    const ri = ctx.rows.findIndex(r => r && r.id === pl.rowId);
    const ci = ctx.langs.indexOf(pl.lang);
    if (ri < 0 || ci < 0) return;
    const row = ctx.rows[ri];
    row.translations = row.translations || {};
    if (_str(row.translations[pl.lang]) === _str(pl.text)) return;

    const td = ctx.body.querySelector('td.tl-cell[data-r="' + ri + '"][data-c="' + ci + '"]');
    const field = td ? td.querySelector('textarea, input.img-url') : null;
    if (field && field === document.activeElement) return;   // cursor está aqui

    row.translations[pl.lang] = _str(pl.text);
    if (field) {
      field.value = _str(pl.text);
      const ah = fn('autoH');
      if (ah && field.tagName === 'TEXTAREA') try { ah(field); } catch (e) {}
    }
    if (td) {
      td.classList.toggle('tl-missing', !_str(pl.text).trim());
      td.classList.remove('mlt-live-updated'); void td.offsetWidth; td.classList.add('mlt-live-updated');
      setTimeout(() => td.classList.remove('mlt-live-updated'), FLASH_MS);
    }
    // Preview em modo SILENCIOSO — a âncora continua sendo de quem digita.
    if (ctx.itemId) { try { _silentCampaignPreviewCell(ctx.item, row, pl.lang); } catch (e) {} }
    else { const u = fn('updatePreviewText'); if (u) try { u(ri, pl.lang, { silent: true }); } catch (e) {} }
  }

  // Contexto da grade na tela (mesma discriminação do apply normal), já com o item pra pasta.
  function _ctxForBroadcast() {
    const bodyId = gBodyId();
    const body = bodyId && document.getElementById(bodyId);
    if (!body || !body.offsetParent) return null;
    const sortL = fn('sortLangsForDisplay');
    if (bodyId === 'campGstb') {
      const camp = gCamp(), idx = gCampIdx();
      const item = camp && (camp.items || [])[idx];
      if (!item) return null;
      return { body, item, itemId: item.id, rows: item.rows || [], langs: sortL ? sortL(item.langs || []) : (item.langs || []) };
    }
    const S = gS();
    if (!S || !S.csv || !Array.isArray(S.csv.rows)) return null;
    return { body, item: null, itemId: null, rows: S.csv.rows, langs: sortL ? sortL(S.csv.langs) : (S.csv.langs || []) };
  }

  /* ── Diagnóstico (console) ─────────────────────────────────────────────────────────────── */
  function liveCoeditState() {
    return { dirty: [..._dirty.keys()], sigs: Object.assign({}, _lastSig), pendingStructural: _pendingStructural };
  }

  global.liveMarkDirty = liveMarkDirty;
  global.liveOnProjectPersisted = liveOnProjectPersisted;
  global.liveScheduleApply = liveScheduleApply;
  global.liveApplyRemote = liveApplyRemote;
  global.liveReloadNow = liveReloadNow;
  global.liveDismissReloadBar = liveDismissReloadBar;
  global.liveCoeditState = liveCoeditState;
  global.liveBroadcastCell = liveBroadcastCell;
  global.liveCellChannelSet = liveCellChannelSet;
  global.liveOnRemoteCellBroadcast = liveOnRemoteCellBroadcast;
})(window);
