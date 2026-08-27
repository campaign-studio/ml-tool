/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * modules/csv-editor.js — SUPERFÍCIE ÚNICA do editor de CSV (grade + preview).
 *
 * O PROBLEMA QUE ISTO RESOLVE
 * Existem DOIS pontos de montagem do editor: o projeto avulso (#gstb + #vf) e o item dentro de
 * uma pasta (#campGstb + #campaignPreviewFrame). A grade já era compartilhada de verdade
 * (buildGridHead + renderTranslationGridBody), e o HTML do preview também (buildPreviewHtml) —
 * mas as funções de REALCE (switchAndHL/_sendHL/highlightFromTable) tinham '#gstb' e '#vf'
 * escritos na mão. Elas simplesmente não funcionavam no grid da pasta.
 *
 * A consequência em cascata: renderCampaignGrid foi obrigada a passar liveHL:false e
 * onclickHighlight:false, e o preview da pasta ganhou um script paralelo de 20 linhas
 * (injectCampaignLiveUpdateScript) contra as ~105 do avulso. Resultado prático: dentro da pasta
 * não havia âncora, nem realce, nem busca no preview, nem revelar ramo If/Else ao focar a linha.
 * Ninguém "desligou" esses recursos de propósito — eles nunca chegaram lá.
 *
 * A REGRA QUE MANTÉM ISSO UNIFICADO
 * Este arquivo é o ÚNICO lugar do código que pode saber que existem dois pontos de montagem.
 * Todo o resto pergunta "qual é a superfície ativa?" e trabalha em cima da resposta. Recurso
 * novo entra aqui uma vez e vale nos dois editores POR CONSTRUÇÃO — não dá pra esquecer um lado,
 * que foi exatamente o que aconteceu antes.
 *
 * POR QUE ISSO É SEGURO
 * Os dois editores já operavam no MESMO estado global S: activateCampaignItemIntoS() carrega o
 * item da pasta dentro do mesmo S.csv/S.rawHtml que o avulso usa. Nunca houve dois modelos de
 * dados — só dois caminhos de render em cima de um modelo só. Unificar o render não muda dado
 * nenhum; só para de duplicar a apresentação.
 *
 * O QUE CONTINUA SEPARADO (de propósito)
 *   - Preview de PUSH: não tem HTML nem iframe, é DOM simples montado à mão. Grade unificada,
 *     preview não. Forçar iframe ali seria inventar um documento que não existe.
 *   - Chrome de cada tela (botão de voltar pra galeria, renomear item): é navegação, não editor.
 *
 * Depende (em runtime, nunca no load) de globais do index.html: S, _gridBodyId, _campaign,
 * _campaignItemIndex, _campPreviewLoadedKey, _pendingHL, _vfLoadSeq, _selRow, _selLang,
 * buildPreviewHtml, renderCampaignPreview, refreshViewer, revealCondBranchForRow, COUNTRIES.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/* ── DESCRITOR DE SUPERFÍCIE ─────────────────────────────────────────────────────────────────
 * Chaveado pelo id do <tbody>, que é o contrato que o controlador de grade JÁ usava
 * (_gridBodyId). Reaproveitar essa chave em vez de inventar outra evita ter dois conceitos de
 * "qual editor está aberto" que podem discordar entre si.                                    */
const CSV_EDITOR_SURFACES = {
  gstb: {
    key: 'loose',
    tbody: 'gstb',
    table: 'gst',
    iframe: 'vf',
    lbar: 'lbar',
    scrollWrap: '.mail-body-wrap',
    // Idioma que o preview está mostrando. No avulso é global (S.vLang); na pasta é por item
    // (item._activeLang), porque cada item tem sua própria lista de idiomas.
    viewLang(){ return (typeof S !== 'undefined') ? S.vLang : null; },
    setViewLang(l){ if(typeof S !== 'undefined') S.vLang = l; },
    refreshPreview(){ if(typeof refreshViewer === 'function') refreshViewer(); },
    rerenderGrid(){ buildTable(); },
    scheduleSave(){ try { scheduleAutosave(); } catch(e){} },
    setRawHtml(h){ S.rawHtml = h; }
  },
  campGstb: {
    key: 'folder',
    tbody: 'campGstb',
    table: 'campaignItemTable',
    iframe: 'campaignPreviewFrame',
    lbar: 'campaignItemLbar',
    scrollWrap: '#campaignItemPreview',
    viewLang(){
      const it = editorCampItem();
      return it ? (it._activeLang || (it.langs && it.langs[0]) || null) : null;
    },
    setViewLang(l){ const it = editorCampItem(); if(it) it._activeLang = l; },
    refreshPreview(){
      const it = editorCampItem();
      if(!it) return;
      // Zera a chave do iframe persistente: renderCampaignPreview só reconstrói o documento
      // quando o par item+idioma muda. Trocar de RAMO (If/Else) mantém o mesmo par, então sem
      // isso o rebuild era descartado e o data-tid do ramo novo nunca chegava a existir.
      if(typeof _campPreviewLoadedKey !== 'undefined') _campPreviewLoadedKey = null;
      renderCampaignPreview(it, this.viewLang());
    },
    rerenderGrid(){ const it = editorCampItem(); if(it) renderCampaignGrid(it); },
    scheduleSave(){ const it = editorCampItem(); if(it && typeof touchCampaignItem === 'function') touchCampaignItem(it);
                    try { scheduleCampaignAutosave(); } catch(e){} },
    // O HTML tageado de um item mora no ITEM, não em S: S.rawHtml é só a cópia de trabalho que
    // activateCampaignItemIntoS carregou. Gravar só em S perderia as tags novas no autosave.
    setRawHtml(h){ S.rawHtml = h; const it = editorCampItem(); if(it) it.rawHtml = h; }
  }
};

// Item de pasta aberto agora (null no editor avulso). Um lugar só pra essa checagem tripla.
function editorCampItem(){
  if(typeof _campaign === 'undefined' || !_campaign) return null;
  if(typeof _campaignItemIndex === 'undefined' || _campaignItemIndex < 0) return null;
  return _campaign.items[_campaignItemIndex] || null;
}

// A superfície ATIVA. Default = avulso: é o que _gridBodyId já valia antes deste módulo existir,
// então qualquer chamada que aconteça fora de um editor aberto se comporta como sempre.
function editorSurface(){
  const id = (typeof _gridBodyId !== 'undefined') ? _gridBodyId : 'gstb';
  return CSV_EDITOR_SURFACES[id] || CSV_EDITOR_SURFACES.gstb;
}

function editorPreviewFrame(){ return document.getElementById(editorSurface().iframe); }
function editorGridRows(){ return document.querySelectorAll('#' + editorSurface().tbody + ' tr'); }
function editorScrollWrap(){ return document.querySelector(editorSurface().scrollWrap); }

/* Qual superfície mandou este postMessage? Os dois iframes podem coexistir no DOM (o editor
 * avulso fica escondido, não removido, enquanto uma pasta está aberta), então identificar pelo
 * id do elemento erraria o alvo. e.source aponta pro contentWindow exato de quem falou. */
function editorSurfaceForSource(src){
  for(const k in CSV_EDITOR_SURFACES){
    const s = CSV_EDITOR_SURFACES[k];
    const f = document.getElementById(s.iframe);
    if(f && f.contentWindow === src) return s;
  }
  return null;
}


/* ── O SCRIPT DO PREVIEW — UM SÓ PROS DOIS EDITORES ──────────────────────────────────────────
 * Antes existiam dois: este (completo: realce, busca, scroll, âncora silenciosa) só no avulso,
 * e um resumo de 20 linhas (injectCampaignLiveUpdateScript) na pasta, que só sabia trocar texto.
 * Por isso a pasta nunca teve âncora nem realce. Agora os dois injetam ESTE.
 *
 * Sobre o 'silent' do braze-update: quando a edição vem de OUTRA pessoa (co-edição ao vivo),
 * o texto é trocado mas o realce e o scroll NÃO se mexem. A âncora do preview pertence a quem
 * está digitando — sem isso, o preview de todo mundo pulava pro ponto onde o colega estava.
 *
 * Os dois previews têm o MESMO modelo de scroll: o iframe cresce até a altura do conteúdo
 * (braze-height) e quem rola é o container PAI (.mail-body-wrap no avulso, #campaignItemPreview
 * na pasta). Por isso scrollIntoView() daqui de dentro não teria efeito e o script pede o scroll
 * ao pai via braze-scrollto.                                                                  */
function buildPreviewScript(){
  const sc = '<scr' + 'ipt>', scEnd = '</scr' + 'ipt>';
  return sc + `
(function(){
  var st = document.createElement('style');
  st.textContent = '.braze-hl{outline:2px solid rgba(59,130,246,.6)!important;background-color:rgba(59,130,246,.08)!important;border-radius:3px;transition:outline .2s,background-color .2s;}.braze-img-wrap{display:block;line-height:0;font-size:0;}.braze-img-wrap img{display:block;}';
  (document.head||document.documentElement).appendChild(st);

  var curEl = null;

  function findEl(text){
    if(!text||text.length<2) return null;
    var search=text.trim();
    var walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT,null);
    var node;
    while((node=walker.nextNode())){
      var t=node.textContent.trim();
      if(t&&t.includes(search)){
        var el=node.parentElement;
        if(!el||el.tagName==='HTML'||el.tagName==='BODY') continue;
        return {node:node, el:el};
      }
    }
    return null;
  }

  function clearHL(){
    if(curEl){curEl.classList.remove('braze-hl');curEl=null;}
  }

  function highlight(text, tid){
    clearHL();
    if(!tid) return;
    var el = document.querySelector('[data-tid="'+tid+'"]');
    if(el){
      // img-wrap span: highlight the <img> inside it directly
      var img = el.classList.contains('braze-img-wrap') ? el.querySelector('img') : null;
      var target = img || el;
      curEl=target;
      target.classList.add('braze-hl');
      // Este iframe não tem scroll interno — ele é redimensionado pra caber todo o
      // conteúdo (ver 'braze-height' abaixo), quem realmente rola é o .mail-body-wrap
      // no documento PAI. scrollIntoView() daqui dentro não tem efeito nenhum, então
      // mandamos a posição do alvo pro pai rolar o container certo.
      // IMPORTANTE: reporta a altura ANTES de pedir o scroll — logo após um reload
      // (troca de idioma), o pai ainda não recebeu a altura nova (só chega 100ms
      // depois do load), então o .mail-body-wrap ainda tem o tamanho do conteúdo
      // ANTERIOR e o scroll pedido fica limitado (clampado) perto do topo.
      // postMessage preserva a ordem de entrega, então mandando a altura primeiro
      // garantimos que o container já cresceu quando o scrollto chegar.
      reportHeight();
      var rect = target.getBoundingClientRect();
      window.parent.postMessage({type:'braze-scrollto', top: rect.top + rect.height/2}, '*');
    }
  }

  // Keep a map of ri → {node, origSrc} so we can update the same node every keystroke
  var nodeMap = {};

  // silent=true => só troca o TEXTO. Não move o realce e não rola.
  // A âncora do preview pertence a QUEM ESTÁ DIGITANDO: quando a edição vem de outra pessoa
  // (co-edição ao vivo manda braze-update com silent), mexer no realce/scroll faria o preview
  // de todo mundo pular pro ponto onde o colega está — cada um tem que manter a própria vista.
  function updateText(ri, src, newText, tid, silent){
    var container = tid ? document.querySelector('[data-tid="'+tid+'"]') : null;
    if(container){
      // Image row: braze-img-wrap span contains the <img>
      if(container.classList.contains('braze-img-wrap')){
        var img = container.querySelector('img');
        if(img){
          img.src = newText||src;
          if(!silent){
            clearHL(); curEl=img; img.classList.add('braze-hl');
            img.scrollIntoView({behavior:'smooth',block:'center'});
          }
          return;
        }
      }
      // Text row — update text node
      var walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT,null);
      var node=walker.nextNode();
      if(node){ node.textContent = newText||src; }
      else { container.textContent = newText||src; }
      if(!silent){ clearHL(); curEl=container; container.classList.add('braze-hl'); }
      return;
    }
    // Fallback: nodeMap by ri
    if(nodeMap[ri] && nodeMap[ri].node.isConnected){
      nodeMap[ri].node.textContent = newText || nodeMap[ri].origSrc;
      var el = nodeMap[ri].node.parentElement;
      if(el && !silent){ clearHL(); curEl=el; el.classList.add('braze-hl'); }
      return;
    }
  }

  function reportHeight(){
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 600);
    window.parent.postMessage({type:'braze-height', height:h},'*');
  }
  // Report once after load + one deferred check — no resize/mutation to avoid feedback loop
  window.addEventListener('load', function(){ setTimeout(reportHeight, 100); });

  window.addEventListener('message',function(e){
    if(!e.data) return;
    if(e.data.type==='braze-find') highlight(e.data.text, e.data.ri);
    if(e.data.type==='braze-update') updateText(e.data.ri, e.data.src, e.data.text, e.data.tid, e.data.silent);
  });
})();
` + scEnd;
}

// Injeta o script no HTML do preview. Mesmo ponto de inserção nos dois editores.
function injectPreviewScript(html){
  const s = buildPreviewScript();
  return html.includes('</body>') ? html.replace('</body>', s + '</body>') : html + s;
}

/* ── REALCE / ÂNCORA — antes travado no editor avulso ────────────────────────────────────────
 * Estas quatro funções são a razão de este módulo existir. Elas tinham '#gstb' e '#vf' escritos
 * na mão, então a pasta teve que desligar liveHL/onclickHighlight pra não quebrar. Agora leem a
 * superfície ativa e valem nos dois editores.                                                 */

// Marca a linha selecionada na grade ATIVA. O .table-sel é limpo no documento inteiro de
// propósito: só pode existir uma linha selecionada, mesmo que o outro grid esteja escondido
// no DOM com uma seleção velha pendurada.
function editorSelectRow(ri){
  document.querySelectorAll('tr.table-sel').forEach(r => r.classList.remove('table-sel'));
  const trs = editorGridRows();
  if(trs[ri]) trs[ri].classList.add('table-sel');
}

// Sincroniza a aba de idioma ativa DENTRO da barra da superfície ativa. Escopado ao container
// (#lbar / #campaignItemLbar) porque os dois editores usam a mesma classe .ltab: um seletor
// global marcaria a aba do editor escondido junto.
function editorSyncLangTab(lang){
  const bar = document.getElementById(editorSurface().lbar);
  if(!bar) return;
  bar.querySelectorAll('.ltab').forEach(b => {
    const oc = b.getAttribute('onclick') || '';
    b.classList.toggle('active', oc.includes("'" + lang + "'"));
  });
}

// Foco numa célula de tradução: seleciona a linha, revela o ramo If/Else se o trecho estiver
// escondido, troca o idioma do preview se preciso e destaca. Só recarrega o preview quando o
// documento realmente muda (idioma ou ramo) — no caso comum é só um postMessage.
function switchAndHL(ri, lang) {
  const sf = editorSurface();
  _selRow = ri; _selLang = lang;
  editorSelectRow(ri);

  // Se este id vive no ramo inativo de uma condicional, troca o toggle If/Else pra revelá-lo.
  const branchSwitched = (S.csv.rows[ri] && typeof revealCondBranchForRow === 'function')
    ? revealCondBranchForRow(S.csv.rows[ri].id) : false;

  const needLangSwitch = sf.viewLang() !== lang;
  if(needLangSwitch) { sf.setViewLang(lang); editorSyncLangTab(lang); }

  if(needLangSwitch || branchSwitched) {
    // Token de geração: se outro refresh acontecer antes deste iframe carregar, o highlight da
    // chamada velha é descartado em vez de ser aplicado no documento errado.
    _pendingHL = { ri, lang };
    sf.refreshPreview();
    return;
  }
  _sendHL(ri, lang);
}

// A cada tecla — o preview já está no idioma certo, então é só reenviar o realce.
function sendHL(ri, lang) {
  if(editorSurface().viewLang() !== lang) return; // idioma diferente do que está na tela: nada a fazer
  _sendHL(ri, lang);
}

function _sendHL(ri, lang) {
  const row = S.csv.rows[ri]; if(!row) return;
  const text = row.translations[lang] || row.src;
  if(!text) return;
  const iframe = editorPreviewFrame();
  if(iframe && iframe.contentWindow)
    iframe.contentWindow.postMessage({ type:'braze-find', text, ri: row.id }, '*');
}

// Clique na coluna Origin: mesma ideia do switchAndHL, mas alterna (clicar de novo na mesma
// linha+idioma desmarca) e o alvo é sempre a origem quando a coluna clicada é a de origem.
function highlightFromTable(ri, lang) {
  const sf = editorSurface();
  document.querySelectorAll('tr.table-sel').forEach(r => r.classList.remove('table-sel'));

  if(_selRow === ri && _selLang === lang){ _selRow = -1; _selLang = null; clearPreviewHighlight(); return; }
  _selRow = ri; _selLang = lang;
  editorSelectRow(ri);

  const row = S.csv.rows[ri];
  if(!row) return;

  const origLang = S.allC.find(c => c.code === S.origin)?.lang || null;
  const targetLang = lang && lang !== origLang ? lang : origLang;

  const branchSwitched = (typeof revealCondBranchForRow === 'function')
    ? revealCondBranchForRow(row.id) : false;

  const needLangSwitch = targetLang && sf.viewLang() !== targetLang;
  if(needLangSwitch) { sf.setViewLang(targetLang); editorSyncLangTab(targetLang); }

  if(needLangSwitch || branchSwitched) {
    _pendingHL = { ri, lang: targetLang };
    sf.refreshPreview();
    return;
  }
  _sendHL(ri, targetLang);
}

function clearPreviewHighlight() {
  const iframe = editorPreviewFrame();
  if(iframe && iframe.contentWindow)
    iframe.contentWindow.postMessage({ type:'braze-find', text:null }, '*');
}

/* ── BARRA DE FERRAMENTAS — UMA LISTA, DOIS EDITORES ─────────────────────────────────────────
 * As duas barras eram markup escrito à mão em dois pontos do index.html, e tinham divergido:
 * a pasta não tinha Re-scan nem download em XLSX, e a ordem dos botões era outra. Nada disso
 * foi decidido — foi só um lado recebendo um botão que o outro não recebeu.
 *
 * Agora existe UMA lista. Botão novo entra aqui e aparece nos dois. Quando a AÇÃO legitimamente
 * difere (o avulso baixa o projeto, a pasta baixa o item), a diferença mora no mapa `act`, que é
 * pequeno e explícito — em vez de dois blocos de HTML que ninguém garante que continuam iguais.  */
const CSV_EDITOR_ICONS = {
  check:   '<path d="M20 6L9 17l-5-5"/>',
  upload:  '<path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V3m0 0l-4 4m4-4l4 4"/>',
  down:    '<path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>',
  sheet:   '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  copy:    '<path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/>',
  pencil:  '<path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l4 2"/>',
  bookmark:'<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>',
  rescan:  '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>',
  caret:   '<path d="M6 9l6 6 6-6"/>',
  more:    '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
};
function csvEditorIcon(name, size){
  const s = size || 11;
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${CSV_EDITOR_ICONS[name]||''}</svg>`;
}

/* act: string (mesma ação nos dois) ou {loose, folder} quando a ação é legitimamente diferente.
 * Ordem única — é a do avulso, que era a mais completa, com o CTA de aprovação no fim.        */
const CSV_EDITOR_TOOLBAR = [
  { key:'html',     label:'Copy Tagged HTML', cls:'tbtn html', icon:'copy',
    title:'Export to Braze — copy the subject, the tagged HTML, and download the translations CSV, step by step',
    act:'openHtmlModal()' },
  { key:'editHtml', label:'Edit Tagged HTML', cls:'tbtn', icon:'pencil',
    title:'Manually fix a specific error in the already-tagged HTML — for emergency corrections, does not re-run extraction and does not affect approval',
    act:{ loose:'openTaggedHtmlEditorForCurrentProject()', folder:'openTaggedHtmlEditorForCampaignItem()' } },
  { key:'history',  label:'History', cls:'tbtn', icon:'history',
    title:'Version history — restore an earlier point or save a backup',
    i18n:'versionHistory.historyBtn', i18nTitle:'versionHistory.historyBtnTitle',
    act:'openVersionHistory()' },
  { key:'backup',   label:'Save backup', cls:'tbtn', icon:'bookmark',
    title:'Save a backup — mark a restore point you can always come back to',
    i18n:'versionHistory.saveBackupBtn', i18nTitle:'versionHistory.saveBackupBtnTitle',
    act:'saveManualBackup()' },
  { key:'rescan',   label:'Re-scan', cls:'tbtn', icon:'rescan',
    title:'Re-scan the original HTML for translatable lines that weren’t captured, and add any missing ones at the end (won’t touch existing lines)',
    act:'rescanMissedLines()' },
  { key:'download', kind:'dropdown', label:'Download', cls:'tbtn csv', icon:'down',
    items:[
      { label:'Download as CSV',  icon:'down',  act:{ loose:'dlCSV()',  folder:'dlItemCSV()' } },
      { label:'Download as XLSX', icon:'sheet', act:{ loose:'dlXLSX()', folder:'dlItemXLSX()' } }
    ] },
  { key:'upload',   label:'Update from CSV/XLSX', cls:'tbtn upload', icon:'upload',
    title:'Upload a filled-in CSV/XLSX to update the translations already here',
    act:{ loose:"document.getElementById('editorCsvInput').click()", folder:'openItemCsvModal()' } },
  { key:'approve',  label:'Approve copies', cls:'tbtn primary', icon:'check',
    act:{ loose:'openApprovalView()', folder:'openCampaignApprovalView()' } }
];

function csvEditorAct(act, key){
  return (typeof act === 'string') ? act : (act && act[key]) || '';
}

// Monta o HTML dos botões pra UMA superfície. Não toca nos elementos de presença
// (.presence-badge/.gp-stack/.live-status): eles são estáticos e vivem antes do wrapper.
function buildEditorToolbarHtml(surfaceKey){
  return CSV_EDITOR_TOOLBAR.map((b, bi) => {
    if(b.kind === 'dropdown'){
      const items = b.items.map(it =>
        `<button onclick="closeDlDropdown();${csvEditorAct(it.act, surfaceKey)}">${csvEditorIcon(it.icon, 13)}${it.label}</button>`
      ).join('');
      return `<div class="dl-dropdown-wrap" data-tb="${b.key}" data-tb-i="${bi}">
        <button class="${b.cls}" onclick="event.stopPropagation();toggleDlDropdown(event)">
          ${csvEditorIcon(b.icon)}${b.label}${csvEditorIcon('caret', 9)}
        </button>
        <div class="dl-dropdown-menu" style="display:none;">${items}</div>
      </div>`;
    }
    const t  = b.title ? ` title="${String(b.title).replace(/"/g,'&quot;')}"` : '';
    const i1 = b.i18nTitle ? ` data-i18n-title="${b.i18nTitle}"` : '';
    const i2 = b.i18n ? ` data-i18n="${b.i18n}"` : '';
    return `<button class="${b.cls}" data-tb="${b.key}" data-tb-i="${bi}"${t}${i1} onclick="${csvEditorAct(b.act, surfaceKey)}">`
         + `${csvEditorIcon(b.icon)}<span${i2}>${b.label}</span></button>`;
  }).join('');
}

