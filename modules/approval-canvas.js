/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * modules/approval-canvas.js — APPROVAL VIEW: canvas pannable/zoomable (estilo Figma) com os
 * previews lado a lado, comentários ancorados por seleção (threads + @menção + verificar),
 * presença ao vivo (cursores), aprovação por frame, download PNG e o painel lateral.
 *
 * SEPARADO do index.html só pra ORGANIZAÇÃO — NÃO é um módulo isolado com IIFE: é código de
 * escopo global (classic script), igual ao que era quando morava no <script> inline. As funções
 * continuam globais (chamadas por onclick= no HTML e por bare-name a partir do index), e leem os
 * globais do app (S, buildPreviewHtml, sortLangsForDisplay, COUNTRIES, authCurrentUser, sbClient,
 * isLangApproved, currentProjectId, _campaign, _campaignPushPreview, _campaignInappPreview, etc.)
 * também por bare-name — o que funciona porque classic scripts compartilham o mesmo ambiente
 * léxico/global. Carregado DEPOIS do inline (as referências só acontecem em runtime).
 *
 * O listener global de 'message' que trata av-height/av-selection/av-wheel FICOU no index.html
 * (é compartilhado com braze-height/camp-height); ele chama estas funções em runtime.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   APPROVAL VIEW — canvas pannable/zoomable (estilo Figma) com todos os
   e-mails abertos lado a lado, nome do país acima de cada frame,
   comentários ancorados por clique com threads e @menção, painel
   lateral com tudo, e "Mark as done" que avisa o dono do projeto.
═══════════════════════════════════════════════════════════════════ */

