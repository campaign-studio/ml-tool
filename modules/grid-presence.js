/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * modules/grid-presence.js — LIVE PRESENCE IN THE GRID (Google Sheets style).
 *
 * WHAT IT ADDS
 * Until now the editor only showed "N people are here" (a small avatar badge). You could not see
 * WHERE anyone was or WHAT they were touching, so live co-editing was invisible: translations
 * changed under you with no idea who did it. This paints, on every teammate's current cell:
 *   - a coloured outline in that person's colour (same palette as the avatars)
 *   - a small name tag on top of the cell
 * plus an avatar stack for whoever is in the same item.
 *
 * WHY PRESENCE AND NOT BROADCAST
 * It rides the existing 'mlt-presence-v1' channel by adding a `cell` field to the tracked
 * payload. Presence state is self-healing: if a tab crashes or the network drops, Supabase
 * removes the member and the cell frees itself. A broadcast-based cursor (what the approval
 * canvas uses) would need its own timeout/heartbeat to avoid ghost cells.
 * Granularity is FOCUS, not keystroke — a cell is claimed while someone has the caret in it,
 * which is exactly the Sheets behaviour and keeps traffic tiny.
 *
 * WHY IT DOESN'T FIGHT THE PREVIEW
 * Nothing here touches the preview. The anchor rule stands: the preview follows whoever is
 * typing, and only them (see the silent mode in live-coedit.js / braze-update).
 *
 * Depends (at runtime) on index.html globals: S, _campaign, _campaignItemIndex, currentProjectId,
 * _gridBodyId, authCurrentUser, authorName, sortLangsForDisplay, escHtml, and avColorForEmail
 * (defined in approval-canvas.js). As elsewhere, top-level let/const are read by identifier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const gS       = () => (typeof S !== 'undefined' ? S : null);
  const gCamp    = () => (typeof _campaign !== 'undefined' ? _campaign : null);
  const gCampIdx = () => (typeof _campaignItemIndex !== 'undefined' ? _campaignItemIndex : -1);
  const gBodyId  = () => (typeof _gridBodyId !== 'undefined' ? _gridBodyId : null);
  const gProjId  = () => (typeof currentProjectId !== 'undefined' ? currentProjectId : null);
  const fn = (name) => (typeof global[name] === 'function' ? global[name] : null);

  const esc = (s) => (fn('escHtml') ? global.escHtml(s) : String(s == null ? '' : s));

  // What I currently have focused, as announced to everyone else. null = not in a cell.
  let _myCell = null;
  let _trackTimer = null;

  /* ── Which surface is on screen, and how to map a cell both ways ────────────────────────── */

  // Same discriminator live-coedit uses: the rendered grid, not _campaign (projOpen leaves
  // _campaign set from a previous folder, so it is not a reliable signal).
  function _ctx() {
    const bodyId = gBodyId();
    const body = bodyId && document.getElementById(bodyId);
    if (!body || !body.offsetParent) return null;
    const sortL = fn('sortLangsForDisplay');
    if (bodyId === 'campGstb') {
      const camp = gCamp(), idx = gCampIdx();
      const item = camp && (camp.items || [])[idx];
      if (!item) return null;
      return { body, itemId: item.id, rows: item.rows || [], langs: sortL ? sortL(item.langs || []) : (item.langs || []) };
    }
    const S = gS();
    if (!S || !S.csv || !Array.isArray(S.csv.rows)) return null;
    return { body, itemId: null, rows: S.csv.rows, langs: sortL ? sortL(S.csv.langs) : (S.csv.langs || []) };
  }

  /* ── Announce where I am ───────────────────────────────────────────────────────────────── */

  function _onFocusIn(e) {
    const td = e.target && e.target.closest && e.target.closest('td.tl-cell[data-r][data-c]');
    if (!td) return;
    const ctx = _ctx(); if (!ctx || !ctx.body.contains(td)) return;
    const row = ctx.rows[+td.getAttribute('data-r')];
    const lang = ctx.langs[+td.getAttribute('data-c')];
    if (!row || !lang) return;
    _setMyCell({ itemId: ctx.itemId, rowId: row.id, lang });
  }

  function _onFocusOut(e) {
    // Moving between cells fires focusout before the next focusin — defer so we don't blink
    // the tag off and on again on every arrow-key move.
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a.closest && a.closest('td.tl-cell[data-r][data-c]')) return; // still in a cell
      _setMyCell(null);
    }, 60);
  }

  function _setMyCell(cell) {
    const same = JSON.stringify(cell) === JSON.stringify(_myCell);
    if (same) return;
    _myCell = cell;
    // Small throttle: arrowing across a row shouldn't send one track per cell.
    clearTimeout(_trackTimer);
    _trackTimer = setTimeout(() => { const s = fn('_presenceSendTrack'); if (s) s(); }, 120);
  }

  // Read by _presenceSendTrack in index.html when building the tracked payload.
  function gridPresenceMyCell() { return _myCell; }

  /* ── Paint where everyone else is ──────────────────────────────────────────────────────── */

  function renderGridPresence() {
    const ctx = _ctx();
    document.querySelectorAll('.gp-cell').forEach(el => {
      el.classList.remove('gp-cell', 'gp-locked');
      const f0 = el.querySelector('textarea, input.img-url');
      if (f0) f0.removeAttribute('title');   // readonly é reposto pelo controlador da grade
      el.style.removeProperty('--gp-color');
      const tag = el.querySelector('.gp-tag'); if (tag) tag.remove();
    });
    if (!ctx) { _renderStack([]); return; }

    const peers = _peersHere(ctx.itemId);
    const colors = _assignColors(peers);
    const colorOf = (u) => colors.get(String(u.email).toLowerCase()) || '#888';
    _renderStack(peers, colorOf);

    // rowId|lang -> {r, c}, built once per render.
    const pos = Object.create(null);
    ctx.rows.forEach((row, r) => { if (row && row.id) ctx.langs.forEach((lang, c) => { pos[row.id + '|' + lang] = { r, c }; }); });

    peers.forEach(u => {
      const cell = u.cell; if (!cell || !cell.rowId || !cell.lang) return;
      // In a folder, only paint if they are on the SAME item I have open.
      if ((cell.itemId || null) !== (ctx.itemId || null)) return;
      const at = pos[cell.rowId + '|' + cell.lang]; if (!at) return;
      const td = ctx.body.querySelector('td.tl-cell[data-r="' + at.r + '"][data-c="' + at.c + '"]');
      if (!td) return;
      const color = colorOf(u);
      td.classList.add('gp-cell');
      td.style.setProperty('--gp-color', color);
      // Travada: o colega está com o cursor aqui (ver soft lock acima).
      td.classList.add('gp-locked');
      const f = td.querySelector('textarea, input.img-url');
      if (f) { f.readOnly = true; f.title = _fullName(u) + ' is editing this cell'; }
      if (!td.querySelector('.gp-tag')) {
        const tag = document.createElement('span');
        tag.className = 'gp-tag';
        tag.style.background = color;
        // Nome COMPLETO no texto; o CSS corta com reticências e o hover revela inteiro. Assim o
        // nome está sempre no DOM (leitor de tela / title) sem alargar a coluna no estado normal.
        tag.textContent = _fullName(u);
        td.appendChild(tag);
      }
      td.setAttribute('title', _fullName(u) + ' is editing this cell');
    });
  }

  // avColorForEmail hashes into a palette of 8, so in a room of 4 it is common for two people to
  // land on the same colour — which defeats the whole point of colour-coding who is where. Keep
  // the hash as the PREFERRED colour (stable for a person across sessions) and, when it is
  // already taken, move to the next free slot. Peers are sorted by e-mail first so every client
  // resolves the collision the same way and everyone sees the same colours.
  const PALETTE = ['#f2496b','#3b82f6','#0891b2','#8b5cf6','#f59e0b','#059669','#d8385e','#6366f1'];
  function _assignColors(peers) {
    const taken = new Set(), out = new Map();
    const me = fn('authCurrentUser') && global.authCurrentUser();
    if (me && fn('avColorForEmail')) taken.add(global.avColorForEmail(me.email)); // não roubar a minha cor
    [...peers].sort((a, b) => String(a.email).localeCompare(String(b.email))).forEach(u => {
      const pref = fn('avColorForEmail') ? global.avColorForEmail(u.email) : PALETTE[0];
      let color = pref;
      if (taken.has(color)) color = PALETTE.find(c => !taken.has(c)) || pref; // paleta cheia → repete
      taken.add(color);
      out.set(String(u.email).toLowerCase(), color);
    });
    return out;
  }

  function _fullName(u) { return String(u.name || u.email || '?'); }

  // Everyone except me who is in this project right now (dedup by e-mail, latest cell wins).
  function _peersHere() {
    const pid = gProjId(); if (!pid) return [];
    const me = fn('authCurrentUser') && global.authCurrentUser();
    const mine = me ? String(me.email || '').toLowerCase() : '';
    const state = (typeof _presenceState !== 'undefined' ? _presenceState : {})[pid] || [];
    const byEmail = new Map();
    state.forEach(u => {
      const e = String(u.email || '').toLowerCase();
      if (!e || e === mine) return;
      const prev = byEmail.get(e);
      if (!prev || (u.at || 0) >= (prev.at || 0)) byEmail.set(e, u);
    });
    return [...byEmail.values()];
  }

  // Avatar stack in the editor header — who is in here with me right now.
  function _renderStack(peers, colorOf) {
    document.querySelectorAll('.gp-stack').forEach(host => {
      // Há um host por editor (avulso e pasta). Só o da tela ATIVA recebe conteúdo — senão os
      // mesmos avatares apareceriam duas vezes quando os dois toolbars estão montados.
      // A visibilidade é medida pela TELA que contém o host, não pelo próprio host: ele nasce
      // display:none, então olhar o offsetParent dele seria ovo-e-galinha (nunca apareceria).
      const screen = host.closest('#appBody, #campaignScreen');
      if (!peers.length || !screen || !screen.offsetParent) { host.innerHTML = ''; host.style.display = 'none'; return; }
      host.style.display = '';
      host.innerHTML = peers.slice(0, 6).map(u => {
        const color = colorOf ? colorOf(u) : '#888';
        const nm = _fullName(u);
        const where = u.cell && u.cell.rowId ? (u.cell.rowId + ' · ' + u.cell.lang) : 'in this project';
        return `<span class="gp-av" style="background:${color}" data-name="${esc(nm)}" data-where="${esc(where)}">${esc((nm.trim()[0] || '?').toUpperCase())}</span>`;
      }).join('') + (peers.length > 6 ? `<span class="gp-more">+${peers.length - 6}</span>` : '');
    });
  }

  /* ── SOFT LOCK: a célula onde o colega está fica bloqueada aqui ──────────────────────────
   * Este é o único ponto em que o merge por célula perde dado: se duas pessoas escrevem na MESMA
   * célula, vence quem gravar por último e o texto da outra some sem aviso. Em vez de partir pra
   * CRDT (caríssimo e desproporcional aqui), a presença já diz quem está onde — então basta não
   * deixar duas pessoas na mesma célula ao mesmo tempo.
   * É SOFT de propósito: se a presença do colega sumir, ficar velha (rede caiu, aba morreu) ou o
   * canal cair, a célula libera sozinha. Bloqueio que prende alguém por falha de rede seria pior
   * que o problema que ele resolve.
   */
  const HOLD_STALE_MS = 25000;

  // Quem (se alguém) está com ESTA célula agora. null = livre.
  function gridPresenceHolder(itemId, rowId, lang) {
    if (!rowId || !lang) return null;
    const now = Date.now();
    for (const u of _peersHere()) {
      const c = u.cell;
      if (!c || c.rowId !== rowId || c.lang !== lang) continue;
      if ((c.itemId || null) !== (itemId || null)) continue;
      if (now - (u.at || 0) > HOLD_STALE_MS) continue;   // presença velha → não trava
      return u;
    }
    return null;
  }

  // Nome de quem segura a célula, pra mensagem na interface.
  function gridPresenceHolderName(itemId, rowId, lang) {
    const u = gridPresenceHolder(itemId, rowId, lang);
    return u ? _fullName(u) : null;
  }

  document.addEventListener('focusin', _onFocusIn);
  document.addEventListener('focusout', _onFocusOut);

  global.gridPresenceMyCell   = gridPresenceMyCell;
  global.renderGridPresence   = renderGridPresence;
  global.gridPresenceHolder     = gridPresenceHolder;
  global.gridPresenceHolderName = gridPresenceHolderName;
})(window);