/* ── CABER NA LARGURA DISPONÍVEL ─────────────────────────────────────────────────────────────
 * O painel da grade dentro de uma pasta é mais estreito que o do editor avulso (o preview come
 * 42% da tela lá). Com a barra completa, .ph-a quebrava em três linhas e empurrava a grade pra
 * baixo. A saída NÃO é a pasta ter menos botões — seria voltar ao problema que esta refatoração
 * resolveu. É a MESMA barra recolher o excedente num menu "More", pela mesma regra nos dois:
 * quem sobra é sempre o de menor prioridade, então em larguras iguais as duas ficam idênticas.
 *
 * A ordem de sacrifício é a inversa desta lista — 'rescan' sai primeiro, 'approve' (o CTA)
 * nunca sai.                                                                                  */
const CSV_EDITOR_KEEP_ORDER = ['approve','download','upload','html','editHtml','history','backup','rescan'];

function fitEditorToolbar(host){
  const slot = host && host.querySelector('.ed-tools');
  if(!slot) return;
  const more     = slot.querySelector('.ed-more');
  const moreMenu = slot.querySelector('.ed-more-menu');
  if(!more || !moreMenu) return;
  const ph = host.closest('.ph') || host;

  // Devolve tudo pra barra antes de medir: sem isto a decisão anterior vira entrada da próxima
  // e a barra só sabe encolher, nunca voltar a crescer quando a janela abre.
  // Reinserido na ORDEM DECLARADA (data-tb-i), não na ordem em que saiu — senão cada ciclo de
  // recolher/restaurar embaralhava a barra.
  Array.from(moreMenu.children).forEach(el => slot.insertBefore(el, more));
  const idx = el => parseInt(el.getAttribute('data-tb-i') || '0', 10);
  Array.from(slot.children)
    .filter(el => el !== more)
    .sort((a, b) => idx(a) - idx(b))
    .forEach(el => slot.insertBefore(el, more));
  more.style.display = 'none';

  // Mede o TRANSBORDO REAL em vez de estimar a largura livre. A primeira versão calculava
  // "espaço da .ph menos o que os irmãos ocupam" e errava: a própria .ph já estava transbordando
  // (scrollWidth 877 > clientWidth 811), então a conta dava folga onde não havia e o botão
  // "Approve copies" saía cortado na borda. scrollWidth > clientWidth é a pergunta direta, e
  // se corrige sozinha a cada item retirado.
  const cabe = () => ph.scrollWidth <= ph.clientWidth + 1;
  if(cabe()) return;

  more.style.display = '';
  const porChave = {};
  Array.from(slot.children).forEach(el => { porChave[el.getAttribute('data-tb') || ''] = el; });
  // Ordem de sacrifício = inversa da prioridade; 'approve' (o CTA) nunca sai.
  for(const chave of CSV_EDITOR_KEEP_ORDER.slice().reverse()){
    if(cabe()) return;
    if(chave === 'approve') continue;
    const el = porChave[chave];
    if(!el) continue;
    // Entra no menu na ORDEM DECLARADA, não na ordem de sacrifício — senão o menu abria de trás
    // pra frente (Re-scan no topo, Copy Tagged HTML lá embaixo), que não é como a barra lê.
    const meu = idx(el);
    const depois = Array.from(moreMenu.children).find(x => idx(x) > meu);
    moreMenu.insertBefore(el, depois || null);
  }
}

