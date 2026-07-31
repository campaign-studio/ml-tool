/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * modules/folders.js — Funcionalidade "Pasta/Folder" (ISOLADA do resto do app).
 *
 * PRINCÍPIO: este módulo NÃO reimplementa tagueamento/aprovação/preview/push/in-app. Uma "pasta"
 * é, por baixo, um registro kind:'campaign' (que já agrupa itens email/inapp/push por tipo, na
 * mesma tela, com aprovação por item). Este módulo só adiciona a CAMADA de pasta: listagem com
 * filtros (Todos / Fora de pasta), a ação "mover projeto avulso para pasta", busca dentro de
 * pastas, e a fiação de compartilhamento — sempre CHAMANDO as funções que já existem no
 * index.html (via window.*), nunca duplicando a lógica.
 *
 * Depende (em runtime, nunca no load) de globais do index.html:
 *   projGetAll, campaignGetAll, projSaveAll, parseSavedProjectHtml, parseBrazeCsv, expandLang,
 *   authCurrentUser, canShareProject.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // Acesso preguiçoso aos globais do app (o index.html é carregado antes; mas só chamamos em runtime).
  const app = {
    projects: () => (global.projGetAll ? global.projGetAll() : []),
    campaigns: () => (global.campaignGetAll ? global.campaignGetAll() : (global.projGetAll ? global.projGetAll().filter(p => p.kind === 'campaign') : [])),
    save: (list) => global.projSaveAll && global.projSaveAll(list),
    parseHtml: (html) => (global.parseSavedProjectHtml ? global.parseSavedProjectHtml(html) : []),
    parseCsv: (csv) => (global.parseBrazeCsv ? global.parseBrazeCsv(csv) : { langs: [], byLang: {} }),
    me: () => (global.authCurrentUser ? global.authCurrentUser() : null),
  };

  const isCampaign = (p) => p && p.kind === 'campaign';
  const isLoose = (p) => p && p.kind !== 'campaign';

  // ── Leitura / listagem ─────────────────────────────────────────────────────────────────────
  // Todas as pastas (registros kind:'campaign').
  function all() { return app.campaigns(); }

  // Pastas VISÍVEIS pra um e-mail: dono OU compartilhada (sharedWith) OU approver. Mesma regra
  // de acesso que os projetos soltos já usam — compartilhar a pasta dá acesso a tudo dentro dela.
  function visibleTo(email) {
    const e = String(email || '').toLowerCase();
    return all().filter(p =>
      (p.owner || '').toLowerCase() === e ||
      (p.sharedWith || []).some(x => (x || '').toLowerCase() === e) ||
      (p.approvers || []).some(x => (x || '').toLowerCase() === e)
    );
  }
  // É minha (sou dono)?
  function isOwner(p, email) { return p && (p.owner || '').toLowerCase() === String(email || '').toLowerCase(); }

  // Projetos "soltos" (fora de qualquer pasta) = os que não são campanha.
  function looseProjects() { return app.projects().filter(isLoose); }

  // Listagem do dashboard conforme o filtro:
  //   'unfoldered' → só os soltos.
  //   'all'        → pastas (no topo) + soltos + itens dentro das pastas (achatados, marcados).
  //   default      → pastas no topo + soltos (itens dentro das pastas NÃO aparecem soltos).
  // Retorna { folders:[campaign...], loose:[project...], flattenedItems:[{folder, item}] }.
  function listView(filter) {
    const folders = all();
    const loose = looseProjects();
    if (filter === 'unfoldered') return { folders: [], loose, flattenedItems: [] };
    const flattenedItems = filter === 'all'
      ? folders.flatMap(f => (f.items || []).map(item => ({ folder: f, item })))
      : [];
    return { folders, loose, flattenedItems };
  }

  // ── Busca (inclui itens dentro das pastas) ───────────────────────────────────────────────────
  // Retorna soltos que casam + itens-de-pasta que casam (marcados com a pasta). Busca por nome.
  function search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { loose: looseProjects(), items: [] };
    const loose = looseProjects().filter(p => (p.name || '').toLowerCase().includes(q));
    const items = all().flatMap(f =>
      (f.items || [])
        .filter(it => (it.name || '').toLowerCase().includes(q))
        .map(item => ({ folder: f, item }))
    );
    return { loose, items };
  }

  // Busca DENTRO de uma pasta específica (itens daquela pasta que casam).
  function searchInFolder(folderId, query) {
    const f = all().find(x => x.id === folderId);
    if (!f) return [];
    const q = String(query || '').trim().toLowerCase();
    const items = f.items || [];
    return q ? items.filter(it => (it.name || '').toLowerCase().includes(q)) : items.slice();
  }

  // ── Conversão: PROJETO AVULSO → ITEM DE PASTA (pura, sem escrever) ───────────────────────────
  // Um item de campanha tem { id, type, name, rawHtml, origin, langs, rows:[{id,src,isImg,imgTag,
  // translations}] } + estado de aprovação por item. Um projeto avulso guarda data.html (tageado)
  // + data.csv (string). Aqui parseamos os dois (MESMAS funções do restoreProjectContent) para
  // montar os rows/translations — nada é reimplementado, nada é perdido.
  function projectToFolderItem(project, type) {
    const d = (project && project.data) || {};
    const taggedRows = app.parseHtml(d.html || '');
    const parsed = app.parseCsv(d.csv || '') || { langs: [], byLang: {} };
    const langs = parsed.langs || d.langs || [];
    const byId = {};
    langs.forEach(l => (parsed.byLang[l] || []).forEach(x => { (byId[x.id] = byId[x.id] || {})[l] = x.tl; }));
    const rows = taggedRows.map(r => ({
      id: r.id, src: r.src, isImg: !!r.isImg, imgTag: r.imgTag || null,
      translations: Object.fromEntries(langs.map(l => [l, (byId[r.id] && byId[r.id][l]) || '']))
    }));
    return {
      id: 'item_' + project.id,          // determinístico: dá pra reverter "remover da pasta"
      type: type || 'email',
      name: project.name || 'Email',
      rawHtml: d.html || '',
      origin: d.origin || null,
      langs: [...langs],
      rows,
      // aprovação viaja JUNTO com o conteúdo (regra silenciosa: mover não reseta aprovação)
      approvalDoneByLang: d.approvalDoneByLang ? { ...d.approvalDoneByLang } : {},
      approvalActivity: Array.isArray(d.approvalActivity) ? [...d.approvalActivity] : [],
      approvalComments: Array.isArray(d.approvalComments) ? [...d.approvalComments] : [],
      approvalDeletedIds: Array.isArray(d.approvalDeletedIds) ? [...d.approvalDeletedIds] : [],
      // guarda a origem avulsa pra permitir "remover da pasta" restaurar o projeto solto
      _fromProjectId: project.id,
      _fromProjectData: d,
    };
  }

  // ── Conversão inversa: ITEM DE PASTA → PROJETO AVULSO (pura) ─────────────────────────────────
  // Usada ao "remover da pasta": volta a aparecer como solto. Prefere restaurar o data original
  // guardado (_fromProjectData) pra ser byte-fiel; senão, reconstrói a partir do item.
  function folderItemToProject(item, owner) {
    if (item && item._fromProjectData) {
      return { id: item._fromProjectId || ('p_' + item.id), name: item.name, owner, data: item._fromProjectData };
    }
    // Fallback (item criado dentro da pasta, sem origem avulsa): reconstrói data mínimo.
    return {
      id: 'p_' + (item && item.id || Date.now()),
      name: (item && item.name) || 'Email',
      owner,
      data: { html: (item && item.rawHtml) || '', csv: '', langs: (item && item.langs) || [], origin: (item && item.origin) || null }
    };
  }

  // ── MOVER projeto avulso → pasta (PLANO puro, não escreve) ──────────────────────────────────
  // Recebe o array de projetos e retorna { ok, error, folderWithItem, item, deleteProjectId }.
  // NÃO muta nada: quem chama aplica, SALVA a pasta, VERIFICA que o item entrou e só ENTÃO deleta
  // o avulso (assim, se algo falhar no meio, o avulso nunca se perde). Faz uma checagem de
  // integridade da conversão (nº de linhas bate) antes de liberar.
  function planMoveIntoFolder(projects, projectId, folderId) {
    const P = (projects || []).find(x => x.id === projectId && x.kind !== 'campaign');
    const F = (projects || []).find(x => x.id === folderId && x.kind === 'campaign');
    if (!P) return { ok: false, error: 'Standalone project not found.' };
    if (!F) return { ok: false, error: 'Folder not found.' };
    const item = projectToFolderItem(P, 'email');
    // Integridade: a conversão precisa ter linhas (senão algo deu errado no parse do HTML/CSV).
    const taggedRows = app.parseHtml((P.data && P.data.html) || '');
    if (taggedRows.length && item.rows.length !== taggedRows.length) {
      return { ok: false, error: 'Inconsistent conversion (row count mismatch) — move aborted.' };
    }
    // Já existe um item vindo desse mesmo projeto nesta pasta? (evita duplicar num duplo-clique)
    if ((F.items || []).some(it => it._fromProjectId === P.id)) {
      return { ok: false, error: 'This project is already in this folder.' };
    }
    const folderWithItem = { ...F, items: [...(F.items || []), item] };
    return { ok: true, folderWithItem, item, deleteProjectId: P.id };
  }

  // ── REMOVER item da pasta → volta a solto (PLANO puro, não escreve) ─────────────────────────
  // newProjectId: o avulso recriado ganha um id NOVO (o id original pode estar tombstoned pelo
  // move anterior — recriar com ele seria bloqueado pelo tombstone). createdAt: carimbo do
  // chamador (o módulo não usa Date.now). Retorna { ok, newLooseProject, folderWithoutItem }.
  function planRemoveFromFolder(projects, folderId, itemId, newProjectId, createdAt) {
    const F = (projects || []).find(x => x.id === folderId && x.kind === 'campaign');
    if (!F) return { ok: false, error: 'Folder not found.' };
    const item = (F.items || []).find(it => it.id === itemId);
    if (!item) return { ok: false, error: 'Item not found in the folder.' };
    const loose = folderItemToProject(item, F.owner);
    loose.id = newProjectId || loose.id;       // id novo (evita o tombstone do id antigo)
    loose.createdAt = createdAt || loose.createdAt;
    loose.updatedAt = createdAt || loose.updatedAt;
    const folderWithoutItem = { ...F, items: (F.items || []).filter(it => it.id !== itemId) };
    return { ok: true, newLooseProject: loose, folderWithoutItem, item };
  }

  global.Folders = {
    isCampaign, isLoose, all, visibleTo, isOwner, looseProjects, listView, search, searchInFolder,
    projectToFolderItem, folderItemToProject, planMoveIntoFolder, planRemoveFromFolder,
  };
})(typeof window !== 'undefined' ? window : this);