// Sanitiza um lang code (ex: 'es-ES') para um id de elemento HTML válido.
function cssSafeLang(lang) {
  return String(lang).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Origin primeiro, depois os demais idiomas na ordem fixa global (sortLangsForDisplay).
function approvalLangs() {
  const origLang = S.allC.find(c => c.code === S.origin)?.lang || null;
  const langs = [];
  if(origLang) langs.push(origLang);
  sortLangsForDisplay(S.csv.langs || []).forEach(l => { if(l !== origLang) langs.push(l); });
  return { origLang, langs };
}

/* ═══════════════════════════════════════════════════════════════════
   FASE 2 — Approval View generalizada por "frame descriptor".
   Dois modos:
     - 'single' (fluxo "Approve copies" clássico): UM item × TODOS os idiomas.
       Um frame por idioma, lendo o S global do item ativo. key === cssSafeLang(lang),
       IDÊNTICO aos ids de DOM de antes — o comportamento single é preservado byte-a-byte.
     - 'locale' (novo "Approve by Locale" dentro de uma pasta): UM locale fixo × MUITOS
       itens. Um frame por item (que tenha aquele locale), todos no mesmo idioma. Cada
       frame aponta S (+ _campaignItemIndex + flags push/inapp) pro item dele via
       avActivateFrame, então TODO o código baseado em S continua operando no item certo.
═══════════════════════════════════════════════════════════════════ */
let _avMode = 'single';   // 'single' | 'locale'
let _avLocale = null;      // locale code quando mode === 'locale'
let _avFrames = [];        // descritores reconstruídos a cada render
let _avFramesByKey = {};

function avBuildFrames() {
  _avFrames = [];
  if(_avMode === 'locale') {
    (_campaign && _campaign.items || []).forEach((it, idx) => {
      if(!(it.langs || []).includes(_avLocale)) return;
      _avFrames.push({ key: 'it' + idx, lang: _avLocale, isOrig: false, itemIndex: idx, item: it, type: it.type, title: it.name });
    });
  } else {
    const { origLang, langs } = approvalLangs();
    const type = _campaignPushPreview ? 'push' : _campaignInappPreview ? 'inapp' : 'email';
    langs.forEach(l => {
      const country = S.allC.find(c => c.lang === l);
      _avFrames.push({ key: cssSafeLang(l), lang: l, isOrig: l === origLang, itemIndex: -1, item: null, type, title: country?.name || l, country });
    });
  }
  _avFramesByKey = {}; _avFrames.forEach(f => { _avFramesByKey[f.key] = f; });
  return _avFrames;
}

// No modo locale, aponta S (+ _campaignItemIndex + flags push/inapp) pro item deste frame,
// pra que todo o código baseado em S opere sobre ele. No-op no single (S já está correto).
function avActivateFrame(f) {
  if(_avMode !== 'locale' || !f || f.itemIndex < 0) return;
  _campaignItemIndex = f.itemIndex;
  activateCampaignItemIntoS(_campaign.items[f.itemIndex]);
}

// Persiste o estado de aprovação do item de volta em _campaign (só no modo locale).
// Síncrono: garante que a ativação de um próximo frame não descarte a escrita recém-feita.
function avCommitIfLocale() {
  if(_avMode === 'locale') { commitCampaignItemApprovalState(); scheduleCampaignAutosave(); }
}

// Acha qual frame/item é dono de um comentário (por id) — usado no modo locale pela sidebar
// agregada, pra rotear reply/verify/highlight/delete pro item certo antes de mexer em S.
// No single mode devolve o único frame que casa o lang (ou null — o caller usa o path S normal).
function avFrameOwningComment(id) {
  if(_avMode !== 'locale') return null;
  for(const f of _avFrames) {
    const arr = (f.item && f.item.approvalComments) || [];
    if(arr.some(c => c.id === id)) return f;
  }
  return null;
}

// Entra direto na Approval View de um projeto compartilhado, sem passar pelo editor —
// usado pelo botão "Approve copies" do Dashboard quando a pessoa é só approver.
// Não usa projOpen(): aquele fluxo reivindica o lock de edição de 3min e regrava o CSV,
// o que não faz sentido pra quem só está revisando/comentando as copies.
function approverOpenProject(id) {
  const p = projGetAll().find(x => x.id === id);
  if(!p) return;
  if(!(p.data && p.data.html && p.data.csv)) { uiAlert('This project has no content yet.'); return; }
  // Enquanto o dono/editor estiver com o projeto aberto pra edição, ninguém aprova —
  // os approvers podem coexistir livremente entre si, só não com quem está editando.
  if(projIsLocked(p)) {
    uiAlert(`This project is currently being edited by ${authorName(p.lockedBy)}. Please try again once editing is done.`);
    return;
  }
  currentProjectId = id;
  _lockTakeoverShown = false;
  claimApprovingPresence(id);
  document.getElementById('dashboardScreen').style.display = 'none';
  document.getElementById('appBody').style.display = '';
  document.getElementById('hdrBar').style.display = '';
  document.getElementById('dashBtn').classList.remove('active');
  restoreProjectContent(p.data, true);
  if(S.rawHtml) openApprovalView();
}

function openApprovalView() {
  _avMode = 'single'; _avLocale = null; // entrada clássica: um item × idiomas (single)
  if(!S.rawHtml && !_campaignPushPreview) { uiAlert('Upload an HTML first.'); return; }
  document.getElementById('approvalView').classList.add('show');
  const sub = document.getElementById('avSubtitle');
  if(sub) sub.textContent = S.csv.name || '';
  renderApprovalGrid();
  // renderApprovalSidebar() já chama renderApprovalDoneBanner() internamente no fim.
  renderApprovalSidebar();
  renderApprovalActivityFeed();
  avPresenceJoin();
}

// Novo entry point "Approve by Locale": UM locale fixo × MUITOS itens da pasta (um frame por
// item que tenha esse locale). NÃO depende de S.rawHtml (S pode estar velho — cada frame
// ativa o seu item via avActivateFrame). Reusa TODA a máquina de comentários/aprovação/PNG.
function openApprovalViewByLocale(locale) {
  _avMode = 'locale'; _avLocale = locale;
  const frames = avBuildFrames();
  if(!frames.length) { _avMode = 'single'; _avLocale = null; uiAlert('Nothing to approve in this language yet.'); return; }
  document.getElementById('approvalView').classList.add('show');
  const sub = document.getElementById('avSubtitle');
  if(sub) sub.textContent = ((_campaign && _campaign.name) || '') + ' — ' + toBrazeLang(locale);
  renderApprovalGrid();
  renderApprovalSidebar();      // já chama renderApprovalDoneBanner() internamente no fim
  renderApprovalActivityFeed();
  avPresenceJoin();
}

function closeApprovalView() {
  document.getElementById('approvalView').classList.remove('show');
  closeNewPinBox();
  releaseMyApprovingPresence(); // libera a exclusão mútua com edição assim que eu saio da revisão
  avPresenceLeave();
  // Approver entra com o appBody visível de propósito (pra montar o editor por trás do overlay),
  // mas ele nunca deveria acabar OLHANDO essa tabela — isso é só pra quem está de fato editando.
  // Por isso sempre volta pro Dashboard nesse caso, mesmo com o appBody tecnicamente visível.
  // Se vier do editor normal (dono/editor usando "Approve copies" por dentro), só fecha o
  // overlay e volta pra tabela do CSV, como sempre.
  if(_campaign) {
    const wasLocale = _avMode === 'locale';
    commitCampaignItemApprovalState();
    saveCampaignProject();
    _avMode = 'single'; _avLocale = null; // reseta o modo ao sair
    // No modo locale, volta pra visão "By Locale" da pasta (não pra galeria/edit).
    if(wasLocale && typeof renderCampaignByLocale === 'function') renderCampaignByLocale();
    else renderCampaignMain();
    return;
  }
  _avMode = 'single'; _avLocale = null; // reseta o modo ao sair (fluxo single clássico)
  if(_approverMode || !document.getElementById('appBody') || document.getElementById('appBody').style.display === 'none') {
    goToDashboard();
  }
}

/* ── Presença ao vivo (estilo Figma): avatares de quem está online + cursores em
   tempo real dos outros aprovadores navegando no canvas ──
   Usa um canal de Realtime "broadcast + presence" do Supabase, por projeto — não
   grava nada no banco, é só um pub/sub efêmero enquanto a Approval View está aberta.
   As posições trafegadas são em coordenadas do CONTEÚDO do canvas (antes do
   pan/zoom de cada um), como o Figma faz: cada viewer aplica a SUA PRÓPRIA câmera
   (_avView) por cima da mesma posição de documento, então o cursor aparece no
   lugar certo pra cada pessoa mesmo com zooms/pans diferentes. */
const AV_CURSOR_COLORS = ['#f2496b','#3b82f6','#0891b2','#8b5cf6','#f59e0b','#059669','#d8385e','#6366f1'];
function avColorForEmail(email) {
  let h = 0;
  for(let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return AV_CURSOR_COLORS[h % AV_CURSOR_COLORS.length];
}

let _avPresenceChannel = null;
let _avRemoteCursors = {};      // email -> {x, y, color, name, at}
let _avCursorPruneTimer = null;
let _avCursorSendThrottle = null;

function avPresenceJoin() {
  const sb = sbClient();
  const me = authCurrentUser();
  if(!sb || !me || !currentProjectId) return;
  avPresenceLeave(); // por segurança, nunca deixa dois canais abertos ao mesmo tempo
  _avRemoteCursors = {};
  const channel = sb.channel('mlt-av-presence-' + currentProjectId, { config: { presence: { key: me.email } } });
  channel.on('presence', { event: 'sync' }, () => renderAvOnlineStack(channel.presenceState()));
  channel.on('broadcast', { event: 'cursor' }, ({ payload }) => {
    if(!payload || payload.email === me.email) return;
    _avRemoteCursors[payload.email] = { ...payload, at: Date.now() };
    renderAvRemoteCursors();
  });
  channel.on('broadcast', { event: 'leave' }, ({ payload }) => {
    if(!payload) return;
    delete _avRemoteCursors[payload.email];
    renderAvRemoteCursors();
  });
  channel.subscribe(status => {
    if(status === 'SUBSCRIBED') channel.track({ email: me.email, at: Date.now() });
  });
  _avPresenceChannel = channel;

  document.getElementById('avCanvasViewport')?.addEventListener('mousemove', avSendCursorPosition);
  _avCursorPruneTimer = setInterval(avPruneStaleCursors, 3000);
}

function avPresenceLeave() {
  document.getElementById('avCanvasViewport')?.removeEventListener('mousemove', avSendCursorPosition);
  clearInterval(_avCursorPruneTimer);
  _avCursorPruneTimer = null;
  if(_avPresenceChannel) {
    const me = authCurrentUser();
    if(me) { try { _avPresenceChannel.send({ type: 'broadcast', event: 'leave', payload: { email: me.email } }); } catch(e){} }
    _avPresenceChannel.unsubscribe();
    _avPresenceChannel = null;
  }
  _avRemoteCursors = {};
  const layer = document.getElementById('avCursorLayer');
  if(layer) layer.innerHTML = '';
  const stack = document.getElementById('avOnlineStack');
  if(stack) stack.innerHTML = '';
}

// Manda no máximo ~20x/s — suficiente pra parecer ao vivo sem inundar o canal.
function avSendCursorPosition(e) {
  if(_avCursorSendThrottle) return;
  _avCursorSendThrottle = setTimeout(() => { _avCursorSendThrottle = null; }, 50);
  if(!_avPresenceChannel) return;
  const me = authCurrentUser();
  if(!me) return;
  const vp = document.getElementById('avCanvasViewport');
  const rect = vp.getBoundingClientRect();
  // Desfaz o pan/zoom DESTA sessão pra chegar na posição em coordenadas do documento
  // (o mesmo espaço em que os frames são posicionados em renderApprovalGrid).
  const docX = (e.clientX - rect.left - _avView.tx) / _avView.scale;
  const docY = (e.clientY - rect.top - _avView.ty) / _avView.scale;
  _avPresenceChannel.send({
    type: 'broadcast', event: 'cursor',
    payload: { email: me.email, name: authorName(me.email), color: avColorForEmail(me.email), x: docX, y: docY }
  });
}

function avPruneStaleCursors() {
  const now = Date.now();
  let changed = false;
  Object.keys(_avRemoteCursors).forEach(email => {
    if(now - _avRemoteCursors[email].at > 8000) { delete _avRemoteCursors[email]; changed = true; }
  });
  if(changed) renderAvRemoteCursors();
}

// Só atualiza a posição/escala da camada (transform é composto pela GPU, não gera
// reflow) — chamada a cada tick de pan/zoom/scroll. NÃO reconstrói o innerHTML: os
// cursores filhos já têm seu próprio translate() em coordenadas de documento, então
// mover/escalar só o wrapper já reprojeta todos eles corretamente pra câmera atual.
function updateAvCursorLayerTransform() {
  const layer = document.getElementById('avCursorLayer');
  if(layer) layer.style.transform = `translate(${_avView.tx}px, ${_avView.ty}px) scale(${_avView.scale})`;
}

// Reconstrói o conteúdo (quem está e onde) — só precisa rodar quando os DADOS dos
// cursores mudam (chegou uma posição nova, alguém saiu, expirou por inatividade),
// nunca a cada tick de scroll/zoom — isso é o que deixava o scroll pesado.
function renderAvRemoteCursors() {
  updateAvCursorLayerTransform();
  const layer = document.getElementById('avCursorLayer');
  if(!layer) return;
  const emails = Object.keys(_avRemoteCursors);
  layer.innerHTML = emails.map(email => {
    const c = _avRemoteCursors[email];
    const esc = s => String(s || '').replace(/</g, '&lt;');
    return `<div class="av-remote-cursor" style="transform:translate(${c.x}px,${c.y}px)">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="${c.color}" stroke="#fff" stroke-width="1.5"><path d="M5 3l14 8-6.5 1.5L10 20z"/></svg>
      <span class="av-remote-cursor-label" style="background:${c.color}">${esc(c.name)}</span>
    </div>`;
  }).join('');
}

function renderAvOnlineStack(presenceState) {
  const stack = document.getElementById('avOnlineStack');
  if(!stack) return;
  const emails = Object.keys(presenceState || {});
  stack.innerHTML = emails.map(email => {
    const name = authorName(email);
    const initials = name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    return `<div class="av-online-avatar" style="background:${avColorForEmail(email)}" title="${name} · online now">${initials}</div>`;
  }).join('');
}

/* ── Canvas pannable/zoomable ── */
// 680px (não 600) de propósito: o breakpoint mobile mais comum nesses templates é
// "@media (max-width:620px)" — um frame de exatamente 600px cairia dentro dele e
// renderizaria empilhado feito celular, mesmo essa vitrine querendo mostrar o desktop.
const AV_FRAME_W = 680, AV_FRAME_GAP = 90, AV_FRAME_TOP = 50;
const AV_INAPP_FRAME_W = 320, AV_INAPP_FRAME_H = 640; // in-app é overlay fixed em tela cheia — vira uma "tela de celular" de tamanho fixo, não uma altura auto tipo e-mail
const AV_PUSH_FRAME_W = 380;   // push é um card de notificação pequeno — NÃO deve seguir a largura de e-mail
// Largura do frame por tipo: e-mail (680), in-app (320, tela de celular), push (380, card pequeno).
function avFrameW() { return _campaignInappPreview ? AV_INAPP_FRAME_W : (_campaignPushPreview ? AV_PUSH_FRAME_W : AV_FRAME_W); }
// Gap ENTRE frames: push/in-app são pequenos, então ficam mais PRÓXIMOS (44) que os e-mails (90).
function avFrameGap() { return (_campaignPushPreview || _campaignInappPreview) ? 44 : AV_FRAME_GAP; }
// Larguras/gaps a partir do TIPO do frame (sem ativar S) — usado nas somas de largura total
// (avContentWidth/avFitToFrames), chamadas a cada tick de scroll: ativar o item inteiro só
// pra medir seria caro no modo locale. Mesmos valores de avFrameW()/avFrameGap().
function avFrameWFor(type) { return type === 'inapp' ? AV_INAPP_FRAME_W : (type === 'push' ? AV_PUSH_FRAME_W : AV_FRAME_W); }
function avFrameGapFor(type) { return (type === 'push' || type === 'inapp') ? 44 : AV_FRAME_GAP; }
let _avView = { scale: 1, tx: 40, ty: 60 };
let _avPan = { active: false, moved: false, startX: 0, startY: 0, startTx: 0, startTy: 0 };
let _avSuppressNextClick = false;

function applyAvTransform() {
  const canvas = document.getElementById('avCanvas');
  if(canvas) canvas.style.transform = `translate(${_avView.tx}px, ${_avView.ty}px) scale(${_avView.scale})`;
  const pct = document.getElementById('avZoomPct');
  if(pct) pct.textContent = Math.round(_avView.scale * 100) + '%';
  updateAvCursorLayerTransform(); // só reprojeta (transform), sem reconstruir o HTML a cada tick
  updateAvHScrollbar();
}

// Largura total do conteúdo do canvas, em unidades do próprio canvas (antes do scale) —
// mesma conta usada em avFitToFrames pra caber tudo na tela.
function avContentWidth() {
  const frames = avBuildFrames();
  let w = 0;
  frames.forEach(f => { w += avFrameWFor(f.type) + avFrameGapFor(f.type); });
  return w;
}

// Barra de rolagem horizontal "de verdade" pro canvas com pan/zoom via transform —
// não existe scrollbar nativa aqui, então isso é o único jeito da pessoa perceber
// (e usar) que dá pra arrastar o conteúdo pros lados depois de dar zoom.
let _avHDrag = null; // {startX, startThumbLeft, trackWidth, thumbWidth, contentScreenW, scrollableScreenW}

// Espaço confortável (em pixels de TELA, não de canvas — fica igual em qualquer zoom) que
// sobra nas duas pontas do arrasto. Sem isso, o pan parava exatamente na borda do e-mail —
// dava a sensação de "esbarrar na parede" em vez de ter uma folga respirável dos lados.
const AV_HPAD = 64;

// arrastar rápido (o canvas OU a própria barra) disparava isso a cada mousemove — muitos
// por segundo — e cada chamada lia clientWidth/getBoundingClientRect (força layout).
// Ler e escrever layout intercalado a essa taxa é o clássico "layout thrashing" e trava a
// UI num arrasto rápido. Agora no máximo 1 recálculo por frame de animação (rAF).
let _avHScrollRaf = null;
function updateAvHScrollbar() {
  if(_avHScrollRaf) return;
  _avHScrollRaf = requestAnimationFrame(() => { _avHScrollRaf = null; _updateAvHScrollbarNow(); });
}

function _updateAvHScrollbarNow() {
  const bar = document.getElementById('avHScroll');
  const thumb = document.getElementById('avHScrollThumb');
  const vp = document.getElementById('avCanvasViewport');
  if(!bar || !thumb || !vp) return;
  const contentW = avContentWidth();
  if(!contentW) { bar.classList.remove('show'); return; }
  const contentScreenW = contentW * _avView.scale + AV_HPAD * 2;
  const trackWidth = bar.clientWidth;
  const thumbRatio = Math.min(1, vp.clientWidth / contentScreenW);
  if(thumbRatio >= 1) { bar.classList.remove('show'); return; } // conteúdo (+ folga) cabe todo — nada pra rolar
  bar.classList.add('show');
  const thumbWidth = Math.max(32, trackWidth * thumbRatio);
  const scrollableScreenW = contentScreenW - vp.clientWidth;
  const scrollRatio = scrollableScreenW > 0 ? Math.min(1, Math.max(0, (AV_HPAD - _avView.tx) / scrollableScreenW)) : 0;
  const thumbLeft = scrollRatio * (trackWidth - thumbWidth);
  thumb.style.width = thumbWidth + 'px';
  thumb.style.left = thumbLeft + 'px';
}

function avHScrollThumbDown(e) {
  e.stopPropagation();
  e.preventDefault();
  const bar = document.getElementById('avHScroll');
  const thumb = document.getElementById('avHScrollThumb');
  const vp = document.getElementById('avCanvasViewport');
  if(!bar || !thumb || !vp) return;
  const contentScreenW = avContentWidth() * _avView.scale + AV_HPAD * 2;
  _avHDrag = {
    startX: e.clientX,
    startThumbLeft: parseFloat(thumb.style.left) || 0,
    trackWidth: bar.clientWidth,
    thumbWidth: thumb.getBoundingClientRect().width,
    scrollableScreenW: contentScreenW - vp.clientWidth
  };
  thumb.classList.add('dragging');
}

function avHScrollMouseMove(e) {
  if(!_avHDrag) return;
  const dx = e.clientX - _avHDrag.startX;
  const maxThumbLeft = _avHDrag.trackWidth - _avHDrag.thumbWidth;
  const newThumbLeft = Math.min(maxThumbLeft, Math.max(0, _avHDrag.startThumbLeft + dx));
  const scrollRatio = maxThumbLeft > 0 ? newThumbLeft / maxThumbLeft : 0;
  _avView.tx = AV_HPAD - scrollRatio * _avHDrag.scrollableScreenW;
  applyAvTransform();
}

function avHScrollMouseUp() {
  if(!_avHDrag) return;
  _avHDrag = null;
  document.getElementById('avHScrollThumb')?.classList.remove('dragging');
}

document.addEventListener('mousemove', avHScrollMouseMove);
document.addEventListener('mouseup', avHScrollMouseUp);
window.addEventListener('resize', () => { if(document.getElementById('approvalView')?.classList.contains('show')) updateAvHScrollbar(); });

// Clicar direto na trilha (fora do thumb) pula a rolagem pra ali, igual scrollbar nativa.
function avHScrollTrackClick(e) {
  if(e.target.id === 'avHScrollThumb') return;
  const bar = document.getElementById('avHScroll');
  const thumb = document.getElementById('avHScrollThumb');
  const vp = document.getElementById('avCanvasViewport');
  if(!bar || !thumb || !vp) return;
  const rect = bar.getBoundingClientRect();
  const thumbWidth = thumb.getBoundingClientRect().width;
  const contentScreenW = avContentWidth() * _avView.scale + AV_HPAD * 2;
  const scrollableScreenW = contentScreenW - vp.clientWidth;
  const clickX = e.clientX - rect.left - thumbWidth / 2;
  const maxThumbLeft = rect.width - thumbWidth;
  const scrollRatio = maxThumbLeft > 0 ? Math.min(1, Math.max(0, clickX / maxThumbLeft)) : 0;
  _avView.tx = AV_HPAD - scrollRatio * scrollableScreenW;
  applyAvTransform();
}

function avFitToFrames() {
  const frames = avBuildFrames();
  const vp = document.getElementById('avCanvasViewport');
  if(!vp || !frames.length) return;
  let totalW = 0;
  frames.forEach(f => { totalW += avFrameWFor(f.type) + avFrameGapFor(f.type); });
  const availW = vp.clientWidth - 80;
  _avView.scale = Math.max(0.15, Math.min(1, availW / totalW));
  _avView.tx = 40;
  _avView.ty = 60;
  applyAvTransform();
}

function avZoomBy(factor, cx, cy) {
  const vp = document.getElementById('avCanvasViewport');
  const rect = vp ? vp.getBoundingClientRect() : { width: 800, height: 600, left: 0, top: 0 };
  const px = cx !== undefined ? cx - rect.left : rect.width / 2;
  const py = cy !== undefined ? cy - rect.top : rect.height / 2;
  const oldScale = _avView.scale;
  const newScale = Math.min(2.5, Math.max(0.12, oldScale * factor));
  _avView.tx = px - (px - _avView.tx) * (newScale / oldScale);
  _avView.ty = py - (py - _avView.ty) * (newScale / oldScale);
  _avView.scale = newScale;
  applyAvTransform();
}

function avZoomIn() { avZoomBy(1.2); }
function avZoomOut() { avZoomBy(1 / 1.2); }

function avViewportWheel(e) {
  e.preventDefault();
  if(e.ctrlKey || e.metaKey) {
    avZoomBy(1 - e.deltaY * 0.0015, e.clientX, e.clientY);
  } else {
    _avView.tx -= e.deltaX;
    _avView.ty -= e.deltaY;
    applyAvTransform();
  }
}

// Distingue "clique" (abre um comentário novo) de "arrastar" (só navega o canvas) —
// mesma lógica de qualquer ferramenta de whiteboard: só é clique se o cursor mal se moveu.
function avViewportMouseDown(e) {
  // #mentionDropdown mora fora da .av-newpin-box/.reply-input-box (ver comentário no HTML
  // dele) — sem essa checagem separada, clicar numa sugestão de @menção não batia em nenhum
  // dos dois closest() acima, e o pan da tela iniciava sozinho a cada menção escolhida.
  if(e.target.closest('.av-pin') || e.target.closest('.av-newpin-box') || e.target.closest('#mentionDropdown')) return;
  _avPan.active = true;
  _avPan.moved = false;
  _avPan.startX = e.clientX;
  _avPan.startY = e.clientY;
  _avPan.startTx = _avView.tx;
  _avPan.startTy = _avView.ty;
  document.getElementById('avCanvasViewport')?.classList.add('panning');
}

function avViewportMouseMove(e) {
  if(!_avPan.active) return;
  const dx = e.clientX - _avPan.startX, dy = e.clientY - _avPan.startY;
  if(Math.abs(dx) > 4 || Math.abs(dy) > 4) _avPan.moved = true;
  if(_avPan.moved) {
    _avView.tx = _avPan.startTx + dx;
    _avView.ty = _avPan.startTy + dy;
    applyAvTransform();
  }
}

function avViewportMouseUp() {
  if(_avPan.active && _avPan.moved) _avSuppressNextClick = true;
  _avPan.active = false;
  document.getElementById('avCanvasViewport')?.classList.remove('panning');
}

document.addEventListener('mousemove', avViewportMouseMove);
document.addEventListener('mouseup', avViewportMouseUp);

// Rótulo curto do tipo pro título do frame no modo locale.
function avTypeLabel(type) { return type === 'push' ? 'Push' : type === 'inapp' ? 'In-app' : 'Email'; }

function renderApprovalGrid() {
  const frames = avBuildFrames();
  const canvas = document.getElementById('avCanvas');
  if(!canvas) return;
  if(!frames.length) {
    canvas.style.width = '400px';
    canvas.innerHTML = `<div class="empty-state" style="width:360px;"><p>No languages configured yet.</p></div>`;
    return;
  }
  // Larguras variam POR frame no modo locale (email 680 / in-app 320 / push 380), então usa
  // um x acumulado em vez de um passo fixo. avActivateFrame aponta S/flags pro item de cada
  // frame ANTES de medir avFrameW()/avFrameGap() e de montar o markup dependente de S.
  let x = 0;
  const parts = [];
  frames.forEach(f => {
    avActivateFrame(f);
    const frameW = avFrameW();
    const frameGap = avFrameGap();
    const bare = (_campaignPushPreview || _campaignInappPreview);
    // Título: single = bandeira/país/lang/badge-origin; locale = ícone de documento + nome do
    // item + rótulo de tipo (Email/In-app/Push), SEM país e SEM badge de origem.
    const titleInner = _avMode === 'locale'
      ? `<span>📄</span>
         <span>${escHtml(f.title || '')}</span>
         <span class="av-frame-lang">${avTypeLabel(f.type)}</span>`
      : `<span>${f.country?.flag || '🌐'}</span>
         <span>${f.country?.name || f.lang}</span>
         <span class="av-frame-lang">${toBrazeLang(f.lang)}</span>
         ${f.isOrig ? '<span class="av-frame-origin-badge">origin</span>' : ''}`;
    // Cond-branch é um teste do fluxo single (um item × idiomas). No modo locale (itens
    // diferentes por frame) não faz sentido — esconde os botões.
    const condToggle = _avMode === 'single'
      ? `<span class="av-cb-toggle" title="Só teste de visualização — não afeta o HTML/CSV"${maxCondBranchCount(S.rawHtml)<=1?' style="display:none;"':''}>
            ${Array.from({length:maxCondBranchCount(S.rawHtml)}, (_,i) =>
              `<button class="av-cb-btn ${(S.condBranch|0)===i?'active':''}" onclick="event.stopPropagation();setApprovalCondBranch(${i})">${condBranchLabel(i,maxCondBranchCount(S.rawHtml))}</button>`
            ).join('')}
          </span>`
      : '';
    parts.push(`
      <div class="av-canvas-frame" style="left:${x}px;top:${AV_FRAME_TOP}px;width:${frameW}px;">
        <div class="av-canvas-frame-title">
          ${titleInner}
          <span class="av-frame-count" style="display:none;">0</span>
          ${condToggle}
          <button class="av-cb-btn" title="Download this preview as a PNG image" style="border:1px solid var(--border-s);" onclick="event.stopPropagation();downloadApprovalFramePng('${escJsAttr(f.key)}')">⬇ PNG</button>
          <span class="av-frame-approve-slot" id="avApproveSlot-${f.key}"></span>
        </div>
        <div class="av-frame-viewport${bare ? ' av-frame-viewport-bare' : ''}" id="avVp-${f.key}" style="width:${frameW}px;"></div>
      </div>
    `);
    x += frameW + frameGap;
  });
  canvas.style.width = x + 'px';
  canvas.innerHTML = parts.join('');
  frames.forEach(f => { loadApprovalFrame(f); renderFrameApproveSlot(f); });
  avFitToFrames();
}

// Toggle SÓ de teste/visualização (mesmo S.condBranch do preview principal — ver
// resolveConditionalBranch) — mostrado em CIMA de cada e-mail na Approval View, mas é um
// estado ÚNICO compartilhado entre todos os idiomas (clicar em qualquer frame atualiza
// todos), pra comparar o mesmo branch lado a lado em vários idiomas de uma vez. Nunca
// muda o HTML/CSV real, só recarrega os iframes de preview já abertos.
function setApprovalCondBranch(idx) {
  S.condBranch = idx|0;
  S.condRevealRow = null;
  document.querySelectorAll('.av-cb-btn').forEach(b => {
    const oc = b.getAttribute('onclick') || '';
    const mm = oc.match(/setApprovalCondBranch\((\d+)\)/);
    if(mm) b.classList.toggle('active', (+mm[1]) === (S.condBranch|0));
  });
  avBuildFrames().forEach(f => { avActivateFrame(f); loadApprovalFrame(f); });
}

// Botão de aprovação POR FRAME, acima de cada frame — aprovar/desaprovar um frame não afeta
// os outros, e trava/destrava comentários só nele. Recebe um descritor de frame.
function renderFrameApproveSlot(f) {
  avActivateFrame(f);
  const el = document.getElementById('avApproveSlot-' + f.key);
  if(!el) return;
  const done = isLangApproved(S.approvalDoneByLang, f.lang);
  el.innerHTML = done
    ? `<button class="av-frame-approved-btn" disabled>
         <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>
         Approved
       </button>
       <button class="av-frame-undo-btn" onclick="undoLangApproval('${f.key}')">Undo</button>`
    : `<button class="av-frame-approve-btn" onclick="markLangApproved('${f.key}')">
         <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>
         Approve
       </button>`;
}

// Injeta um reporter de altura (mesmo padrão de 'braze-height' já usado no viewer principal)
// pra que o frame cresça até a altura real do e-mail renderizado — sem scroll interno,
// já que navegar pelo conteúdo agora é feito dando zoom/pan no canvas, como no Figma.
// Push não tem rawHtml (não é upload de HTML, são 2 campos de texto puro) — monta um
// documento sintético com data-tid="id1"/"id2" pra que o mecanismo de comentar-por-seleção
// (que depende de achar o data-tid mais próximo) continue funcionando sem alteração.
function buildPushFrameHtml(f) {
  const lang = f.lang;
  const item = _campaign.items[_campaignItemIndex];
  const titleRow = item.rows.find(r => r.id === 'id1');
  const bodyRow = item.rows.find(r => r.id === 'id2');
  const origLang = S.allC.find(c => c.code === S.origin)?.lang;
  const isOrig = !lang || lang === origLang;
  const title = isOrig ? (titleRow?.src || '') : (titleRow?.translations?.[lang] || '');
  const body = isOrig ? (bodyRow?.src || '') : (bodyRow?.translations?.[lang] || '');
  return `<html><body style="margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:transparent;padding:20px 12px;">
    <div style="max-width:360px;background:#fff;border-radius:16px;padding:16px;box-shadow:0 2px 16px rgba(0,0,0,.12);display:flex;gap:12px;">
      <div style="width:44px;height:44px;border-radius:12px;background:#d8385e;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;">🔔</div>
      <div style="min-width:0;">
        <div data-tid="id1" style="font-weight:700;font-size:14px;color:#000;margin-bottom:2px;">${escHtml(title)}</div>
        <div data-tid="id2" style="font-size:13px;color:#333;line-height:1.4;">${escHtml(body)}</div>
      </div>
    </div>
  </body></html>`;
}

function buildApprovalFrameHtml(f) {
  avActivateFrame(f);
  let html = _campaignPushPreview ? buildPushFrameHtml(f) : buildPreviewHtml(f.lang);
  const sc = '<scr' + 'ipt>';
  const scEnd = '</scr' + 'ipt>';
  const script = sc + `(function(){
    function rh(){
      var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 400);
      window.parent.postMessage({type:'av-height', key:${JSON.stringify(f.key)}, height:h}, '*');
    }
    window.addEventListener('load', function(){ setTimeout(rh, 80); });

    // Comentar exige SELECIONAR um trecho de texto (igual Google Docs/Figma), não só clicar —
    // ao soltar o mouse com uma seleção não-vazia, acha a linha (data-tid) mais próxima pra
    // saber a qual id/idioma o comentário (e o botão de editar) devem se referir, e avisa o pai.
    function onMouseUp(){
      setTimeout(function(){
        var sel = window.getSelection();
        var text = sel ? sel.toString().trim() : '';
        if(!text || !sel.rangeCount) return;
        var range = sel.getRangeAt(0);
        var rect = range.getBoundingClientRect();
        var docW = document.documentElement.scrollWidth || document.body.scrollWidth || window.innerWidth;
        var docH = document.documentElement.scrollHeight || document.body.scrollHeight || window.innerHeight;
        if(!docW || !docH) return;
        var xPct = ((rect.left + rect.width / 2) / docW) * 100;
        var yPct = (rect.bottom / docH) * 100;
        var node = range.startContainer;
        var el = node.nodeType === 1 ? node : node.parentElement;
        // Footer é só um retrato de exemplo, nunca traduzido — selecionar texto ali
        // dentro não deve abrir caixinha de comentário (mesmo bloqueio do seletor de imagens).
        if(el && el.closest('.mlt-footer-block')) return;
        var tidEl = el ? el.closest('[data-tid]') : null;
        window.parent.postMessage({
          type: 'av-selection',
          key: ${JSON.stringify(f.key)},
          text: text.length > 300 ? text.slice(0, 300) + '…' : text,
          rowId: tidEl ? tidEl.getAttribute('data-tid') : null,
          xPct: Math.min(100, Math.max(0, xPct)),
          yPct: Math.min(100, Math.max(0, yPct))
        }, '*');
      }, 0);
    }
    document.addEventListener('mouseup', onMouseUp);

    // O iframe agora recebe eventos de mouse (pra seleção de texto funcionar), o que significa
    // que rolar o scroll do mouse EM CIMA do e-mail nunca chega ao listener de pan/zoom do
    // canvas no pai — eventos de wheel não atravessam a fronteira do iframe. Encaminha manualmente.
    document.addEventListener('wheel', function(ev){
      window.parent.postMessage({
        type: 'av-wheel', key: ${JSON.stringify(f.key)},
        deltaX: ev.deltaX, deltaY: ev.deltaY,
        ctrlKey: ev.ctrlKey, metaKey: ev.metaKey,
        x: ev.clientX, y: ev.clientY
      }, '*');
      ev.preventDefault();
    }, { passive: false });
  })()` + scEnd;
  if(html.includes('</body>')) html = html.replace('</body>', script + '</body>');
  else html += script;
  return html;
}

function loadApprovalFrame(f) {
  avActivateFrame(f);
  const vp = document.getElementById('avVp-' + f.key);
  if(!vp) return;
  const initH = f.type === 'push' ? 130 : f.type === 'inapp' ? AV_INAPP_FRAME_H : 900;
  vp.innerHTML = `<iframe style="width:100%;height:${initH}px;"></iframe>`;
  const iframe = vp.querySelector('iframe');
  iframe.src = URL.createObjectURL(new Blob([buildApprovalFrameHtml(f)], { type: 'text/html' }));
  renderApprovalPins(f);
}

let _pendingPin = null;

// Chamado pelo listener global de 'message' quando o iframe reporta uma seleção de texto válida
// (ver buildApprovalFrameHtml). Abre a caixinha de comentário ancorada onde o texto foi selecionado,
// já com a citação do trecho e (se identificado) um botão pra editar a tradução na hora.
function onFrameSelection(data) {
  const f = _avFramesByKey[data.key];
  if(!f) return;
  avActivateFrame(f); // S aponta pro item deste frame (no-op no single)
  if(f.isOrig) return; // origem é só referência — não dá pra comentar nem editar nela
  if(isLangApproved(S.approvalDoneByLang, f.lang)) return; // comentários travados enquanto ESSE frame estiver aprovado
  if(approvalBlockedByEdit()) { warnApprovalBlockedByEdit(); return; }
  const vp = document.getElementById('avVp-' + f.key);
  if(!vp) return;
  const rect = vp.getBoundingClientRect();
  // Coordenadas de TELA de verdade (getBoundingClientRect já reflete o zoom/transform atual do
  // canvas) — não mais coordenadas locais de vp. A caixa agora é position:fixed (ver
  // openNewPinBox), então precisa da posição real na tela, somando rect.left/top.
  const screenX = rect.left + rect.width * (data.xPct / 100);
  const screenY = rect.top + rect.height * (data.yPct / 100);
  // Selecionar só precisa apontar QUAL linha — a citação mostrada e o botão de editar sempre
  // trabalham com a linha INTEIRA, não só o pedacinho de texto que a pessoa arrastou o mouse por cima.
  const quote = data.rowId ? currentRowText(data.rowId, f.lang) : data.text;
  openNewPinBox(f, vp, screenX, screenY, data.xPct, data.yPct, f.lang, quote, data.rowId);
}

// Texto atual de uma linha, num idioma: a tradução se já existir, senão o texto de origem
// como valor padrão pronto pra edição (a pessoa só ajusta o que precisa, não parte do zero).
function currentRowText(rowId, lang) {
  const row = S.csv.rows.find(r => r.id === rowId);
  if(!row) return '';
  const origLang = S.allC.find(c => c.code === S.origin)?.lang;
  const isOrig = lang === origLang;
  return isOrig ? row.src : (row.translations[lang] || row.src || '');
}

function openNewPinBox(f, vp, screenX, screenY, xPct, yPct, lang, quote, rowId) {
  closeNewPinBox();
  _pendingPin = { key: f ? f.key : cssSafeLang(lang), itemIndex: f ? f.itemIndex : -1, lang, xPct, yPct, quote: quote || '', rowId: rowId || null };
  const box = document.createElement('div');
  box.className = 'av-newpin-box';
  box.id = 'avNewPinBox';
  // position:fixed com coordenadas de TELA (ver CSS .av-newpin-box) — não mais position:
  // absolute relativo a vp. vp vive dentro de #avCanvas, que tem transform:scale() aplicado
  // pro zoom (ver applyAvTransform) — um left/top em px num descendente de um ancestral com
  // scale() é resolvido no espaço de coordenadas LOCAL (pré-transform) daquele ancestral, mas
  // screenX/screenY vêm de getBoundingClientRect() (espaço de TELA, pós-transform). Em zoom
  // 100% os dois espaços coincidem por acaso, mas quanto mais zoom, maior o descompasso — a
  // caixa abria cada vez mais longe do ponto clicado de verdade, na proporção do zoom (esse
  // era o bug: "quando o zoom tá muito próximo, o box abre meio distante da seleção").
  // position:fixed + coordenadas de tela elimina esse descompasso — a caixa sempre abre bem
  // ao lado de onde a pessoa selecionou, em qualquer nível de zoom.
  box.style.left = Math.max(4, screenX) + 'px';
  box.style.top = (screenY + 12) + 'px';
  const esc = s => String(s || '').replace(/</g, '&lt;');
  // Mesma estrutura dos outros comentários do app (thread do CSV builder e sidebar da Approval
  // View): linha textarea+botão lado a lado (.av-reply-input-box), não textarea com uma linha
  // de botões EMBAIXO. Aquele layout antigo colocava o botão "Cancel" bem onde o dropdown de
  // @menção aparece (logo abaixo do textarea) — como a caixa é estreita (240px), o dropdown
  // cobria a largura quase toda, e ao MARCAR alguém (mousedown fecha o dropdown antes do
  // mouseup/click completar o gesto), esse clique vazava pro botão que ficava exposto embaixo,
  // fechando a caixa inteira. Com o botão ao LADO do textarea (não embaixo), não sobra nada
  // clicável na área onde o dropdown se posiciona.
  const editBtn = (rowId && isCurrentProjectOwner())
    ? `<button class="av-edit-btn" style="margin-bottom:6px;" onclick="event.stopPropagation();openAvEditModal('${rowId}','${lang}')">✎ Edit text</button>`
    : '';
  box.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:2px;">
      <button class="comment-del-btn" title="Cancel" onclick="event.stopPropagation();closeNewPinBox()">×</button>
    </div>
    ${quote ? `<div class="av-newpin-quote">${esc(quote)}</div>` : ''}
    ${editBtn}
    <div class="av-reply-input-box">
      <textarea id="avNewPinText" placeholder="Leave a comment… type @ to mention someone" oninput="handleMentionInput(event)" onkeydown="handleMentionKeydown(event)"></textarea>
      <button class="btn-go" style="padding:6px 10px;font-size:11px;" onclick="event.stopPropagation();submitNewPin()">Post</button>
    </div>
  `;
  box.onclick = e2 => e2.stopPropagation();
  // Body-level de propósito (mesmo padrão do #mentionDropdown) — não é mais filho de vp, que
  // vive dentro do container transformado (#avCanvas). Isso também é o que elimina o próprio
  // risco de scroll indesejado ao focar (#avCanvasViewport, com overflow:hidden, não é mais
  // ancestral deste elemento), mas preventScroll:true continua aqui por segurança/consistência.
  document.body.appendChild(box);
  setTimeout(() => document.getElementById('avNewPinText')?.focus({preventScroll:true}), 0);
}

function closeNewPinBox() {
  closeMentionDropdown();
  document.getElementById('avNewPinBox')?.remove();
  _pendingPin = null;
}

function submitNewPin() {
  // Nos dois bloqueios abaixo, NÃO fecha a caixa (closeNewPinBox apaga o <textarea> e,
  // com ele, qualquer texto ainda não enviado, sem chance de recuperação). Só avisa e
  // mantém a caixa aberta com o texto intacto — se o bloqueio for temporário (dono para
  // de editar), a pessoa ainda consegue clicar "Post" de novo depois, sem ter perdido nada.
  const f = _pendingPin ? _avFramesByKey[_pendingPin.key] : null;
  if(f) avActivateFrame(f); // garante S no item certo ANTES de checar aprovação e escrever
  if(_pendingPin && isLangApproved(S.approvalDoneByLang, _pendingPin.lang)) { return; }
  if(approvalBlockedByEdit()) { warnApprovalBlockedByEdit(); return; }
  const ta = document.getElementById('avNewPinText');
  const text = ta ? ta.value.trim() : '';
  if(!text || !_pendingPin) { closeNewPinBox(); return; }
  const { lang, xPct, yPct, quote, rowId } = _pendingPin;
  const comment = addApprovalComment(lang, xPct, yPct, text, null);
  if(!comment) return;
  comment.quote = quote || '';
  comment.rowId = rowId || null;
  // Escrita direto em S — no modo locale, comita de volta pro item SÍNCRONO antes que uma
  // próxima ativação de frame (ex: renderApprovalSidebar agregada) sobrescreva S e perca o novo.
  avCommitIfLocale();
  closeNewPinBox();
  if(f) renderApprovalPins(f);
  renderApprovalSidebar();
  scheduleApprovalAutosave();
}

// Cria um comentário (topo de thread, se parentId for null, ou uma resposta) e dispara as
// notificações certas: quem foi @mencionado, e o dono do projeto (se ele não for quem comentou
// nem já tiver sido @mencionado, pra não duplicar o aviso).
function addApprovalComment(lang, xPct, yPct, text, parentId) {
  const me = authCurrentUser();
  if(!me) return null;
  const mentions = extractMentions(text);
  const comment = {
    id: 'ac_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    lang, xPct: xPct ?? null, yPct: yPct ?? null, text,
    author: me.email, createdAt: Date.now(),
    parentId: parentId || null,
    mentions, resolvedBy: []
  };
  S.approvalComments.push(comment);
  scheduleApprovalAutosave();

  const p = projGetAll().find(x => x.id === currentProjectId);
  const projectName = (p && p.name) || S.csv.name || 'this project';
  const preview = text.length > 80 ? text.slice(0, 77) + '…' : text;

  mentions.forEach(email => {
    if(email.toLowerCase() === me.email.toLowerCase()) return;
    notifAdd(email, me.email,
      `${me.email} mentioned you in an approval comment on "${projectName}" (${langDisplayName(lang)})`,
      { projectId: currentProjectId, kind: 'approval', commentId: comment.id, preview }
    );
  });
  if(p && p.owner && p.owner.toLowerCase() !== me.email.toLowerCase() && !mentions.some(e => e.toLowerCase() === p.owner.toLowerCase())) {
    notifAdd(p.owner, me.email,
      `${me.email} left an approval comment on "${projectName}" (${langDisplayName(lang)})`,
      { projectId: currentProjectId, kind: 'approval', commentId: comment.id, preview }
    );
  }
  return comment;
}

function renderApprovalPins(f) {
  avActivateFrame(f);
  const vp = document.getElementById('avVp-' + f.key);
  if(!vp) return;
  vp.querySelectorAll('.av-pin').forEach(p => p.remove());
  // Só comentários de topo (sem parentId) viram pin — respostas ficam na mesma marcação da thread.
  // No modo locale, S é o item deste frame, então estes são os comentários daquele item no locale.
  const topLevel = S.approvalComments.filter(c => c.lang === f.lang && !c.parentId);
  topLevel.forEach((c, i) => {
    const pin = document.createElement('div');
    pin.className = 'av-pin' + (c.resolvedBy.length ? ' resolved' : '');
    pin.style.left = c.xPct + '%';
    pin.style.top = c.yPct + '%';
    pin.title = c.text;
    pin.innerHTML = `<span>${i + 1}</span>`;
    pin.onclick = e => { e.stopPropagation(); highlightApprovalComment(c.id); };
    vp.appendChild(pin);
  });
  const card = vp.closest('.av-canvas-frame');
  const countEl = card ? card.querySelector('.av-frame-count') : null;
  if(countEl) {
    countEl.textContent = String(topLevel.length);
    countEl.style.display = topLevel.length ? 'inline-flex' : 'none';
  }
}

function renderApprovalSidebar() {
  const countEl = document.getElementById('avCommentCount');
  const list = document.getElementById('avSidebarList');
  if(!list) return;
  // Fecha qualquer dropdown de menção aberto antes de reconstruir a lista — #mentionDropdown
  // mora fora daqui (ver HTML), então não é destruído por este innerHTML, mas continuar
  // "aberto" apontando pra uma caixa de resposta que está prestes a sumir ficaria estranho.
  closeMentionDropdown();

  // Preserva uma caixa de RESPOSTA aberta (com texto em digitação) através do rebuild do
  // innerHTML abaixo. Sem isso: autosaveApprovalState()/autosaveCampaignApprovalState()
  // chamam esta função ~600ms depois de QUALQUER ação de aprovação (ex: clicar "Verify" num
  // comentário) — mesmo vindo da MESMA pessoa que, nesse meio-tempo, abriu a caixa de
  // resposta de OUTRO comentário e começou a digitar. O rebuild reseta toda caixa de resposta
  // pro estado inicial (display:none, textarea vazio), apagando silenciosamente o texto ainda
  // não enviado. Achado real de QA de concorrência.
  let openReplyBox = null;
  list.querySelectorAll('.av-reply-input-box').forEach(box => {
    if(box.style.display === 'flex') {
      openReplyBox = { id: box.id, text: box.querySelector('textarea')?.value || '' };
    }
  });

  if(_avMode === 'locale') {
    // AGREGA os comentários de TODOS os frames (itens deste locale), filtrados ao _avLocale.
    // Cada card é renderizado com S apontando pro item DONO do comentário, pra que
    // renderApprovalThreadCard leia o approvalDoneByLang certo. O map _cardFrameKey guarda
    // qual frame é dono de cada comentário-topo (usado só pra ativar antes de renderizar).
    const frames = _avFrames.length ? _avFrames : avBuildFrames();
    const all = [];
    const frameKeyByCommentId = {};
    frames.forEach(f => {
      const arr = (f.item && f.item.approvalComments) || [];
      arr.forEach(c => { if(c.lang === _avLocale) { all.push(c); frameKeyByCommentId[c.id] = f.key; } });
    });
    const topLevel = all.filter(c => !c.parentId).sort((a, b) => b.createdAt - a.createdAt);
    const repliesByParent = new Map();
    all.forEach(r => {
      if(!r.parentId) return;
      if(!repliesByParent.has(r.parentId)) repliesByParent.set(r.parentId, []);
      repliesByParent.get(r.parentId).push(r);
    });
    if(countEl) countEl.textContent = all.length ? String(all.length) : '';
    list.innerHTML = topLevel.length
      ? topLevel.map(c => {
          const f = _avFramesByKey[frameKeyByCommentId[c.id]];
          if(f) avActivateFrame(f); // S vira o item dono ANTES de renderizar (isLangApproved etc.)
          return renderApprovalThreadCard(c, repliesByParent.get(c.id) || []);
        }).join('')
      : `<div class="empty-state" style="margin:6px;padding:24px 16px;"><p>No comments yet. Select any text in a preview to leave one.</p></div>`;
    renderApprovalDoneBanner();
    if(openReplyBox) {
      const restored = document.getElementById(openReplyBox.id);
      if(restored) {
        restored.style.display = 'flex';
        const ta = restored.querySelector('textarea');
        if(ta) { ta.value = openReplyBox.text; ta.focus({preventScroll:true}); }
      }
    }
    return;
  }

  const all = S.approvalComments;
  const topLevel = all.filter(c => !c.parentId).sort((a, b) => b.createdAt - a.createdAt);
  // Agrupa as respostas por parentId numa única passada por `all` — antes, renderApprovalThreadCard
  // fazia um all.filter() (varredura completa de TODOS os comentários) pra CADA comentário de
  // topo, um O(topLevel × all) que cresce em dobro com o total de comentários acumulados no
  // projeto. Mesmo resultado (mesmo agrupamento, mesma ordenação por createdAt logo abaixo),
  // só monta o agrupamento uma vez em vez de refazer a varredura por card.
  const repliesByParent = new Map();
  all.forEach(r => {
    if(!r.parentId) return;
    if(!repliesByParent.has(r.parentId)) repliesByParent.set(r.parentId, []);
    repliesByParent.get(r.parentId).push(r);
  });
  if(countEl) countEl.textContent = all.length ? String(all.length) : '';
  list.innerHTML = topLevel.length
    ? topLevel.map(c => renderApprovalThreadCard(c, repliesByParent.get(c.id) || [])).join('')
    : `<div class="empty-state" style="margin:6px;padding:24px 16px;"><p>No comments yet. Select any text in a preview to leave one.</p></div>`;
  renderApprovalDoneBanner();

  if(openReplyBox) {
    const restored = document.getElementById(openReplyBox.id);
    if(restored) {
      restored.style.display = 'flex';
      const ta = restored.querySelector('textarea');
      if(ta) { ta.value = openReplyBox.text; ta.focus({preventScroll:true}); }
    }
  }
}

// `replies` chega pré-agrupado por parentId (ver repliesByParent em renderApprovalSidebar) —
// só falta ordenar (mesmo critério de sempre: mais antiga primeiro).
function renderApprovalThreadCard(c, replies) {
  const me = authCurrentUser();
  const isAuthor = !!(me && c.author.toLowerCase() === me.email.toLowerCase());
  const isOwner = isCurrentProjectOwner();
  const resolved = c.resolvedBy && c.resolvedBy.length > 0;
  const iVerified = !!(me && c.resolvedBy.includes(me.email.toLowerCase()));
  replies = replies.slice().sort((a, b) => a.createdAt - b.createdAt);
  const verifyBtn = !isAuthor
    ? `<button class="av-verify-btn ${iVerified ? 'checked' : ''}" onclick="event.stopPropagation();toggleApprovalVerify('${c.id}')">✓ ${iVerified ? 'Verified' : 'Verify'}</button>`
    : '';
  const verifiedLine = resolved ? `<div class="av-verified-line">✓ Verified by ${c.resolvedBy.map(authorName).join(', ')}</div>` : '';
  const quoteHtml = c.quote ? `<div class="av-comment-quote">${String(c.quote).replace(/</g, '&lt;')}</div>` : '';
  const editBtn = (c.rowId && isOwner) ? `<button class="av-edit-btn" onclick="event.stopPropagation();openAvEditModal('${c.rowId}','${c.lang}')">✎ Edit text</button>` : '';
  // Só pode apagar o comentário-raiz quando a thread não tem mais nenhuma resposta —
  // apagar com respostas dependuradas deixaria elas órfãs, sem contexto.
  const deleteBtn = (isAuthor || isOwner) && replies.length === 0
    ? `<button class="av-delete-btn" title="Delete comment" onclick="event.stopPropagation();deleteApprovalComment('${c.id}')">🗑</button>`
    : '';
  return `
    <div class="av-thread-card ${resolved ? 'resolved' : ''}" id="avSideItem-${c.id}" onclick="highlightApprovalComment('${c.id}')">
      <div class="av-comment-top">
        <span class="av-comment-lang">${toBrazeLang(c.lang)}</span>
        <span class="av-comment-author">${authorName(c.author)}</span>
        <span class="av-comment-time">${new Date(c.createdAt).toLocaleString('en-US')}</span>
        ${deleteBtn}
      </div>
      ${quoteHtml}
      <div class="av-comment-text">${formatCommentText(c.text)}</div>
      <div class="av-comment-actions">
        ${!isLangApproved(S.approvalDoneByLang, c.lang) ? `<button class="av-reply-btn" onclick="event.stopPropagation();toggleApprovalReplyBox('${c.id}')">Reply</button>` : ''}
        ${editBtn}
        ${verifyBtn}
      </div>
      ${verifiedLine}
      ${replies.map(r => renderApprovalReplyCard(r)).join('')}
      ${!isLangApproved(S.approvalDoneByLang, c.lang) ? `
      <div id="avReplyBox-${c.id}" class="av-reply-input-box" style="display:none;" onclick="event.stopPropagation()">
        <textarea placeholder="Reply… type @ to mention someone" oninput="handleMentionInput(event)" onkeydown="handleMentionKeydown(event)"></textarea>
        <button class="btn-go" style="padding:6px 10px;font-size:11px;" onclick="event.stopPropagation();postApprovalReply('${c.id}', this)">Send</button>
      </div>` : ''}
    </div>
  `;
}

function renderApprovalReplyCard(r) {
  const me = authCurrentUser();
  const isAuthor = !!(me && r.author.toLowerCase() === me.email.toLowerCase());
  const isOwner = isCurrentProjectOwner();
  const resolved = r.resolvedBy && r.resolvedBy.length > 0;
  const iVerified = !!(me && r.resolvedBy.includes(me.email.toLowerCase()));
  const verifyBtn = !isAuthor
    ? `<button class="av-verify-btn ${iVerified ? 'checked' : ''}" onclick="event.stopPropagation();toggleApprovalVerify('${r.id}')">✓ ${iVerified ? 'Verified' : 'Verify'}</button>`
    : '';
  // Respostas nunca deixam nada órfão — sempre podem ser apagadas pelo autor ou pelo dono.
  const deleteBtn = (isAuthor || isOwner)
    ? `<button class="av-delete-btn" title="Delete reply" onclick="event.stopPropagation();deleteApprovalComment('${r.id}')">🗑</button>`
    : '';
  return `
    <div class="av-reply-card" onclick="event.stopPropagation()">
      <div class="av-comment-top">
        <span class="av-comment-author">${authorName(r.author)}</span>
        <span class="av-comment-time">${new Date(r.createdAt).toLocaleString('en-US')}</span>
        ${deleteBtn}
      </div>
      <div class="av-comment-text">${formatCommentText(r.text)}</div>
      <div class="av-comment-actions">${verifyBtn}</div>
      ${resolved ? `<div class="av-verified-line">✓ Verified by ${r.resolvedBy.map(authorName).join(', ')}</div>` : ''}
    </div>
  `;
}

// Apaga um comentário/resposta. Uma resposta pode sempre ser apagada (não deixa nada
// órfão); um comentário-raiz só pode ser apagado quando a thread já não tem mais
// nenhuma resposta — senão as respostas ficariam sem o comentário original pra dar contexto.
async function deleteApprovalComment(id) {
  const of = avFrameOwningComment(id); if(of) avActivateFrame(of); // locale: S vira o item dono
  const c = S.approvalComments.find(x => x.id === id);
  if(!c) return;
  const me = authCurrentUser();
  if(!me) return;
  const isAuthor = c.author.toLowerCase() === me.email.toLowerCase();
  if(!isAuthor && !isCurrentProjectOwner()) return;
  const isTopLevel = !c.parentId;
  if(isTopLevel && S.approvalComments.some(x => x.parentId === id)) return; // ainda tem respostas
  if(!(await uiConfirm('Delete this comment? This cannot be undone.', {title:'Delete comment', okLabel:'Delete', danger:true}))) return;
  const of2 = avFrameOwningComment(id); if(of2) avActivateFrame(of2); // await pode ter trocado o S ativo
  S.approvalComments = S.approvalComments.filter(x => x.id !== id);
  S.approvalDeletedIds.push(id); // tombstone — sem isso o merge com outra aba ressuscitaria o comentário
  avCommitIfLocale();
  if(isTopLevel && of2) renderApprovalPins(of2);
  else if(isTopLevel && _avMode === 'single') renderApprovalPins(_avFramesByKey[cssSafeLang(c.lang)] || { key: cssSafeLang(c.lang), lang: c.lang, itemIndex: -1 });
  renderApprovalSidebar();
  scheduleApprovalAutosave();
}

function toggleApprovalReplyBox(id) {
  const of = avFrameOwningComment(id); if(of) avActivateFrame(of); // locale: S vira o item dono
  const c = S.approvalComments.find(x => x.id === id);
  if(c && isLangApproved(S.approvalDoneByLang, c.lang)) return; // comentários ficam travados enquanto ESSE idioma estiver aprovado
  document.querySelectorAll('.av-reply-input-box').forEach(b => { if(b.id !== 'avReplyBox-' + id) b.style.display = 'none'; });
  const box = document.getElementById('avReplyBox-' + id);
  if(!box) return;
  const open = box.style.display === 'flex';
  box.style.display = open ? 'none' : 'flex';
  // preventScroll — ver comentário em openNewPinBox (mesmo #avCanvasViewport com overflow:
  // hidden + pan via transform, mesmo risco do foco puxar um scroll nativo indesejado).
  if(!open) setTimeout(() => box.querySelector('textarea')?.focus({preventScroll:true}), 0);
}

function postApprovalReply(parentId, btn) {
  if(approvalBlockedByEdit()) { warnApprovalBlockedByEdit(); return; }
  const of = avFrameOwningComment(parentId); if(of) avActivateFrame(of); // locale: S vira o item dono
  const box = btn.closest('.av-reply-input-box');
  const ta = box ? box.querySelector('textarea') : null;
  const text = ta ? ta.value.trim() : '';
  if(!text) return;
  const parent = S.approvalComments.find(c => c.id === parentId);
  if(!parent || isLangApproved(S.approvalDoneByLang, parent.lang)) return;
  if(!addApprovalComment(parent.lang, null, null, text, parentId)) return;
  avCommitIfLocale();
  renderApprovalSidebar();
}

function toggleApprovalVerify(id) {
  const me = authCurrentUser();
  if(!me) return;
  if(approvalBlockedByEdit()) { warnApprovalBlockedByEdit(); return; }
  const of = avFrameOwningComment(id); if(of) avActivateFrame(of); // locale: S vira o item dono
  const c = S.approvalComments.find(x => x.id === id);
  if(!c || c.author.toLowerCase() === me.email.toLowerCase()) return;
  const email = me.email.toLowerCase();
  const idx = c.resolvedBy.indexOf(email);
  idx === -1 ? c.resolvedBy.push(email) : c.resolvedBy.splice(idx, 1);
  avCommitIfLocale();
  if(!c.parentId) renderApprovalPins(of || _avFramesByKey[cssSafeLang(c.lang)] || { key: cssSafeLang(c.lang), lang: c.lang, itemIndex: -1 });
  renderApprovalSidebar();
  scheduleApprovalAutosave();
}

// Clicar num pin ou num item do painel lateral: dá zoom/pan até o frame do pin, faz um "pulse"
// nele, e destaca o item correspondente na lista — a mesma navegação de um arquivo do Figma.
function highlightApprovalComment(id) {
  const of = avFrameOwningComment(id); if(of) avActivateFrame(of); // locale: S vira o item dono
  const c = S.approvalComments.find(x => x.id === id);
  if(!c) return;
  const topId = c.parentId || c.id; // uma resposta aponta pro pin do comentário pai
  const top = S.approvalComments.find(x => x.id === topId);
  if(top) {
    // No modo locale o vp é o do frame dono (of); no single, key === cssSafeLang(lang).
    const vpKey = of ? of.key : cssSafeLang(top.lang);
    const vp = document.getElementById('avVp-' + vpKey);
    const canvasFrame = vp ? vp.closest('.av-canvas-frame') : null;
    if(vp && canvasFrame) {
      // Centraliza o pin na viewport, em coordenadas de tela: pega onde o pin cai na tela
      // (getBoundingClientRect já é tela-final, mesmo com o canvas pai escalado/deslocado)
      // e recentra o pan pra levá-lo ao meio.
      const rect = vp.getBoundingClientRect();
      const pinScreenX = rect.left + (rect.width * top.xPct / 100);
      const pinScreenY = rect.top + (rect.height * top.yPct / 100);
      const viewportEl = document.getElementById('avCanvasViewport');
      const vpRect = viewportEl.getBoundingClientRect();
      _avView.tx += (vpRect.left + vpRect.width / 2) - pinScreenX;
      _avView.ty += (vpRect.top + vpRect.height / 2) - pinScreenY;
      applyAvTransform();
      const topLevel = S.approvalComments.filter(x => x.lang === top.lang && !x.parentId);
      const idx = topLevel.findIndex(x => x.id === top.id);
      const pinEl = vp.querySelectorAll('.av-pin')[idx];
      if(pinEl) { pinEl.classList.add('hl'); setTimeout(() => pinEl.classList.remove('hl'), 1600); }
    }
  }
  document.querySelectorAll('.av-thread-card').forEach(el => el.style.outline = '');
  const item = document.getElementById('avSideItem-' + topId);
  if(item) { item.style.outline = '2px solid #3b82f6'; item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

// Resumo agregado no topo da sidebar: quantos idiomas já foram aprovados, do total.
function renderApprovalDoneBanner() {
  const el = document.getElementById('avDoneBanner');
  if(!el) return;
  let total, approved, noun;
  if(_avMode === 'locale') {
    // Agrega sobre os frames (itens deste locale): cada item aprovado pro _avLocale conta.
    const frames = _avFrames.length ? _avFrames : avBuildFrames();
    total = frames.length;
    approved = frames.filter(f => isLangApproved((f.item && f.item.approvalDoneByLang) || {}, _avLocale)).length;
    noun = 'asset';
  } else {
    const { langs } = approvalLangs();
    total = langs.length;
    approved = langs.filter(l => isLangApproved(S.approvalDoneByLang, l)).length;
    noun = 'language';
  }
  if(!approved) { el.innerHTML = ''; return; }
  const allDone = approved === total;
  el.innerHTML = `<div class="av-done-banner">✓ ${approved} of ${total} ${noun}${total===1?'':'s'} approved${allDone ? ' — all done!' : ''}</div>`;
}

// Registra um evento no feed de atividade da sidebar (quem aprovou, quem desfez, quem editou).
function logApprovalActivity(type, lang, rowId) {
  const me = authCurrentUser();
  if(!me) return;
  S.approvalActivity.unshift({
    id: 'aa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    type, lang, rowId: rowId || null,
    by: me.email, at: Date.now()
  });
}

// Aprova UM idioma específico — não afeta os outros frames. Uma vez aprovado, novos
// comentários/respostas naquele idioma ficam bloqueados até alguém desfazer.
// Resolve um frame a partir de uma KEY vinda de um onclick. No single, key === cssSafeLang(lang),
// então callers antigos (que passavam a própria key/lang) continuam funcionando. Fallback
// defensivo: trata a key como um cssSafeLang e acha o frame cujo lang casa.
function avResolveFrameKey(key) {
  let f = _avFramesByKey[key];
  if(!f) f = avBuildFrames().find(x => cssSafeLang(x.lang) === key) || _avFramesByKey[key];
  return f || { key, lang: key, itemIndex: -1, isOrig: false };
}

function markLangApproved(key) {
  const me = authCurrentUser();
  if(!me) return;
  const f = avResolveFrameKey(key);
  avActivateFrame(f);
  const lang = f.lang;
  if(approvalBlockedByEdit()) { warnApprovalBlockedByEdit(); return; }
  const p = projGetAll().find(x => x.id === currentProjectId);
  const projectName = (p && p.name) || S.csv.name || 'this project';
  S.approvalDoneByLang[lang] = { by: me.email, at: Date.now() };
  logApprovalActivity('approved', lang, null);
  avCommitIfLocale();
  renderFrameApproveSlot(f);
  renderApprovalActivityFeed();
  renderApprovalSidebar(); // já chama renderApprovalDoneBanner() internamente no fim
  if(_avMode === 'locale') renderApprovalPins(f);
  closeNewPinBox();
  scheduleApprovalAutosave();
  if(p && p.owner && p.owner.toLowerCase() !== me.email.toLowerCase()) {
    notifAdd(p.owner, me.email, `${me.email} approved ${langDisplayName(lang)} on "${projectName}".`, { projectId: currentProjectId });
  }
}

// "Undo" — reabre a possibilidade de comentar NAQUELE idioma, caso alguém perceba que
// precisa ajustar algo depois de já ter aprovado.
function undoLangApproval(key) {
  const me = authCurrentUser();
  if(!me) return;
  const f = avResolveFrameKey(key);
  avActivateFrame(f);
  const lang = f.lang;
  if(approvalBlockedByEdit()) { warnApprovalBlockedByEdit(); return; }
  const p = projGetAll().find(x => x.id === currentProjectId);
  const projectName = (p && p.name) || S.csv.name || 'this project';
  // NÃO usa delete aqui — ver comentário em isLangApproved. Apagar a chave faria o merge
  // concorrente (mergeApprovalState) ressuscitar esta aprovação no autosave seguinte, porque
  // uma chave ausente é indistinguível de "nunca aprovado".
  S.approvalDoneByLang[lang] = { by: me.email, at: Date.now(), undone: true };
  logApprovalActivity('undone', lang, null);
  avCommitIfLocale();
  renderFrameApproveSlot(f);
  renderApprovalActivityFeed();
  renderApprovalSidebar(); // já chama renderApprovalDoneBanner() internamente no fim
  scheduleApprovalAutosave();
  if(p && p.owner && p.owner.toLowerCase() !== me.email.toLowerCase()) {
    notifAdd(p.owner, me.email, `${me.email} undid the approval on ${langDisplayName(lang)} on "${projectName}" — it needs another look.`, { projectId: currentProjectId });
  }
}

// Feed de atividade no topo da sidebar: "Fulano approved en-US", "Ciclana edited row id5 (es-ES)"...
function renderApprovalActivityFeed() {
  const el = document.getElementById('avActivityList');
  if(!el) return;
  if(!S.approvalActivity.length) { el.innerHTML = ''; return; }
  el.innerHTML = S.approvalActivity.slice(0, 25).map(a => {
    let text;
    if(a.type === 'approved') text = `<strong>${authorName(a.by)}</strong> approved ${langDisplayName(a.lang)}`;
    else if(a.type === 'undone') text = `<strong>${authorName(a.by)}</strong> undid the approval on ${langDisplayName(a.lang)}`;
    else if(a.type === 'edited') text = `<strong>${authorName(a.by)}</strong> edited row ${a.rowId || '?'} (${langDisplayName(a.lang)})`;
    else if(a.type === 'manual_html_edit') text = `<strong>${authorName(a.by)}</strong> manually edited the tagged HTML (approval unchanged)`;
    else if(a.type === 'manual_html_edit_reverted') text = `<strong>${authorName(a.by)}</strong> reverted a manual HTML edit`;
    else text = `<strong>${authorName(a.by)}</strong> did something`;
    return `<div class="av-activity-item">
      <span class="av-activity-icon ${a.type}">${a.type === 'edited' || a.type === 'manual_html_edit' ? '✎' : a.type === 'undone' || a.type === 'manual_html_edit_reverted' ? '↺' : '✓'}</span>
      <span class="av-activity-text">${text}</span>
      <span class="av-activity-time">${relativeTime(a.at)}</span>
    </div>`;
  }).join('');
}

/* ── Edit translation directly from the Approval View ──
   Lets an approver fix a copy right where they spotted the issue, instead of having to
   close the preview and hunt for the row in the CSV editor table. */
let _avEditTarget = null; // { rowId, lang, isOrig }

function openAvEditModal(rowId, lang) {
  if(!isCurrentProjectOwner()) return; // só o dono do projeto edita o texto — approvers só comentam
  const row = S.csv.rows.find(r => r.id === rowId);
  if(!row) return;
  const origLang = S.allC.find(c => c.code === S.origin)?.lang;
  const isOrig = lang === origLang;
  _avEditTarget = { rowId, lang, isOrig };
  const meta = document.getElementById('avEditModalMeta');
  if(meta) meta.textContent = `${langDisplayName(lang)}${isOrig ? ' — origin' : ''} · row ${row.id}`;
  const ta = document.getElementById('avEditModalText');
  // Se ainda não existe tradução pra esse idioma, começa com o texto de origem como
  // ponto de partida — a pessoa só ajusta o que precisa, em vez de partir de um campo vazio.
  if(ta) ta.value = currentRowText(rowId, lang);
  const modal = document.getElementById('avEditModal');
  if(modal) modal.style.display = 'flex';
  setTimeout(() => ta?.focus(), 0);
}

function closeAvEditModal() {
  const modal = document.getElementById('avEditModal');
  if(modal) modal.style.display = 'none';
  _avEditTarget = null;
}

function saveAvEditModal() {
  if(!_avEditTarget || !isCurrentProjectOwner()) { closeAvEditModal(); return; }
  const { rowId, lang, isOrig } = _avEditTarget;
  const row = S.csv.rows.find(r => r.id === rowId);
  const val = document.getElementById('avEditModalText')?.value ?? '';
  closeAvEditModal();
  closeNewPinBox();
  if(!row) return;
  if(isOrig) row.src = val; else row.translations[lang] = val;
  logApprovalActivity('edited', lang, rowId);
  renderApprovalActivityFeed();
  buildTable();           // mantém a tabela do editor sincronizada, mesmo estando por trás da Approval View
  // Recarrega o preview desse frame já com o texto novo. No single, key === cssSafeLang(lang);
  // no locale, edição de texto é owner-only e opera no item já ativo em S.
  const editFrame = _avFramesByKey[cssSafeLang(lang)] || avBuildFrames().find(x => x.lang === lang) || { key: cssSafeLang(lang), lang, type: (_campaignInappPreview?'inapp':_campaignPushPreview?'push':'email'), itemIndex: -1 };
  loadApprovalFrame(editFrame);
  scheduleAutosave();
}