// Redesenha as DUAS barras a partir da mesma lista. Chamado quando cada editor abre; barrado
// pelo soft block depois (softBlockApplyUi esconde o que aquele papel não pode usar).
function renderEditorToolbars(){
  const mounts = [['edToolbar','loose'], ['campItemToolbar','folder']];
  mounts.forEach(([id, key]) => {
    const host = document.getElementById(id);
    if(!host) return;
    const slot = host.querySelector('.ed-tools');
    if(!slot) return;
    slot.innerHTML = buildEditorToolbarHtml(key)
      + `<div class="dl-dropdown-wrap ed-more" style="display:none;">
           <button class="tbtn" title="More actions" onclick="event.stopPropagation();toggleEdMore(event)">
             ${csvEditorIcon('more')}
           </button>
           <div class="dl-dropdown-menu ed-more-menu" style="display:none;right:0;left:auto;"></div>
         </div>`;
    fitEditorToolbar(host);
    observeEditorToolbar(host);
  });
}

function toggleEdMore(ev){
  const wrap = ev.currentTarget.closest('.ed-more');
  const menu = wrap && wrap.querySelector('.ed-more-menu');
  if(!menu) return;
  const abrindo = menu.style.display === 'none';
  document.querySelectorAll('.ed-more-menu').forEach(m => m.style.display = 'none');
  menu.style.display = abrindo ? '' : 'none';
}
document.addEventListener('click', e => {
  document.querySelectorAll('.ed-more-menu').forEach(menu => {
    if(menu.style.display === 'none') return;
    const wrap = menu.closest('.ed-more');
    if(wrap && !wrap.contains(e.target)) menu.style.display = 'none';
  });
});
/* Recalcular na hora certa. Um simples listener de window.resize NÃO basta: renderEditorToolbars
 * roda de dentro de buildTable/renderCampaignGrid, que podem executar com o painel ainda
 * ESCONDIDO. Aí clientWidth é 0, "cabe()" responde que sim, nada é recolhido — e a barra estoura
 * assim que o painel aparece, sem nenhum resize de janela pra corrigir.
 * O ResizeObserver cobre os três casos de uma vez: painel virando visível (0 -> largura real),
 * janela redimensionada, e o divisor grade/preview mudando de proporção. */
let _tbFitting = false;
const _tbObserver = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => {
  if(_tbFitting) return;           // fit muda o layout do próprio elemento observado — sem esta
  _tbFitting = true;               // trava, o observer se realimentaria em loop
  requestAnimationFrame(() => {
    try {
      ['edToolbar','campItemToolbar'].forEach(id => {
        const h = document.getElementById(id);
        if(h && h.clientWidth > 0) fitEditorToolbar(h);
      });
    } finally { _tbFitting = false; }
  });
}) : null;

function observeEditorToolbar(host){
  if(!_tbObserver || !host || host._tbObserved) return;
  host._tbObserved = true;
  const ph = host.closest('.ph') || host;
  _tbObserver.observe(ph);
}
