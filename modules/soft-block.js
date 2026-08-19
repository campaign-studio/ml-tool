/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * modules/soft-block.js — SOFT BLOCK: acesso de edição RESTRITO, por pessoa, por projeto.
 *
 * O QUE É
 * Um terceiro papel no compartilhamento, ao lado de Editor e Approver. Quem está em soft block
 * TRADUZ normalmente (é isso que se espera de um tradutor externo/parceiro), mas não pode mexer
 * na ESTRUTURA do projeto:
 *   1. imagens          — não edita a URL das linhas de imagem nem muda a seleção de imagens
 *   2. linhas           — não adiciona (Re-scan) nem exclui linha
 *   3. HTML de origem   — não abre/salva o "Edit Tagged HTML" nem edita a coluna Origin
 *   4. upload de CSV    — subir planilha reescreve tradução em massa e pode mudar a estrutura
 *   5. restore de versão— trocar o projeto inteiro por uma versão antiga desfaz tudo de uma vez
 * Também não remove uma COLUNA DE IDIOMA inteira: não estava na lista original, mas deixar isso
 * aberto tornaria o bloqueio decorativo (dá pra apagar a coluna em vez das linhas), e o estrago
 * é maior que o de excluir uma linha.
 *
 * POR QUE "SOFT"
 * Não é read-only (isso já existe: _approverMode, do papel Approver). A pessoa continua
 * escrevendo tradução, com autosave, merge e co-edição normais. O bloqueio é só na estrutura.
 *
 * COMO É GUARDADO
 * p.softBlocked = ['email@x', ...] (minúsculas). A pessoa CONTINUA em p.sharedWith — ela tem
 * acesso, só é restrita. Guardar como lista de e-mails (e não um papel dentro de sharedWith)
 * deixa o merge concorrente de graça: 'softBlocked' entra em _BODY_MERGE_SET_LIST e é fundido
 * por UNIÃO, igual approvers/sharedWith — dois donos mexendo no compartilhamento ao mesmo tempo
 * não se sobrescrevem.
 *
 * GUARDA DE VERDADE, NÃO SÓ BOTÃO ESCONDIDO
 * softBlockApplyUi() esconde/desabilita os controles, mas cada AÇÃO também chama softBlockDeny()
 * na primeira linha. Sem isso, bastava o console pra furar o bloqueio — mesma lição já registrada
 * em setMemberRole ("Guard REAL de permissão (não só esconder botão)").
 *
 * Depende (em runtime) de globais do index.html: currentProjectId, projGetAll, authCurrentUser,
 * uiNotify/showNotif. Como em live-coedit.js: as variáveis let/const de topo (currentProjectId,
 * _campaign) NÃO estão em window — leitura por identificador com guarda de typeof.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const gProjId = () => (typeof currentProjectId !== 'undefined' ? currentProjectId : null);
  const gCamp   = () => (typeof _campaign !== 'undefined' ? _campaign : null);
  const fn = (name) => (typeof global[name] === 'function' ? global[name] : null);

  const _lc = (s) => String(s || '').toLowerCase();

  // Memo curto: isSoftBlocked() é consultado a cada tecla numa célula de imagem, e projGetAll()
  // faz JSON.parse do store inteiro. 2s é curto o bastante pra uma mudança de papel refletir
  // quase na hora e longo o bastante pra não pesar na digitação.
  let _memo = { id: null, at: 0, val: false };
  const MEMO_MS = 2000;

  // A pessoa logada está em soft block NESTE projeto? Dono nunca é bloqueado (é quem aplica).
  function isSoftBlocked(projectId) {
    const id = projectId || gProjId();
    if (!id) return false;
    const now = Date.now();
    if (_memo.id === id && (now - _memo.at) < MEMO_MS) return _memo.val;
    let val = false;
    try {
      const me = fn('authCurrentUser') && global.authCurrentUser();
      const all = fn('projGetAll') ? global.projGetAll() : [];
      const p = all.find(x => x.id === id);
      if (me && p) {
        const isOwner = _lc(p.owner) === _lc(me.email);
        val = !isOwner && (p.softBlocked || []).some(e => _lc(e) === _lc(me.email));
      }
    } catch (e) { val = false; }
    _memo = { id, at: now, val };
    return val;
  }

  // Invalida o memo na hora (usado quando o próprio app muda o papel de alguém).
  function softBlockInvalidate() { _memo = { id: null, at: 0, val: false }; }

  const MSG = {
    image:  'Soft block: you can translate, but image URLs are locked on this project.',
    rowDel: 'Soft block: you can translate, but rows can\'t be deleted on this project.',
    rowAdd: 'Soft block: you can translate, but rows can\'t be added on this project.',
    lang:   'Soft block: you can translate, but language columns can\'t be removed on this project.',
    html:   'Soft block: you can translate, but the origin HTML is locked on this project.',
    origin: 'Soft block: you can translate, but the origin column is locked on this project.',
    upload: 'Soft block: you can translate, but uploading a CSV/XLSX is locked on this project.',
    restore: 'Soft block: you can translate, but restoring an earlier version is locked on this project.'
  };

  // Porteiro das ações: devolve TRUE (= barrado) e avisa; FALSE deixa passar. Cada ação
  // estrutural chama isto na primeira linha.
  function softBlockDeny(kind) {
    if (!isSoftBlocked()) return false;
    const msg = MSG[kind] || 'Soft block: this action is locked on this project.';
    const notify = fn('uiNotify');
    if (notify) notify(msg, { type: 'warn' });
    else if (fn('showNotif')) global.showNotif(msg, 'warn');
    return true;
  }

  /* ── UI: esconde o que não pode ser usado (o guarda real está nas ações) ─────────────────── */

  // Chamada depois de cada render de grade (buildTable / renderCampaignGrid) e ao abrir o editor.
  function softBlockApplyUi() {
    const on = isSoftBlocked();
    document.body.classList.toggle('soft-blocked', on);
    if (!on) { _removeBanner(); return; }
    // Célula de imagem: readonly de verdade (o input de imagem não passa por textarea readonly
    // como as células de tradução, que o controlador de grade libera no foco).
    document.querySelectorAll('#gstb input.img-url, #campGstb input.img-url').forEach(el => {
      el.readOnly = true;
      el.title = MSG.image;
    });
    _showBanner();
  }

  function _showBanner() {
    if (document.getElementById('softBlockBanner')) return;
    const el = document.createElement('div');
    el.id = 'softBlockBanner';
    el.className = 'soft-block-banner';
    el.innerHTML = '<span class="sb-dot"></span>' +
      '<span><b>Soft block</b> — you can translate. Images, rows, the origin HTML, CSV upload and version restore are locked by the owner.</span>';
    document.body.appendChild(el);
  }
  function _removeBanner() {
    const el = document.getElementById('softBlockBanner');
    if (el) el.remove();
  }

  /* ── Papel no compartilhamento ─────────────────────────────────────────────────────────── */

  // Papel efetivo de um e-mail num projeto: 'approver' | 'softblock' | 'editor' | null.
  // Aprovador nunca é "soft block": ele já não edita nada (_approverMode), então a combinação
  // não significaria nada — por isso os três papéis são mutuamente exclusivos, como já eram.
  function softBlockRoleOf(p, email) {
    const e = _lc(email);
    if ((p.approvers || []).some(x => _lc(x) === e)) return 'approver';
    const hasAccess = (p.sharedWith || []).some(x => _lc(x) === e);
    if (!hasAccess) return null;
    return (p.softBlocked || []).some(x => _lc(x) === e) ? 'softblock' : 'editor';
  }

  // Aplica o papel escolhido nas 3 listas do projeto. Recebe o objeto do projeto e muta —
  // quem chama (setMemberRole) cuida de pull, permissão, gravação e rollback.
  function softBlockApplyRole(p, email, role) {
    const e = _lc(email);
    p.sharedWith  = p.sharedWith  || [];
    p.approvers   = p.approvers   || [];
    p.softBlocked = p.softBlocked || [];
    const drop = (arr) => arr.filter(x => _lc(x) !== e);
    if (role === null) {
      p.sharedWith = drop(p.sharedWith); p.approvers = drop(p.approvers); p.softBlocked = drop(p.softBlocked);
      return;
    }
    if (!p.sharedWith.some(x => _lc(x) === e)) p.sharedWith.push(email);
    p.approvers   = drop(p.approvers);
    p.softBlocked = drop(p.softBlocked);
    if (role === 'approver')      p.approvers.push(email);
    else if (role === 'softblock') p.softBlocked.push(email);
    softBlockInvalidate();
  }

  global.isSoftBlocked        = isSoftBlocked;
  global.softBlockDeny        = softBlockDeny;
  global.softBlockApplyUi     = softBlockApplyUi;
  global.softBlockInvalidate  = softBlockInvalidate;
  global.softBlockRoleOf      = softBlockRoleOf;
  global.softBlockApplyRole   = softBlockApplyRole;
})(window);
