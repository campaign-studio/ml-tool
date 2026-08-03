/* ═════════════════════════════════════════════════════════════════════════════════
 * modules/translation-engine.js — O MOTOR DE TRADUÇÃO: tagging + preview + CSV. Contém o
 * parsing/serialização de CSV (Braze), a normalização/ordenação de idiomas, o diff/merge de
 * linhas, o manuseio de Liquid (strip/split/placeholder/condicionais) e a montagem do HTML de
 * preview e do HTML "tagged". É o motor compartilhado por loose + campanhas (email/in-app/push).
 *
 * SEPARADO do index.html só pra ORGANIZAÇÃO — NÃO é um módulo isolado com IIFE nem ES module: é
 * código de escopo global (classic script), igual ao que era quando morava no <script> inline. As
 * funções e consts continuam GLOBAIS (chamadas por bare-name e por onclick= no HTML), e leem os
 * outros globais do app (S, COUNTRIES, escHtml, escJsAttr, etc.) também por bare-name — o que
 * funciona porque classic scripts compartilham o mesmo ambiente léxico/global. Carregado DEPOIS do
 * inline (as referências só acontecem em runtime).
 * ═════════════════════════════════════════════════════════════════════════════════ */

// ── Merge de PROJETO AVULSO (conteúdo do CSV) — a mesma garantia das pastas, agora pros soltos ──
// Junta o CSV de duas versões do MESMO projeto avulso célula a célula (linha × idioma):
//  - união de LINHAS por id (linha nova de uma aba nunca é derrubada pela outra);
//  - por célula: preenchido vence vazio; conflito real (os dois preencheram) → versão do projeto de
//    updatedAt mais novo.
// GUARDA ESTRITA: se QUALQUER célula que era preenchida em algum lado ficaria VAZIA no resultado,
// devolve null e o chamador cai no comportamento atual (projeto inteiro por updatedAt). Ou seja,
// este merge só PODE preservar dado — nunca corromper nem perder.
function _rowsFromSaveCsv(csvStr) {
  const parsed = parseBrazeCsv(csvStr);
  if(!parsed || !parsed.langs || !parsed.langs.length) return null;
  const rowsById = new Map(), order = [];
  parsed.langs.forEach(lang => (parsed.byLang[lang] || []).forEach(r => {
    if(!rowsById.has(r.id)) { rowsById.set(r.id, { id: r.id, src: r.src || '', tls: {} }); order.push(r.id); }
    rowsById.get(r.id).tls[lang] = r.tl || '';
  }));
  return { name: parsed.templateName || '', langs: parsed.langs.slice(), rowsById, order };
}

// Reconstrói a string no MESMO formato de buildCsvStringForSave (valores já vêm transformados do
// parse — não re-aplica csvSourceText/curlify, senão duplicaria a transformação).
function _buildSaveCsvFrom(name, langsInternal, rowsById, order) {
  const langs = sortLangsForDisplay(langsInternal);
  if(!langs.length) return '';
  const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [
    esc(name) + ',' + langs.map(() => '').join(','),
    ',' + esc('Translation tags') + ',' + langs.map(l => toBrazeLang(l)).join(','),
    ...order.map(id => { const r = rowsById.get(id); return id + ',' + esc(r.src) + ',' + langs.map(l => esc(r.tls[l] || '')).join(','); })
  ];
  return '﻿' + lines.join('\n');
}

function mergeLooseData(a, b) {
  try {
    const ad = a.data, bd = b.data;
    if(!ad || !bd || !ad.csv || !bd.csv) return null;
    if(ad.csv === bd.csv) return null; // idêntico → nada a fundir (deixa o caminho normal seguir)
    const A = _rowsFromSaveCsv(ad.csv), B = _rowsFromSaveCsv(bd.csv);
    if(!A || !B) return null;
    const aNewer = (a.updatedAt || 0) >= (b.updatedAt || 0);
    const newer = aNewer ? A : B, older = aNewer ? B : A;
    const langs = [...new Set([...A.langs, ...B.langs])];
    const order = [...newer.order];
    older.order.forEach(id => { if(!newer.rowsById.has(id)) order.push(id); });
    const rowsById = new Map();
    order.forEach(id => {
      const na = newer.rowsById.get(id), ol = older.rowsById.get(id);
      const src = (na && na.src) || (ol && ol.src) || '';
      const tls = {};
      langs.forEach(l => {
        const nv = na ? (na.tls[l] || '') : '', ov = ol ? (ol.tls[l] || '') : '';
        tls[l] = nv.trim() ? nv : (ov.trim() ? ov : (nv || ov || '')); // preenchido vence vazio; conflito → novo
      });
      rowsById.set(id, { id, src, tls });
    });
    const mergedCsv = _buildSaveCsvFrom(aNewer ? A.name : B.name, langs, rowsById, order);
    // GUARDA: nenhuma célula preenchida em A OU B pode ficar vazia no resultado.
    const M = _rowsFromSaveCsv(mergedCsv);
    if(!M) return null;
    const noLoss = side => [...side.rowsById.keys()].every(id =>
      side.langs.every(l => {
        const v = (side.rowsById.get(id).tls[l] || '');
        if(!v.trim()) return true;
        const mr = M.rowsById.get(id);
        return mr && (mr.tls[l] || '').trim().length > 0;
      }));
    if(!noLoss(A) || !noLoss(B)) return null;
    const base = aNewer ? ad : bd;
    return {
      ...base,
      csv: mergedCsv,
      langs: sortLangsForDisplay(langs),
      html: aNewer ? ad.html : bd.html,
      comments: { ...(bd.comments || {}), ...(ad.comments || {}) },
      maxIdIssued: Math.max(ad.maxIdIssued || 0, bd.maxIdIssued || 0),
    };
  } catch(e) { console.warn('mergeLooseData → fallback (comportamento atual):', e); return null; }
}

// LCS de dois arrays de linhas → pares [i,j] casados (subsequência comum, crescente).
function _lcsLinePairs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for(let i = n - 1; i >= 0; i--) for(let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = []; let i = 0, j = 0;
  while(i < n && j < m) {
    if(a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if(dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

// Merge 3-vias por LINHA (base = versão de quando abri o editor; mine = minha edição; theirs = o
// que está no banco agora). Junta edições em regiões DIFERENTES automaticamente; se os dois
// mexeram na MESMA região de formas diferentes, devolve { clean:false } (o chamador cai no prompt
// de "sobrescrever?"). NUNCA inventa conteúdo — só recombina linhas existentes. Conservador de
// propósito: âncoras = linhas iguais nos TRÊS, então na dúvida gera conflito (seguro) em vez de
// um merge duvidoso.
function diff3MergeLines(baseStr, mineStr, theirsStr) {
  const base = baseStr.split('\n'), mine = mineStr.split('\n'), theirs = theirsStr.split('\n');
  if(Math.max(base.length, mine.length, theirs.length) > 6000) return { clean: false, text: null }; // guarda contra caso patológico
  const theirsOf = new Map(_lcsLinePairs(base, theirs).map(([bi, ti]) => [bi, ti]));
  const anchors = [];
  for(const [bi, mi] of _lcsLinePairs(base, mine)) if(theirsOf.has(bi)) anchors.push([bi, mi, theirsOf.get(bi)]);
  const out = [];
  const eq = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
  let pb = -1, pm = -1, pt = -1, conflict = false;
  const emit = (bs, be, ms, me, ts, te) => {
    const bR = base.slice(bs, be), mR = mine.slice(ms, me), tR = theirs.slice(ts, te);
    if(eq(mR, bR)) out.push(...tR);        // eu não mexi aqui → fica a versão do outro
    else if(eq(tR, bR)) out.push(...mR);   // o outro não mexeu aqui → fica a minha
    else if(eq(mR, tR)) out.push(...mR);   // os dois fizeram a MESMA mudança
    else conflict = true;                  // conflito real
  };
  for(const [bi, mi, ti] of anchors) {
    emit(pb + 1, bi, pm + 1, mi, pt + 1, ti);
    if(conflict) return { clean: false, text: null };
    out.push(base[bi]); // linha-âncora (igual nos três)
    pb = bi; pm = mi; pt = ti;
  }
  emit(pb + 1, base.length, pm + 1, mine.length, pt + 1, theirs.length);
  if(conflict) return { clean: false, text: null };
  return { clean: true, text: out.join('\n') };
}

// Find or create a country entry for a given lang code.
// Tries: exact match → prefix match (es-ES → es) → create new entry.
// Known lang code aliases — maps non-standard or variant codes to canonical ones.
const LANG_ALIASES = {
  'en-UK': 'en-GB',  // en-UK is not an ISO code — GB is correct
  'en-uk': 'en-GB',
  'EN-UK': 'en-GB',
  // Retrocompatibilidade: CSVs antigos usavam lang sem sufixo de país.
  // Mapeia pro equivalente mais common de cada idioma.
  'de':    'de-DE',
  'fr':    'fr-FR',
  'es':    'es-ES',
  'it':    'it-IT',
  'nl':    'nl-NL',
  'pl':    'pl-PL',
  'tr':    'tr-TR',
  'en':    'en-US',
  'ro':    'ro-RO',
};

// Expand a lang code: returns array of canonical lang codes.
function expandLang(lang) {
  const iso = fromBrazeLang(lang);        // de_de → de-DE
  const norm = LANG_ALIASES[iso] || LANG_ALIASES[lang] || iso;
  return LANG_EXPAND[norm] || LANG_EXPAND[lang] || [norm];
}

// Quebra o texto do CSV em "linhas" respeitando aspas \u2014 um campo entre aspas pode ter uma
// quebra de linha literal dentro (comum quando o CSV passa por Excel/Sheets, ex: uma merge
// tag Liquid sozinha na pr\u00F3pria linha do par\u00E1grafo). Um split ing\u00EAnuo por '\n' cortava esse
// campo no meio, perdendo o conte\u00FAdo real e deixando a linha "vazia" no CSV.
function splitCsvRecords(text) {
  const records = [];
  let cur = '', q = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(c === '"'){
      if(q && text[i+1] === '"'){ cur += '""'; i++; }
      else { q = !q; cur += c; }
    } else if(c === '\n' && !q){
      records.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if(cur) records.push(cur);
  return records;
}

function parseBrazeCsv(text) {
  // Detect separator: semicolon (multi-lang export) or comma (single-lang export)
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u2028/g, ' ').replace(/\u2029/g, ' ');
  const lines = splitCsvRecords(clean).map(l => l.trimEnd()).filter(Boolean);
  if(lines.length < 2) return null;

  // Detect separator from first data row (line 2), not header.
  // Header line 1 starts with ',' for CSV or ';' for semicolon — unreliable.
  // Conta os separadores SÓ FORA de aspas — entidades HTML (&amp; &nbsp; &lt; &gt;) terminam em
  // ";" e vivem DENTRO das células (campos entre aspas). Contar ";" cru fazia um CSV nosso (sempre
  // vírgula, campos aspados) com ~3 entidades na 1ª linha virar "modo semicolon" por engano — o
  // parser então dividia tudo pelo ";", não reconhecia os idiomas e devolvia 0 langs/0 linhas,
  // PERDENDO todas as traduções na releitura. Contando só o que está fora de aspas, entidade não
  // conta como separador. (Bug achado pelo translation-fuzzer.)
  const countUnquoted = (line, ch) => {
    let n = 0, q = false;
    for(let i = 0; i < line.length; i++){
      if(line[i] === '"'){ if(q && line[i+1] === '"'){ i++; continue; } q = !q; }
      else if(line[i] === ch && !q) n++;
    }
    return n;
  };
  const sepLine = lines[2] || lines[1];
  const sep = (countUnquoted(sepLine, ';') > countUnquoted(sepLine, ',')) ? ';' : ',';

  const parseLine = line => {
    if(sep === ';') return line.split(';').map((x,i) => i===0 ? x.trim() : x);
    // Comma: respect quoted fields
    const r = []; let cell = '', q = false;
    for(let i = 0; i < line.length; i++){
      if(line[i]==='"'){ if(q && line[i+1]==='"'){cell+='"';i++;} else q=!q; }
      else if(line[i]===',' && !q){ r.push(cell); cell=''; }
      else cell += line[i];
    }
    r.push(cell);
    return r.map((x,i) => i===0 ? x.replace(/^"|"$/g,'').trim() : x.replace(/^"|"$/g,''));
  };

  const templateName = parseLine(lines[0])[0] || '';
  const headerRow    = parseLine(lines[1]);

  // Languages start at col 2: raw codes from header
  const rawLangs = headerRow.slice(2).map(l => LANG_ALIASES[l.trim()] || l.trim()).filter(Boolean);
  // Expand: es-419 → [es-MX, es-CL]. Final langs array has no es-419.
  const langs = rawLangs.flatMap(l => expandLang(l));

  // Data rows — only valid idN rows
  const dataRows = lines.slice(2)
    .map(l => parseLine(l))
    .filter(r => r[0] && /^id\d+$/i.test(r[0]));

  if(langs.length === 0){
    // Old single-lang comma format: col1 = translation
    const langFromHeader = expandLang((headerRow[2] || '').trim())[0] || '';
    const rows = dataRows.map(r => ({ id: r[0], tl: r[1] || '' }));
    return { templateName, langs: langFromHeader ? [langFromHeader] : [],
             byLang: langFromHeader ? { [langFromHeader]: rows } : {},
             langFromHeader, rows };
  }

  // Multi-lang: each rawLang maps to a column index.
  // Expanded langs (es-MX, es-CL from es-419) share the same column data.
  const byLang = {};
  rawLangs.forEach(rawLang => {
    const colIdx = headerRow.findIndex((h, i) => i >= 2 && (LANG_ALIASES[h.trim()] || h.trim()) === rawLang);
    const expanded = expandLang(rawLang);
    expanded.forEach(lang => {
      byLang[lang] = dataRows.map(r => ({
        id:  r[0],
        src: (r[1] || '').trim(), // src is used as lookup key — trim is OK
        tl:  colIdx >= 0 ? (r[colIdx] || '') : '' // tl must be verbatim
      }));
    });
  });

  return { templateName, langs, byLang };
}

// Troca apóstrofo reto (') por curly apostrophe (’, alt+0146 / U+2019) só no texto de
// verdade — qualquer trecho que bata no APOSTROPHE_PROTECT_RE fica intocado, pra não
// corromper sintaxe Liquid/HTML.
function curlifyApostrophes(str){
  if(!str) return str;
  const re = new RegExp(APOSTROPHE_PROTECT_RE.source, APOSTROPHE_PROTECT_RE.flags);
  let out = '', lastIndex = 0, m;
  while((m = re.exec(str)) !== null){
    out += str.slice(lastIndex, m.index).replace(/'/g, '’');
    out += m[0];
    lastIndex = m.index + m[0].length;
    if(m[0].length === 0) re.lastIndex++; // evita loop infinito em match vazio
  }
  out += str.slice(lastIndex).replace(/'/g, '’');
  return out;
}

// Remove todos os tokens {{ }} e {% %} do texto, devolvendo só o conteúdo textual.
function stripLiquid(str){
  let out='', i=0;
  while(i<str.length){
    if(str[i]==='{' && str[i+1]==='{'){
      const j = findLiquidMergeEnd(str, i);
      i=j+2;
    } else if(str[i]==='{' && str[i+1]==='%'){
      let j=i+2;
      while(j<str.length-1 && !(str[j]==='%' && str[j+1]==='}')) j++;
      i=j+2;
    } else {
      out+=str[i++];
    }
  }
  // Além de &nbsp;/&#160;, cobre outras entidades de espaço INVISÍVEL usadas como espaçador
  // decorativo em e-mail (hair space, thin space, zero-width space...) — sem isso, um <p>
  // que só tem um desses espaçadores (ex: "&#8202;") passava no filtro de tamanho mínimo e
  // virava uma linha "em branco" no CSV, parecendo um bug quando na verdade não tem texto
  // nenhum ali pra traduzir.
  return out
    .replace(/&nbsp;/gi,'')
    .replace(/&#160;/g,'')
    // U+2000–U+200A: espaços de largura variável do Unicode (en/em/thin/hair space etc) —
    // faixa termina em 200A (8202); 2010 em diante já são travessão/hífen, que são texto
    // VISÍVEL de verdade e não podem ser removidos aqui.
    .replace(/&#(819[2-9]|820[0-2]);/g,'')
    .replace(/&#(820[3-7]);/g,'')          // U+200B–U+200F: largura zero / marcas direcionais invisíveis
    .replace(/&#65279;/g,'')               // BOM / zero-width no-break space
    .replace(/&zwnj;/gi,'')
    .replace(/&zwj;/gi,'')
    .trim();
}

// Divide um texto em tokens do tipo 'text' e 'liquid' ({{ }} ou {% %}).
function splitLiquid(str){
  const r=[]; let i=0;
  while(i<str.length){
    if(str[i]==='{' && str[i+1]==='{'){
      const j = findLiquidMergeEnd(str, i);
      r.push({type:'liquid', val:str.slice(i,j+2)}); i=j+2;
    } else if(str[i]==='{' && str[i+1]==='%'){
      let j=i+2;
      while(j<str.length-1 && !(str[j]==='%' && str[j+1]==='}')) j++;
      r.push({type:'liquid', val:str.slice(i,j+2)}); i=j+2;
    } else {
      let j=i;
      while(j<str.length && !(str[j]==='{' && (str[j+1]==='{' || str[j+1]==='%'))) j++;
      if(j>i) r.push({type:'text', val:str.slice(i,j)});
      i=j;
    }
  }
  return r;
}

// Desembrulha <code>...</code> quando o miolo é EXCLUSIVAMENTE Liquid (merge tags, content_blocks
// ou controle {% %}), devolvendo só o conteúdo interno sem o <code>. Motivo: nesses templates
// Braze o <code> é usado só pra estilizar (monospace) um snippet de Liquid — ex:
// "Enjoy your first <code>{{context.${offer_trial_duration}}}</code> days on us." Como <code>
// está no SKIP_PAIR do tokenizador, o conteúdo dele era PULADO: a frase quebrava em duas linhas
// (id6 "Enjoy your first" / id7 "days on us.") e a merge tag SUMIA do CSV. Tirando o <code>
// (só quando ele embrulha nada além de Liquid), a frase vira UM texto contínuo — a extração
// junta tudo numa linha só, mergeLiquidInline mantém a merge tag (context.*/custom_attribute.*),
// e a tag de tradução passa a abraçar a frase inteira COM a merge tag dentro. Um <code> que
// contenha QUALQUER texto/código real (fora do escopo destes templates) é deixado intacto
// (continua sendo pulado como antes) — decisão conservadora confirmada com o usuário.
// Aplicado de forma idêntica na extração (extractStr), no tagueamento (buildTaggedHtml) e no
// preview (buildPreviewHtml) pra os três concordarem na mesma posição de texto.
function unwrapLiquidOnlyCode(html){
  if(!html || html.indexOf('<code') === -1) return html;
  return html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, inner) => {
    // Ignora tags de tradução já presentes só pra o teste de "é puro Liquid?".
    const test = inner.replace(/\{%translation\s+\S+?%\}/g,'').replace(/\{%endtranslation%\}/g,'');
    // splitLiquid entende ${...} e o }}} triplo (via findLiquidMergeEnd); puro = todo token
    // não-espaço é Liquid.
    const toks = splitLiquid(test);
    const pure = toks.every(t => t.type === 'liquid' || !/\S/.test(t.val));
    return pure ? inner : m;
  });
}

// Chamado ao clicar "Yes, build CSV" — cria (ou atualiza) o registro do
// projeto no Dashboard, com você como dono e a trava ativa.
// Gera a string CSV (mesmo formato do export) sem disparar download — usada pra salvar o projeto.
function buildCsvStringForSave() {
  const langs = sortLangsForDisplay(S.csv.langs); // ordem fixa global (não mexe em S.csv.langs)
  if(!langs.length) return '';
  const esc = v => `"${String(v||'').replace(/"/g,'""')}"`;
  const emptyCols = langs.map(()=>'').join(',');
  const lines = [
    esc(S.csv.name) + ',' + emptyCols,
    ',' + esc('Translation tags') + ',' + langs.map(l=>toBrazeLang(l)).join(','),
    ...S.csv.rows.map(r =>
      r.id + ',' + esc(curlifyApostrophes(csvSourceText(r))) + ',' + langs.map(l=>esc(curlifyApostrophes(r.translations[l]||''))).join(',')
    )
  ];
  return '\uFEFF' + lines.join('\n');
}

// Carrega o conteúdo salvo de um projeto direto no app, sem precisar reupload manual.
// Para na tela de seleção de imagens (3.5), já com as imagens que estavam marcadas.
// Detecta se o trecho na posição `pos` do HTML está DENTRO de uma forma VML (fallback de
// imagem/formas pro Outlook, ex: um botão <v:roundrect> ou <v:rect>). A VML vem em
// comentários condicionais MSO SEPARADOS: um abre a forma ANTES do texto (<!--[if mso]>
// <v:roundrect ...> ...<![endif]-->), outro fecha DEPOIS (<!--[if mso]></v:roundrect>
// <![endif]-->) — o texto fica no meio, fora dos comentários. Conta aberturas <v:...> vs
// fechamentos </v:...> antes de `pos`: se sobra abertura (estamos dentro) e existe o
// fechamento correspondente depois, devolve o nome da tag (ex: 'v:roundrect'); senão null.
function detectVmlWrap(html, pos){
  // Sinal ESTRUTURAL (robusto ao tamanho dos estilos inline): o trecho é label de um botão
  // VML se está dentro de um <a>...</a> cujo markup contém uma forma VML aberta (<v:roundrect>,
  // <v:rect>, etc.) — a VML e o <a> são o mesmo botão (VML pro Outlook, <a> pro resto). Isso
  // pega o caso do Eligible (id41/id42 num <a> com <v:roundrect> no fallback mso) sem os falsos
  // positivos de contar profundidade de <v:...> pelo documento todo.
  const before = html.slice(0, pos);
  const aOpen = before.lastIndexOf('<a ');
  if(aOpen === -1) return null;
  if(before.indexOf('</a>', aOpen) !== -1) return null; // há um </a> entre o <a> e o trecho — não estamos dentro dele
  const aCloseRel = html.slice(pos).indexOf('</a>');
  if(aCloseRel === -1) return null;
  const anchorHtml = html.slice(aOpen, pos + aCloseRel + 4);
  const m = anchorHtml.match(/<v:([a-z][a-z0-9]*)\b(?![^>]*\/>)/i); // forma VML aberta (não <v:.../>)
  return m ? 'v:' + m[1].toLowerCase() : null;
}

// Lê as tags {%translation idN%}...{%endtranslation%} de um HTML já tageado por este
// app — usado só ao REABRIR um projeto salvo (restoreProjectContent, logo abaixo). Não
// faz nenhuma validação de CSV/HTML incompatível: dados salvos pelo próprio app sempre
// batem entre si, diferente de um upload manual de arquivos que pode vir de qualquer lugar.
function parseSavedProjectHtml(html) {
  const tagRe = /\{%translation\s+(id\d+)%\}([\s\S]*?)\{%endtranslation%\}/g;
  const rows = [];
  let m;
  while((m = tagRe.exec(html)) !== null) {
    const id = m[1];
    const src = m[2];
    const trimmedSrc = src.trim();
    // Além de http(s)://, cobre protocolo-relativo (//cdn...), data URI, e caminho relativo
    // terminando em extensão de imagem — só http(s) deixava passar batido qualquer imagem
    // hospedada de outro jeito, perdendo a seleção/imgTag pra sempre ao reabrir o projeto.
    const isImg = !trimmedSrc.includes(' ') && (
      /^(?:https?:)?\/\//.test(trimmedSrc) ||
      /^data:image\//i.test(trimmedSrc) ||
      /\.(?:png|jpe?g|gif|webp|svg)(?:\?.*)?$/i.test(trimmedSrc)
    );
    let imgTag = null;
    if(isImg) {
      const srcIdx = html.indexOf(src.trim());
      if(srcIdx !== -1) {
        let s = srcIdx; while(s > 0 && html[s] !== '<') s--;
        let e = srcIdx; while(e < html.length && html[e] !== '>') e++;
        if(/^<img[\s>]/i.test(html.slice(s, s+5))) {
          imgTag = html.slice(s, e+1).replace(/\{%translation\s+id\d+%\}/g, '').replace(/\{%endtranslation%\}/g, '');
        }
      }
    }
    rows.push({ id, src, isImg, imgTag, vmlTag: detectVmlWrap(html, m.index) });
  }
  return rows;
}

// Junta texto misturado com merge tags (context/custom_attribute/etc) numa única string
// traduzível: tags de controle puro (if/elsif/else/endif/unless/endunless) somem (não são
// texto, só decidem o que aparece), content_blocks também some (catálogo/dado de negócio,
// não é pra traduzir), mas merge tags de verdade (context/custom_attribute) ficam CRUAS no
// texto — exatamente como aparecem no HTML, sem virar placeholder nem valor de "default".
// Isso é o que a pessoa vê e edita no CSV/grade; o preview visual final é que troca essas
// tags por algo legível (via replaceLiquidPlaceholders), então não precisa fazer isso aqui.
// SEM .trim() no final de propósito — o resultado vira row.text, que csvSourceText()
// usa como a coluna de origem do CSV exportado. row.src (o texto CRU, com o mesmo
// espaço nas pontas que existe de verdade no HTML) é o que buildTaggedHtml() embute
// entre {%translation id%}...{%endtranslation%}. Se aqui desse um trim() e lá não,
// a Braze via o texto da tag no HTML diferente do texto na coluna de origem do CSV
// (só por espaço a mais/a menos) e recusava o upload com "CSV is different from the
// HTML" — bug real reportado por quem usa a ferramenta. Espaço nas pontas precisa
// sobreviver aqui igual sobrevive em row.src.
function mergeLiquidInline(str) {
  return splitLiquid(str).map(tk => {
    if(tk.type !== 'liquid') return tk.val;
    if(/^\{%/.test(tk.val.trim())) return '';
    if(!isRecognizedMergeTag(tk.val)) return '';
    return tk.val;
  }).join('').replace(/\s{2,}/g, ' ');
}

// Texto de origem que vai pro CSV exportado (coluna que a pessoa vê e traduz). row.src
// precisa continuar guardando o Liquid CRU (é usado pra achar a posição exata no HTML na
// hora de tag guear/exportar), mas isso não pode vazar pro CSV que a pessoa vê — senão
// content_blocks/custom_attribute/context aparecem como tag crua no meio da frase. Linhas
// recém-extraídas (extractStr) já têm o texto limpo em row.text; linhas de um projeto
// REABERTO (restoreProjectContent) não têm esse campo, então recalcula a partir do src cru.
// Versão CRUA (pode ter espaço nas pontas) — usada só pra calcular quanto espaço mover pra
// FORA da tag de tradução (ver buildTaggedHtml). O que a pessoa vê/traduz e o que vai dentro
// da tag é a versão sem as pontas (csvSourceText, logo abaixo).
function csvSourceTextRaw(row) {
  if(row.isImg) return row.src;
  if(row.text) return row.text;
  if(row.isLiquidFull || row.isLiquidDefault) return row.src || '';
  return mergeLiquidInline(row.src||'') || row.src || '';
}

// Texto de origem "canônico": SEM espaço nas pontas. É o mesmo texto usado como conteúdo da
// tag de tradução (buildTaggedHtml) E como coluna de origem do CSV (buildCsvStringForSave) —
// os dois têm que bater exatamente (a Braze recusa se diferirem). Trimar aqui, num lugar só,
// mantém os dois em sincronia e faz a tag abraçar o texto sem espaço sobrando
// ({%translation%}Start free trial{%endtranslation%}, não {%translation%} Start free trial ).
// Imagem NÃO trima (o "texto" é a URL do src, sem pontas relevantes).
function csvSourceText(row) {
  const raw = csvSourceTextRaw(row);
  return row.isImg ? raw : raw.replace(/^\s+|\s+$/g, '');
}

// Convert Liquid variables to readable placeholders for display in editor/viewer
// {{custom_attribute.${client_name} | default: 'x'}} → {client_name}
// {{context.first_paid_plan_price}} → {first_paid_plan_price}
// {{context.offer_trial_duration}} → {trial_duration}
// Keeps the original Liquid intact in the src field for tagging/export
function toLiquidPlaceholder(text) {
  return text
    .replace(/\{\{custom_attribute\.\$\{([^}]+)\}[^}]*\}\}/g, '{$1}')
    .replace(/\{\{context\.([^|}]+?)(?:\s*\|[^}]*)?\}\}/g, '{$1}')
    .replace(/\{%[-\s]*if[^%]*?%\}/g, '')
    .replace(/\{%[-\s]*elsif[^%]*?%\}/g, '')
    .replace(/\{%[-\s]*else[-\s]*?%\}/g, '')
    .replace(/\{%[-\s]*endif[-\s]*?%\}/g, '')
    .replace(/\{%[-\s]*unless[^%]*?%\}/g, '')
    .replace(/\{%[-\s]*endunless[-\s]*?%\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractStr() {
  const SKIP_PAIR  = /^(script|style|pre|code|noscript|svg)$/i;   // have open+close
  const SKIP_VOID  = /^(meta|link|path|input|br|hr|img|area|base|col|embed|param|source|track|wbr)$/i; // self-closing
  const STYLE      = /^(strong|b|em|i|u|s|mark|small|sup|sub)$/i;
  const res=[]; let styleStack=[], skipDepth=0, msoDepth=0, anchorStack=[], colWidthStack=[];
  // Verdadeiro enquanto estamos NO MEIO de um {% ... %} que começou num token de texto anterior
  // e ainda não fechou — acontece quando uma tag HTML ou comentário no meio de uma condição
  // Liquid (ex: {% if {{a}} == 0 <!--x--> and {{b}} %}) corta a condição em dois tokens de
  // texto separados. Sem isso, o pedaço que sobra depois da interrupção (ex: "and {{b}} %}")
  // parecia texto normal e virava linha traduzível por engano, mesmo sendo só sintaxe do
  // Liquid — nunca pode ter tag de tradução dentro de um {% %}.
  let inOpenControlTag = false;
  const imgOccCount={}; // conta ocorrências por src — necessário pra dar uma chave ÚNICA
  // mesmo quando o MESMO texto de src se repete (ex: <img src="{{ partner_1_logo }}"> —
  // uma variável Liquid reatribuída via {% capture %} antes de cada seção, representando
  // logos DIFERENTES de parceiro que só por coincidência têm o mesmo texto de src).

  // {% comment %}...{% endcomment %} é o comentário do PRÓPRIO Liquid (diferente de
  // <!-- --> do HTML) — usado em templates Braze pra notas internas/documentação
  // (ex: explicando uma cascata de fallback de parceiro). Sem remover esse bloco
  // antes de tokenizar, o texto interno parecia conteúdo normal e virava linha
  // traduzível por engano, mesmo sendo só anotação pra quem mantém o template.
  const rawForExtraction = unwrapLiquidOnlyCode(
    S.rawHtml.replace(/\{%[-\s]*comment[-\s]*%\}[\s\S]*?\{%[-\s]*endcomment[-\s]*%\}/gi, ''));
  // O 2º grupo da alternativa exige uma LETRA (ou "/"/"!") logo após o "<" — sem isso, um "<"
  // qualquer virava início de tag pro tokenizador, mesmo sem ser HTML de verdade. Achado real:
  // uma condição Liquid comparando quantidade com "<3" (ex: "{{...user_family_member_count}}
  // <3 or ...") tinha o "<3" interpretado como abertura de tag — o tokenizador só fecha essa
  // "tag" no PRÓXIMO ">" que encontrar, que era o de um <style> de verdade logo depois,
  // engolindo a tag <style> inteira junto. Sem reconhecer o <style> como tag, skipDepth nunca
  // incrementava, e o CSS de dentro dele virava linha traduzível por engano (viu-se um bloco
  // de @media inteiro aparecer como "linha 10" no CSV de um projeto real).
  const tokens = rawForExtraction.split(/(<!--[\s\S]*?-->|<\/?[a-zA-Z!][^>]*>)/g);

  for(let ti=0; ti<tokens.length; ti++){
    const tok=tokens[ti];
    if(!tok) continue;
    const isTag=(ti%2===1);

    if(isTag){
      // O "%}" que fecha um {% ... %} aberto num token de TEXTO anterior às vezes cai
      // dentro do PRÓXIMO token de TAG/comentário (ex: um <!-- --> logo depois da
      // condição), não no próximo texto — sem checar aqui também, inOpenControlTag
      // nunca era limpo e ficava travado em true pro resto do documento inteiro,
      // fazendo TODA extração dali pra frente ser silenciosamente pulada (bug real:
      // reordenar a regex de comentário deslocou onde um "%}" caía e zerou a
      // extração de um projeto inteiro).
      if(inOpenControlTag){
        if(tok.includes('%}')) inOpenControlTag = false;
        continue;
      }
      // "Downlevel-revealed": <!--[if !mso]><!--> ... <!--<![endif]--> — o "<!-->" logo
      // depois do "[if !mso]" fecha o comentário NA HORA pra qualquer cliente que respeita
      // HTML de verdade, revelando o conteúdo entre esse marcador e o fechamento como
      // VISÍVEL (só o Outlook, que lê o comentário condicional de verdade, esconde). Não é
      // um bloco oculto — sem essa distinção, o conteúdo real dentro dele (ex: o botão de
      // CTA "de verdade", fora do fallback VML só-MSO) nunca virava linha traduzível.
      if(/<!--\[if\s+!mso\]>/i.test(tok)) { continue; }
      // Um <!--[if mso]>...<![endif]--> inteiro numa linha só agora vira UM token só
      // (a regex de comentário casa do "<!--" até o "-->" mais próximo, de uma vez).
      // Sem este caso, ele batia só na checagem de abertura (msoDepth++) logo abaixo e
      // nunca na de fechamento — o msoDepth ficava preso pra sempre em vez de voltar a
      // 0, escondendo o resto do documento inteiro da extração (bug real encontrado:
      // projeto inteiro lido como 0 strings/0 imagens depois de um único <!--[if mso]>
      // auto-contido). Abre-e-fecha no mesmo token = efeito líquido zero no depth.
      if(/<!--\[if/i.test(tok) && /<!\[endif\]/i.test(tok)) { continue; }
      if(/<!--\[if/i.test(tok))   { msoDepth++; continue; }
      if(/<!\[endif\]/i.test(tok)){ msoDepth=Math.max(0,msoDepth-1); continue; }
      if(/^<!--/.test(tok)) continue;
      if(msoDepth>0) continue;

      const nameM=tok.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
      if(!nameM) continue;
      const tagName=nameM[1], isClose=tok[1]==='/', isSelfClose=tok.endsWith('/>');

      // Rastreia em qual <a href="..."> estamos — usado abaixo pra reconhecer um
      // ícone/botão de CTA (imagem pequena dentro de um link Liquid puro) e não
      // tratá-lo como linha traduzível.
      if(/^a$/i.test(tagName)){
        if(!isClose && !isSelfClose){
          const hrefM = tok.match(/\bhref=(?:"([^"]*)"|'([^']*)')/i);
          anchorStack.push({ href: (hrefM ? (hrefM[1]||hrefM[2]||'') : '').trim() });
        } else if(isClose){
          anchorStack.pop();
        }
        // sem "continue" — o texto/tags dentro do <a> continuam extraídos normalmente
      }

      // Rastreia a largura (%) da coluna Braze atual (<td class="column..." width="NN%">)
      // — usado abaixo pra diferenciar um ÍCONE genuíno de assinatura (sozinho numa
      // coluna de 100%) de uma IMAGEM DE CONTEÚDO real (lado a lado com uma coluna de
      // texto num layout de 2/3 colunas, ex: "baixe o app" com foto+parágrafo) — as duas
      // podem ter a mesma largura em pixels, então só o pixel width não dava pra confiar.
      if(/^td$/i.test(tagName)){
        if(!isClose && !isSelfClose){
          const wPctM = tok.match(/\bwidth=["']?([\d.]+)%/i);
          const inherited = colWidthStack.length ? colWidthStack[colWidthStack.length-1] : 100;
          colWidthStack.push(wPctM ? parseFloat(wPctM[1]) : inherited);
        } else if(isClose){
          colWidthStack.pop();
        }
      }

      // Void elements never increment skipDepth
      if(SKIP_VOID.test(tagName)){
        // Capture <img> src for image localisation
        if(tagName.toLowerCase()==='img'){
          const srcM = tok.match(/\bsrc=(?:"([^"]*)"|'([^']*)')/i);
          if(srcM){
            const srcVal=(srcM[1]||srcM[2]||'').trim();
            // Skip tiny spacers, tracking pixels, data-URIs, e sources Liquid — só entra
            // imagem com src=URL de verdade. Um <img src="{{ partner_1_logo }}"> é
            // conteúdo dinâmico controlado pelo Braze (content block), não uma imagem
            // fixa que dá pra trocar por país; fica de fora do seletor.
            const isLiquid = srcVal.startsWith('{{') || srcVal.startsWith('{%');
            // Ícone/botão de CTA: imagem pequena (≤150px) dentro de um link cujo href
            // é um único merge tag Liquid (ex: <a href="{{signUpURL}}"><img width="120">
            // </a>) — normalmente a MESMA imagem em qualquer idioma (marca/botão), não
            // conteúdo pra traduzir. CSVs de tradução costumam nem ter linha pra ela;
            // extraí-la mesmo assim deslocava a numeração de tudo que vem depois dela.
            const wM = tok.match(/\bwidth=["']?(\d+)/i);
            const widthPx = wM ? parseInt(wM[1], 10) : null;
            const topAnchor = anchorStack[anchorStack.length - 1];
            // Só conta como ícone se também estiver numa coluna de largura TOTAL (100%) —
            // uma imagem de conteúdo real (ex: foto de um passo, "baixe o app") divide a
            // linha com uma coluna de texto ao lado (50%/33%) mesmo sendo pequena em px,
            // então largura de coluna < 100% sempre desqualifica o "é só um ícone".
            const colPct = colWidthStack.length ? colWidthStack[colWidthStack.length - 1] : 100;
            const inMultiColumnLayout = colPct < 99.5;
            const inLiquidLinkIcon = !!topAnchor && /^\{\{[^{}]+\}\}$/.test(topAnchor.href) &&
              widthPx !== null && widthPx <= 150 && !inMultiColumnLayout;
            if(srcVal && srcVal.length>5 && !srcVal.startsWith('data:') && !isLiquid && !/^\s*$/.test(srcVal) && !inLiquidLinkIcon){
              // Chave única por OCORRÊNCIA, não só por texto de src — sem isso, imagens
              // reais repetidas (mesmo ícone/logo usado mais de uma vez no e-mail) ficavam
              // com uma seleção só compartilhada entre todas as ocorrências.
              const occIndex = (imgOccCount[srcVal] = (imgOccCount[srcVal]||0) + 1) - 1;
              res.push({text:srcVal, src:srcVal, isImg:true, imgTag:tok, imgKey: srcVal + '::' + occIndex});
            }
          }
        }
        // Preserve void tags (ex: <br>) that sit inside an open style frame (<strong>, <b>...).
        // Without this, a stray <br> right before the closing style tag (ex:
        // "<strong>Header:<br></strong>") gets silently dropped from the reconstructed
        // outerKey ("<strong>Header:</strong>", missing the <br>) — which then never matches
        // the real HTML, and buildTaggedHtml() quietly drops the whole line from the export.
        if(styleStack.length>0) styleStack[styleStack.length-1].parts.push(tok);
        continue;
      }

      if(SKIP_PAIR.test(tagName)){
        if(!isClose && !isSelfClose) skipDepth++;
        else if(isClose) skipDepth=Math.max(0,skipDepth-1);
        continue;
      }
      if(skipDepth>0) continue;

      if(STYLE.test(tagName)){
        if(!isClose && !isSelfClose){
          styleStack.push({tag:tagName.toLowerCase(),openTag:tok,
            closeTag:'</'+tagName.toLowerCase()+'>',parts:[]});
        } else if(isClose){
          let fi=-1;
          for(let si2=styleStack.length-1;si2>=0;si2--){
            if(styleStack[si2].tag===tagName.toLowerCase()){ fi=si2; break; }
          }
          if(fi>=0){
            const frame=styleStack.splice(fi)[0];
            const inner=frame.parts.join('').trim();
            const innerTextOnly = stripLiquid(inner);
            const isPureControlInner = /^\s*\{%[-\s]*(?:assign|capture|endcapture|endif|endfor|endunless|endcase|case|when|render|include)\b/i.test(inner);
            const soleInnerTokens = splitLiquid(inner);
            const isSoleInnerMergeTag = soleInnerTokens.length === 1 && soleInnerTokens[0].type === 'liquid' && soleInnerTokens[0].val.startsWith('{{') && isRecognizedMergeTag(soleInnerTokens[0].val);
            if(inner && inner.length>=2 && !isPureControlInner && (innerTextOnly.length>=4 || isSoleInnerMergeTag)){
              const outerKey=frame.openTag+frame.parts.join('')+frame.closeTag;
              const innerTokens = splitLiquid(inner);
              const innerHasLiquid = innerTokens.some(tk=>tk.type==='liquid');
              if(innerHasLiquid && innerTokens.length === 1){
                // Liquid sozinho dentro da tag de estilo (sem texto de verdade ao redor) —
                // mesmo tratamento do caso "standalone" fora de tags de estilo: o fallback
                // vira conteúdo traduzível próprio.
                const tk = innerTokens[0];
                const dm = tk.val.match(/\|\s*default\s*:\s*['"]([^'"]{2,})['"]/);
                // display: placeholder legível, só pro preview visual final. text (o que vai
                // pro CSV/grade): a tag CRUA, exatamente como está no HTML.
                const dispTag = dm ? dm[1] : toLiquidPlaceholder(tk.val);
                res.push({
                  text: tk.val, src: tk.val, display: dispTag, isStyle: false,
                  isLiquidFull: true, liquidToken: tk.val
                });
              } else if(innerHasLiquid && innerTokens.some(isConditionalBoundary)){
                // {% if/elsif/else %} dentro da tag de estilo — ramos mutuamente exclusivos,
                // cada um vira sua própria linha (o wrapper de estilo único não corresponde a
                // nenhum ramo específico, então essas linhas saem como texto simples).
                for(const branchTokens of splitTokensByConditional(innerTokens)) emitBranchRows(branchTokens, res);
              } else if(innerHasLiquid && innerTokens.some(isIgnoredMergeToken)){
                // Tag ignorada (content_blocks...) no MEIO do texto
                // estilizado — mesma fronteira de sempre: separa em linhas antes/depois dela.
                // O wrapper de estilo único não corresponde a nenhum dos dois pedaços, então
                // saem como texto simples (igual o caso do if/elsif/else acima).
                emitBranchRows(innerTokens, res);
              } else {
                // Liquid misturado com texto de verdade dentro da tag de estilo SEM
                // content_blocks (ex: um <strong>Oi {{custom_attribute.${first_name}
                // |default:'você'}}</strong>, ou {{context.offer_trial_duration}}), OU sem
                // Liquid nenhum — nos dois casos vira UMA linha só, com o que tiver de Liquid
                // preservado ao pé da letra dentro de "inner" (que já existe literalmente no
                // documento como openTag+inner+closeTag). Antes o caso misto fragmentava em
                // várias linhas soltas; agora quem traduz vê a frase inteira de uma vez.
                res.push({text:mergeLiquidInline(inner), src:inner, display:toLiquidPlaceholder(inner), isStyle:true,
                  outerKey, openTag:frame.openTag, closeTag:frame.closeTag});
              }
            }
            if(styleStack.length>0)
              styleStack[styleStack.length-1].parts.push(
                frame.openTag+frame.parts.join('')+frame.closeTag);
          }
        }
      } else {
        if(styleStack.length>0) styleStack[styleStack.length-1].parts.push(tok);
      }
      continue;
    }

    // Text token
    if(msoDepth>0||skipDepth>0) continue;

    let workTok = tok;
    // Ainda estamos dentro de um {% ... %} que abriu num token anterior (uma tag HTML/
    // comentário no meio da condição cortou o fluxo) — procura o "%}" que fecha; até achar,
    // o token inteiro é controle puro (nunca vira linha traduzível).
    if(inOpenControlTag){
      const closeIdx = workTok.indexOf('%}');
      if(styleStack.length>0) styleStack[styleStack.length-1].parts.push(workTok);
      if(closeIdx === -1) continue;
      inOpenControlTag = false;
      workTok = workTok.slice(closeIdx+2);
      if(!workTok || !workTok.trim()) continue;
    }

    const t=workTok.trim();
    if(!t||t.length<2){
      if(styleStack.length>0) styleStack[styleStack.length-1].parts.push(workTok);
      continue;
    }

    // Um {% ... que ABRE mas não FECHA dentro deste mesmo token (uma tag HTML/comentário logo
    // depois interrompe a condição, ex: "{% if {{a}} == 0 <!--x--> and {{b}} %}" vira dois
    // tokens de texto) — trata o token inteiro como controle (conservador: melhor perder um
    // pedacinho raro de texto real bem nesse ponto do que arriscar tagueiar sintaxe do Liquid)
    // e lembra que continua aberto pro(s) próximo(s) token(s) de texto.
    {
      const openIdx = t.search(/\{%[-\s]/);
      if(openIdx !== -1 && !t.slice(openIdx).includes('%}')){
        inOpenControlTag = true;
        if(styleStack.length>0) styleStack[styleStack.length-1].parts.push(workTok);
        continue;
      }
    }

    // Skip pure Liquid control tags (no real text possible)
    const isPureControl = /^\s*\{%[-\s]*(?:assign|capture|endcapture|endif|endfor|endunless|endcase|case|when|render|include)/i.test(t);
    // Measure real text after stripping all Liquid
    const textOnly = stripLiquid(t);
    // Uma merge tag {{...}} SOZINHA (sem texto nenhum ao redor, ex: "{{ partner_1_name }}")
    // sempre fica com textOnly vazio (stripLiquid apaga a tag inteira) — sem essa exceção,
    // "isEffectivelyEmpty" descartava a linha ANTES até de chegar no tratamento de Liquid
    // sozinho logo abaixo, fazendo a tag sumir do CSV sem deixar rastro nenhum.
    const soleTokens = splitLiquid(t);
    const isSoleMergeTag = soleTokens.length === 1 && soleTokens[0].type === 'liquid' && soleTokens[0].val.startsWith('{{') && isRecognizedMergeTag(soleTokens[0].val);
    // "Efetivamente vazio" = pequeno demais pra ser texto traduzível de verdade. O critério
    // ANTIGO era só textOnly.length < 4 — mas isso descartava palavras curtas LEGÍTIMAS, como
    // as abreviações de dia da semana "Mon/Tue/Wed/Thu/Fri/Sat/Sun" (3 letras), que ficavam de
    // fora do CSV mesmo aparecendo no e-mail (bug reportado no "Phase 2 - Non WH+ - Email 4").
    // Critério novo, ADITIVO (nunca descarta o que já era capturado): só é vazio se for curto
    // (<4 chars) E tiver menos de 2 LETRAS. Assim "Mon" entra (3 letras), preços/números longos
    // tipo "$29.99"/"100%" continuam entrando (>=4 chars), e símbolos/espaçadores soltos
    // ("→", "•", "|", "-", um caractere só) seguem barrados.
    const letterCount = (textOnly.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
    const isEffectivelyEmpty = textOnly.length < 4 && letterCount < 2 && !isSoleMergeTag;

    if(isPureControl || isEffectivelyEmpty){
      if(styleStack.length>0) styleStack[styleStack.length-1].parts.push(workTok);
      continue;
    }

    if(styleStack.length>0){
      styleStack[styleStack.length-1].parts.push(workTok);
    } else {
      const tokens = splitLiquid(t);
      const hasLiquid = tokens.some(tk => tk.type==='liquid');

      if(hasLiquid && tokens.length === 1){
        // Liquid SOZINHO (nenhum texto de verdade ao redor) — ex: uma célula de conteúdo
        // que é só {{custom_attribute.${client_name} | default: 'your company'}}. Aqui faz
        // sentido tratar o fallback como conteúdo traduzível de verdade (é texto de negócio,
        // tipo nome de plano/oferta), então vira sua própria linha, igual já funcionava.
        const tk = tokens[0];
        const dm = tk.val.match(/\|\s*default\s*:\s*['"]([^'"]{2,})['"]/);
        // Sem "| default: '...'" (ex: {{ partner_1_name }}, uma variável de Liquid pura sem
        // fallback) — antes disso simplesmente NADA era criado, e a tag sumia sem deixar
        // rastro nenhum no CSV. Ainda vira sua própria linha, usando um placeholder legível
        // como texto (não tem um "valor padrão" de verdade pra mostrar, mas pelo menos a
        // posição fica visível e rastreável pra quem tá revisando o CSV).
        const display = dm ? dm[1] : toLiquidPlaceholder(tk.val);
        res.push({
          text: tk.val, src: tk.val, display, isStyle: false,
          isLiquidFull: true, liquidToken: tk.val
        });
      } else if(hasLiquid && tokens.some(isConditionalBoundary)){
        // {% if/elsif/else %} misturado com texto — ramos mutuamente exclusivos (só um é
        // exibido de cada vez), então cada ramo vira sua própria linha, com o merge de
        // custom_attribute/context acontecendo só dentro do ramo em si.
        for(const branchTokens of splitTokensByConditional(tokens)) emitBranchRows(branchTokens, res);
      } else {
        // Liquid MISTURADO com texto de verdade (ex: "Hi {{custom_attribute
        // .${first_name}|default:'there'}}, welcome!" ou "Enjoy your
        // {{context.offer_trial_duration}} days"), OU sem Liquid nenhum — vira UMA linha só,
        // com o merge tag preservado ao pé da letra dentro do texto (src = a frase crua, com a
        // tag Liquid junto) — a pessoa traduz a frase toda e só reposiciona a tag onde fizer
        // sentido na gramática do idioma dela. Se tiver uma tag IGNORADA no meio (content_blocks...),
        // emitBranchRows quebra em linhas separadas antes/depois dela
        // em vez de deixar um buraco no meio de uma linha só.
        emitBranchRows(tokens, res);
      }
    }
  }

  S.strings = res.map((s,i) => ({ ...s, id:'id'+(i+1) }));
}

// Detecta {{content_blocks.${...Footer...}}} (qualquer variação de nome/filtro que
// contenha "footer") e troca por um retrato fiel de como o footer real do Wellhub
// aparece — sem isso, o preview mostrava só a tag Liquid crua ou um espaço em branco,
// já que esse conteúdo só existe de verdade dentro do Braze, nunca no HTML exportado.
// Duas (ou mais) chamadas consecutivas de content block de footer viram UM footer só.
function renderFooterPlaceholder(html) {
  const footerCbRe = /(\{\{\s*content_blocks\.\$\{[^}]*footer[^}]*\}[^}]*\}\}\s*)+/gi;
  return html.replace(footerCbRe, FOOTER_PLACEHOLDER_HTML);
}

// Toggle SÓ de teste/visualização (não muda o HTML tageado, nem o CSV — só o preview em
// tela): o preview normalmente nunca avalia a condição de um {% if/elsif/else %} de verdade,
// então isso resolve manualmente cada bloco if/elsif/else/endif (e unless/endunless),
// escolhendo UM branch — 'if' pega sempre o primeiro (o if/unless), 'else' pega sempre o
// último (o else, se existir; senão cai pro último elsif; senão cai pro próprio if).
// Suporta blocos aninhados via recursão. 'if' é sempre o padrão do projeto.
// Cada branch escolhido vem com uma tag discreta (IF/ELSE) logo ACIMA do texto — não mostra
// o outro branch (só existia no modo "Both", removido), mas deixa claro que aquele trecho é
// conteúdo condicional, e qual lado está sendo mostrado.
// revealRow (opcional): id de uma linha a REVELAR. Quando passado, CADA condicional escolhe,
// independentemente, o ramo que contém {%translation revealRow%} (se algum contiver) — senão
// usa o índice `mode`. Isso cobre condicionais ANINHADAS: um índice global único mudaria o
// outer e o inner juntos e nunca mostraria "outer=elsif E inner=if" ao mesmo tempo; com o
// revealRow, o inner e o outer se alinham sozinhos pro ramo que contém a linha (o revealRow é
// visível pra toda a recursão, então cada nível se resolve pro lado certo). É assim que clicar
// numa linha SEMPRE a revela, esteja ela aninhada onde estiver.
function resolveConditionalBranch(html, mode, revealRow){
  const revealMark = revealRow ? `{%translation ${revealRow}%}` : null;
  const TAG_RE = /\{%[-\s]*(if|elsif|else|endif|unless|endunless)\b([^%]*)%\}/gi;
  const tokens = [];
  let last = 0, m;
  while((m = TAG_RE.exec(html))){
    if(m.index > last) tokens.push({t:'text', v: html.slice(last, m.index)});
    tokens.push({t:'tag', k: m[1].toLowerCase()});
    last = m.index + m[0].length;
  }
  if(last < html.length) tokens.push({t:'text', v: html.slice(last)});

  let i = 0;
  // Consome texto (e blocos if/unless aninhados, resolvidos recursivamente) até achar um
  // token de "parada" (else/elsif/endif/endunless) ou acabarem os tokens — não consome o
  // token de parada, quem chamou decide o que fazer com ele.
  function parseSequence(){
    let out = '';
    while(i < tokens.length){
      const tok = tokens[i];
      if(tok.t === 'text'){ out += tok.v; i++; continue; }
      if(tok.k === 'if' || tok.k === 'unless'){
        i++;
        // Está dentro de uma tag HTML aberta (ex: {% if %} DENTRO do src de um <img>)?
        // Aí NÃO pode injetar o rótulo <br>/<span> — ele quebraria a tag e os atributos
        // (width/height/alt/style...) vazariam como texto no preview. Nesse caso resolve
        // só pro texto do ramo. Balanço simples: um "<" sem ">" depois = dentro de tag.
        const insideTag = out.lastIndexOf('<') > out.lastIndexOf('>');
        out += parseIfBlock(insideTag);
        continue;
      }
      return { out, stop: tok.k };
    }
    return { out, stop: null };
  }
  // Já consumiu o {% if %}/{% unless %} de abertura — resolve até o {% endif/endunless %}
  // correspondente e devolve o texto do branch escolhido pelo "mode", com a tag IF/ELSE
  // prefixada (própria etiqueta do "mode", não do nome real do branch — bate com o que a
  // pessoa clicou no toggle, mesmo num "else" que na verdade caiu de volta pro if por falta
  // de um {% else %} de verdade). Se `insideTag`, devolve só o texto do branch, sem o rótulo
  // (não dá pra pôr markup dentro de um atributo).
  function parseIfBlock(insideTag){
    const branches = [];
    let stop = null;
    for(;;){
      const seq = parseSequence();
      branches.push(seq.out);
      stop = seq.stop;
      if(stop === 'elsif' || stop === 'else'){ i++; continue; }
      break; // endif/endunless, ou acabou sem fechar (HTML malformado) — desiste aqui
    }
    if(stop === 'endif' || stop === 'endunless') i++;
    // mode agora é um ÍNDICE de ramo (0=if, 1=primeiro elsif, ..., último=else). Cada
    // condicional tem seu próprio nº de ramos; o índice global é limitado ao último ramo desta
    // condicional (Math.min) — assim um toggle em "elsif 2" mostra o else de uma condicional que
    // só tem if/else, sem quebrar. ANTES só existia if(=primeiro) e else(=último): todo texto
    // num {% elsif %} do meio ficava inalcançável no preview (essa era a raiz de "texto não é
    // lido no preview" com os e-mails de N vias do Eligible).
    // Se estamos revelando uma linha e algum ramo DESTE condicional a contém, escolhe esse ramo
    // (independente do índice global) — é o que faz linhas em ramos aninhados sempre aparecerem.
    let chosenIdx = Math.min(mode|0, branches.length - 1);
    if(revealMark){
      const hit = branches.findIndex(b => b.indexOf(revealMark) !== -1);
      if(hit !== -1) chosenIdx = hit;
    }
    const chosen = branches[chosenIdx];
    if(insideTag) return chosen;
    const label = chosenIdx === 0 ? 'IF'
      : (chosenIdx === branches.length - 1 ? 'ELSE' : 'ELSIF');
    // Rótulo INLINE, logo na frente do texto do ramo (sem <br> em volta — eles criavam um vão
    // vertical enorme, ex: dentro de um botão o "IF" ficava numa linha e o texto embaixo).
    return `<span class="mlt-cond-tag">${label}</span> ${chosen}`;
  }

  return parseSequence().out;
}

// Nº MÁXIMO de ramos numa mesma condicional do HTML (1 = sem elsif/else; 2 = if/else;
// 3 = if/elsif/else; etc). Usado pra saber quantas posições o toggle de ramo precisa oferecer,
// e até onde revealCondBranchForRow/verifyAllRowsPositionable devem procurar. Conta por bloco
// {% if/unless %} (1 + qtd de elsif/else até o endif correspondente), respeitando aninhamento.
function maxCondBranchCount(html){
  if(!html) return 1;
  const TAG_RE = /\{%[-\s]*(if|elsif|else|endif|unless|endunless)\b[^%]*%\}/gi;
  let m, stack = [], max = 1;
  while((m = TAG_RE.exec(html))){
    const k = m[1].toLowerCase();
    if(k === 'if' || k === 'unless'){ stack.push(1); }
    else if(k === 'elsif' || k === 'else'){
      if(stack.length){ stack[stack.length-1]++; if(stack[stack.length-1] > max) max = stack[stack.length-1]; }
    } else if(k === 'endif' || k === 'endunless'){ stack.pop(); }
  }
  return max;
}

// CSS da tag if/else (.mlt-cond-tag/.mlt-cond-br, ver resolveConditionalBranch) e do aviso
// "Footer preview — not selectable" — precisa ser injetada DENTRO de cada documento de
// iframe que usa esses blocos, já que o CSS da página pai não atravessa pra dentro de um
// iframe com seu próprio HTML (srcdoc/blob). Usada no preview principal, no preview da tela
// de selecionar imagens e na miniatura do Dashboard — mesmo visual nos três.
function injectCondStyle(html){
  const style = `<style>
.mlt-cond-tag{display:inline-block;font-size:9px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;padding:1px 5px;margin:0 2px;border-radius:3px;font-family:-apple-system,sans-serif;color:#8a8a82;background:#e8e8e5;border:1px solid #d8d8d2;white-space:nowrap;vertical-align:middle;}
.mlt-footer-block, .mlt-footer-block *{pointer-events:none!important;cursor:not-allowed!important;user-select:none!important;}
.mlt-footer-block{position:relative;}
.mlt-footer-block::before{content:"Footer preview — not selectable";position:absolute;top:6px;left:50%;transform:translateX(-50%);background:rgba(20,20,40,.72);color:#fff;font:700 9px/1 -apple-system,sans-serif;letter-spacing:.03em;text-transform:uppercase;padding:4px 9px;border-radius:20px;pointer-events:none;z-index:20;white-space:nowrap;}
</style>`;
  return html.includes('</head>') ? html.replace('</head>', style + '</head>') : style + html;
}

// Builds the final rendered HTML string for a given lang (or the origin, when lang is falsy/matches origin).
// Extracted from refreshViewer so the same rendering logic can be reused by the Approval grid,
// which needs one rendered frame per country instead of a single viewer frame.
// Substitui Liquid merge tags conhecidas por placeholders curtos e legíveis, em QUALQUER
// lugar que renderize o e-mail (previewer principal, Approval View, miniatura do card no
// Dashboard) — centralizado aqui pra não ter que lembrar de replicar cada regra nova em
// mais de um lugar. Sem isso, tags Liquid cruas apareciam como texto enorme sem quebra de
// linha, estourando o layout onde quer que o e-mail fosse exibido.
function replaceLiquidPlaceholders(html){
  // aceita tanto "content_block" (singular) quanto "content_blocks" (plural), já que
  // e-mails diferentes usam as duas grafias pra referenciar o mesmo tipo de bloco.
  html=html.replace(/\{\{content_blocks?\.\$\{gym_quantity\}[^}]*\}\}/g, 'XXX');
  html=html.replace(/\{\{content_blocks?\.\$\{app_quantity\}[^}]*\}\}/g, 'XXX');
  html=html.replace(/\{\{context\.first_paid_plan_price\}\}/g, '{first_paid_plan_price}');
  html=html.replace(/\{\{context\.offer_trial_duration\}\}/g, '{trial_duration}');
  html=html.replace(/\{\{content_blocks?\.\$\{currency\}[^}]*\}\}/g, '{currency}');
  html=html.replace(/\{\{custom_attribute\.\$\{([^}]+)\}[^}]*\}\}/g, '{$1}');
  // Rede de segurança: qualquer OUTRA Liquid merge tag com filtro "| default: '...'" que
  // não caiu em nenhuma regra específica acima (ex: {{rating | default: '4.5'}}, ou uma
  // variação de sintaxe de content_block que a gente ainda não tinha visto).
  html=html.replace(/\{\{\s*([^{}]+?)\s*\|\s*default:\s*['"][^'"]*['"]\s*\}\}/g, (_, expr) => {
    const dollarMatch = expr.match(/\$\{([^}]+)\}/);
    const name = (dollarMatch ? dollarMatch[1] : expr.split('.').pop()).trim();
    return '{' + name + '}';
  });
  html=html.replace(/\{\{content_blocks?\.\$\{catalog_global_all_partners_data\}[^}]*\}\}/g, '');
  html=html.replace(/\{\{\s*partner_(\d+)\.name\s*\}\}/g, 'Partner $1');
  html=html.replace(/\{\{\s*partner_(\d+)\.logo_url\s*\}\}/g, '');
  // Rede de segurança final: QUALQUER content_blocks que sobrou (nome novo que a gente ainda
  // não tinha visto, sem "| default:") — sem isso, a tag Liquid inteira aparecia crua no
  // preview (texto longo tipo "{{content_blocks.${SignupLinkV2}}}"), quebrando o layout em
  // vez de virar um placeholder curto e discreto como os outros.
  html=html.replace(/\{\{\s*content_blocks?\.\$\{([^}]+)\}[^}]*\}\}/g, '{$1}');
  // Mesma rede de segurança, agora pra QUALQUER context.* (ou custom_attribute sem "${}")
  // que sobrou sem regra específica — ex: {{context.last_free_plan_name}}.
  html=html.replace(/\{\{\s*context\.([a-zA-Z0-9_]+)\s*\}\}/g, '{$1}');
  html=html.replace(/\{\{\s*custom_attribute\.([a-zA-Z0-9_]+)\s*\}\}/g, '{$1}');

  // SÓ VISUAL, pra quem está aprovando — nunca muda o HTML/CSV reais (essa função só
  // roda no preview, depois das duas passadas de Pass A/B). Às vezes o template original
  // já vem sem espaço entre um texto e a tag Liquid (ex: "apps:{{content_blocks...}}"),
  // porque na Braze de verdade aquilo vira um número colado ali mesmo (ex: "apps:47").
  // Isso é fiel ao HTML real, mas GRUDADO com o placeholder amigável (ex: "apps:XXX")
  // fica confuso pra revisar visualmente — insere um espaço só aqui, só pra leitura.
  // O texto visível ("apps:") e o placeholder (ex: "XXX") quase sempre têm uma fronteira
  // de tag HTML entre eles no string final (ex: "apps:</span></strong>XXX", por causa do
  // <span data-tid> do Pass A/B) — sem pular essas tags na checagem, "apps:" e "XXX"
  // pareciam não-adjacentes pro regex mesmo estando visualmente coladas na tela. O grupo
  // do meio (qualquer sequência de tags) é preservado como está; só o espaço entra
  // logo antes/depois do placeholder em si. Inclui "}" no gatilho também — dois
  // placeholders colados um no outro (ex: "{first_paid_plan_price}{currency}", comum
  // quando o preço aparece direto colado no content_block de moeda) precisam do mesmo
  // espaço visual entre eles.
  html = html.replace(/([a-zA-Z0-9:,;}])((?:<[^>]*>)*)(XXX|\{[a-zA-Z0-9_]+\}|Partner \d+)/g, '$1$2 $3');
  // Do lado de DEPOIS só letra/dígito — pontuação (,;:.) colada logo após o placeholder é
  // tipograficamente normal (ex: "XXX," ou "XXX:"), não precisa de espaço ANTES dela.
  html = html.replace(/(XXX|\{[a-zA-Z0-9_]+\}|Partner \d+)((?:<[^>]*>)*)([a-zA-Z0-9])/g, '$1 $2$3');

  return html;
}

function buildPreviewHtml(lang, revealRow){
  const origLang=S.allC.find(c=>c.code===S.origin)?.lang;
  const isOrig=!lang||lang===origLang;
  // revealRow: linha a forçar visível (cada condicional escolhe o ramo que a contém). Default =
  // S.condRevealRow (setado ao clicar/focar uma linha). Garante que clicar em QUALQUER linha a
  // revele, mesmo aninhada, independente do índice do toggle.
  if(revealRow === undefined) revealRow = S.condRevealRow || null;
  // ─── Preview ANCORADO A PARTIR DO HTML TAGUEADO (fonte autoritativa) ───────────────────────
  // "Texto não é lido no preview" voltava toda hora porque o preview RE-ENCONTRAVA cada texto
  // por conta própria (um "Pass A") e divergia do extractStr/buildTaggedHtml a cada transformação
  // nova — rótulo IF/ELSE injetado, ramo resolvido, entidade/espaço, chaves que se sobrepõem
  // como substring. Eram dois pipelines independentes obrigados a achar a MESMA posição sozinhos.
  // Agora o preview reusa buildTaggedHtml(silent): ele já envolve TODA linha (texto, imagem,
  // Liquid, estilo) com {%translation idN%}...{%endtranslation%} na posição EXATA — é o mesmo
  // artefato que sobe pro Braze, o único lugar que precisa (e sabe) ancorar. O preview só:
  //   1) resolve a condicional (o ramo escolhido mantém suas tags; o inativo some junto),
  //   2) trata os {% assign %},
  //   3) troca cada tag de tradução por <span data-tid="idN"> com o texto de EXIBIÇÃO.
  // Zero re-ancoragem própria = zero divergência. O que não aparece é só ramo inativo/VML, que
  // o revealCondBranchForRow revela ao clicar. (silent: não dispara o toast de "linhas fora".)
  const byId = {}; S.csv.rows.forEach(r => byId[r.id] = r);
  let html = buildTaggedHtml(true);

  // {% comment %} do Liquid não é escondido pelo navegador (≠ <!-- -->) — remove pra não vazar.
  html = html.replace(/\{%[-\s]*comment[-\s]*%\}[\s\S]*?\{%[-\s]*endcomment[-\s]*%\}/gi, '');
  html = renderFooterPlaceholder(html);
  html = resolveConditionalBranch(html, S.condBranch|0, revealRow);
  // {% assign partner_X_id %} some (declarativo, nunca visível); os demais viram label curto.
  html = html.replace(/\{%[-\s]*assign\s+partner_\d+_id\s*=[^%]*?%\}/g, '');
  html = html.replace(/\{%[-\s]*assign\s+([A-Za-z0-9_.]+)\s*=[^%]*?%\}/g,
    (m, name) => `<span class="mlt-cond-tag">{assign.${name}}</span>`);

  // Imagens: buildTaggedHtml põe a tag DENTRO do src (src="{%translation idN%}URL{%endtranslation%}").
  // Converte a <img> inteira num <span data-tid class=braze-img-wrap>, trocando o src pelo de
  // exibição (tradução da imagem por idioma, se houver). Feito ANTES da troca genérica de texto,
  // senão a tag dentro do atributo viraria um <span> dentro do src (quebrado).
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc=(["'])\{%translation\s+(id\d+)%\}([\s\S]*?)\{%endtranslation%\}\1/i);
    if(!m) return tag;
    const id = m[2], row = byId[id]; if(!row) return tag;
    const displaySrc = ((!isOrig && row.translations[lang]) ? row.translations[lang] : (row.src || m[3])).trim();
    const newTag = tag.replace(/\bsrc=(["'])\{%translation\s+id\d+%\}[\s\S]*?\{%endtranslation%\}\1/i, `src="${displaySrc}"`);
    return `<span data-tid="${id}" class="braze-img-wrap">${newTag}</span>`;
  });

  // Texto/estilo/Liquid: cada {%translation idN%}INNER{%endtranslation%} vira <span data-tid>.
  // display = tradução do idioma se houver; senão o próprio INNER — que é EXATAMENTE o texto
  // canônico que o buildTaggedHtml colocou (csvSourceText já curlificado, ou a expressão Liquid
  // pra linhas isLiquidFull). Usar o INNER (em vez de row.text/row.src) evita duplicar o espaço
  // das pontas, que o buildTaggedHtml já deixou FORA da tag. Merge tags que sobrarem no display
  // viram texto legível no replaceLiquidPlaceholders(), logo abaixo, como antes.
  html = html.replace(/\{%translation\s+(id\d+)%\}([\s\S]*?)\{%endtranslation%\}/g, (m, id, inner) => {
    const row = byId[id];
    if(!row) return inner;
    const displayText = (!isOrig && row.translations[lang])
      ? curlifyApostrophes(row.translations[lang])
      : inner;
    return `<span data-tid="${id}">${displayText}</span>`;
  });

  // Só DEPOIS das duas passadas (Pass A/B) é que troca os merge tags Liquid por placeholders
  // legíveis — se rodasse antes, o texto de uma linha que tem um merge tag EMBUTIDO no meio
  // (ex: "Hi {{custom_attribute.${first_name}|default:'there'}}, welcome!") deixava de bater
  // literalmente com row.src na hora do Pass A encontrar onde marcar o __TID_n__, e a
  // linha inteira ficava sem a tradução aplicada (mostrava sempre o texto de origem cru).
  // Rodando por último, cobre tanto o texto que sobrou fora de qualquer linha traduzível
  // quanto qualquer merge tag que a própria tradução carregue dentro dela.
  html = replaceLiquidPlaceholders(html);

  // CSS das badges de if/else/unless injetada no <head> (ou no início, se não houver <head>) —
  // precisa viver dentro do próprio documento do iframe, já que os <span> ficam no conteúdo.
  html = injectCondStyle(html);

  // Toda <img> que falhar ao carregar (URL quebrada, ou um merge tag Liquid que nunca foi
  // resolvido, ex: {{content_blocks.${x}}} usado direto como src) vira uma caixinha "IMG" do
  // MESMO tamanho da imagem original — em vez do ícone de imagem quebrada do navegador.
  const imgFallbackScript = (() => {
    const sc = '<scr' + 'ipt>', scEnd = '</scr' + 'ipt>';
    return sc + `(function(){
      function fallback(img){
        var w = img.getAttribute('width') || img.offsetWidth || 80;
        var h = img.getAttribute('height') || img.offsetHeight || 80;
        var box = document.createElement('div');
        box.textContent = 'IMG';
        box.style.cssText = 'width:'+w+'px;height:'+h+'px;display:flex;align-items:center;justify-content:center;'+
          'background:#e8e8e5;color:#8a8a82;font:700 11px -apple-system,sans-serif;letter-spacing:.04em;'+
          'border:1px dashed #b8b8b0;box-sizing:border-box;';
        if(img.parentNode) img.parentNode.replaceChild(box, img);
      }
      function wire(img){
        if(img.complete && img.naturalWidth === 0) { fallback(img); return; }
        img.addEventListener('error', function(){ fallback(img); }, {once:true});
      }
      document.querySelectorAll('img').forEach(wire);
    })()` + scEnd;
  })();
  html = html.includes('</body>') ? html.replace('</body>', imgFallbackScript + '</body>') : html + imgFallbackScript;

  // Desativa qualquer link no preview — é só uma pré-visualização, ninguém deveria
  // conseguir navegar clicando num "Sign up" / "Explore for free" / etc. sem querer.
  // Só bloquear o click() não bastava: um <a href> ainda mostra cursor de mão e, mais
  // grave, iniciar um arraste (mousedown+drag) EM CIMA de um link faz o navegador
  // disparar o gesto nativo de "arrastar o link" (ghost do link/URL) em vez de
  // selecionar o texto — por isso não dava pra selecionar o texto dos links. Remove
  // o href de verdade (não é mais um link de fato) e força seleção de texto em tudo.
  const disableLinksScript = (() => {
    const sc = '<scr' + 'ipt>', scEnd = '</scr' + 'ipt>';
    return sc + `(function(){
      var st = document.createElement('style');
      st.textContent = '*{-webkit-user-select:text!important;user-select:text!important;} a,button,[onclick]{cursor:text!important;-webkit-user-drag:none!important;}';
      (document.head||document.documentElement).appendChild(st);
      document.querySelectorAll('a[href]').forEach(function(a){
        a.removeAttribute('href');
        a.removeAttribute('target');
        a.setAttribute('draggable','false');
      });
      document.addEventListener('dragstart', function(ev){ ev.preventDefault(); });
      document.addEventListener('click', function(ev){
        var a = ev.target.closest && ev.target.closest('a,button');
        if(a){ ev.preventDefault(); ev.stopPropagation(); }
      }, true);
    })()` + scEnd;
  })();
  html = html.includes('</body>') ? html.replace('</body>', disableLinksScript + '</body>') : html + disableLinksScript;

  return html;
}

// Rótulo de cada posição do toggle de ramo: 0=If, último=Else, meio=Elsif (numerado se houver
// mais de um). n = total de posições (maxCondBranchCount).
function condBranchLabel(i, n){
  if(i === 0) return 'If';
  if(i === n - 1) return 'Else';
  return n > 3 ? 'Elsif ' + i : 'Elsif';
}

// Diz se a posição "before" (texto até o ponto candidato) está dentro de um <style>/<script>
// ainda aberto. buildTaggedHtml/buildPreviewHtml fazem busca de texto simples no documento
// inteiro — sem isso, uma palavra comum (ex: "and") que também aparece dentro de um <style>
// (tipo num @media query) podia casar com essa ocorrência ERRADA em vez da linha de conteúdo
// real, já que <style>/<script> não tem tratamento especial nessa busca linear.
// Varre o HTML numa ÚNICA passada sequencial — mesmo tokenizador e mesma lógica de
// profundidade que extractStr() já usa pra decidir o que pular — e devolve os trechos
// [start,end) que NUNCA podem receber uma tag {%translation%}: o CONTEÚDO de
// <script>/<style>/<pre>/<code>/<noscript>/<svg> (código/CSS/markup, nunca texto
// traduzível) e blocos condicionais do Outlook (<!--[if mso]>...<![endif]-->, exceto a
// variante "downlevel-revealed" <!--[if !mso]>, que é visível pra todo mundo).
//
// Substitui a antiga isInsideSkippedTag()/stripClosedSkippedBlocks(), que recontava
// "quantos <style>/<script> abriram" do ZERO do documento a cada posição candidata — uma
// contagem cumulativa É FRÁGIL por natureza: qualquer menção solta a "<style>" ou
// "<script>" em QUALQUER lugar antes (mais comumente dentro de um comentário HTML comum,
// tipo uma nota de dev dizendo "remove this <style> block") desbalanceava a contagem pro
// resto do documento INTEIRO, fazendo toda linha depois daquele ponto parecer "ainda
// dentro de um bloco não fechado" e ser silenciosamente descartada do export (bug real,
// achado num projeto de verdade — 10 de 11 linhas sumiam do tageamento por causa de UMA
// frase assim no meio do e-mail).
//
// Aqui, como o tokenizador separa comentários (<!-- ... -->) como um token PRÓPRIO, isolado
// — igual extractStr() já faz — o texto de dentro de um comentário comum nunca chega a ser
// examinado feito nome de tag. A classe inteira desse bug fica impossível, não só o caso
// específico já visto.
function computeProtectedRanges(html) {
  const SKIP_PAIR = /^(script|style|pre|code|noscript|svg)$/i;
  const ranges = [];
  // Exige letra/"/"/"!" logo após "<" (mesmo motivo do tokenizador em extractStr — evita que
  // um "<3"/"<=" solto numa condição Liquid engula a próxima tag real).
  const tokens = html.split(/(<!--[\s\S]*?-->|<\/?[a-zA-Z!][^>]*>)/g);
  let pos = 0, msoDepth = 0, msoStart = -1, skipDepth = 0, skipStart = -1;
  for(const tok of tokens){
    const tokStart = pos;
    pos += tok.length;
    if(!tok || tok[0] !== '<') continue;

    // Mesma ordem e mesma distinção de extractStr(): downlevel-revealed é visível (não
    // conta como oculto). Um <!--[if mso]>...<![endif]--> auto-contido no MESMO token tem
    // efeito líquido zero na PROFUNDIDADE (extractStr só precisa disso, pra não travar
    // msoDepth) — mas o CONTEÚDO desse token continua escondido de verdade, e ainda
    // precisa entrar como range protegido; extractStr não precisa fazer isso porque ele
    // nunca olha pra dentro de um token de comentário de qualquer jeito.
    if(/<!--\[if\s+!mso\]>/i.test(tok)) continue;
    if(/<!--\[if/i.test(tok) && /<!\[endif\]/i.test(tok)){ ranges.push([tokStart, tokStart + tok.length]); continue; }
    if(/<!--\[if/i.test(tok)){
      if(msoDepth === 0) msoStart = tokStart;
      msoDepth++;
      continue;
    }
    if(/<!\[endif\]/i.test(tok)){
      msoDepth = Math.max(0, msoDepth - 1);
      if(msoDepth === 0 && msoStart !== -1){ ranges.push([msoStart, tokStart + tok.length]); msoStart = -1; }
      continue;
    }
    // Comentário HTML comum (<!-- -->): o CONTEÚDO nunca renderiza nem pode receber uma tag de
    // tradução. Protege o range inteiro — sem isso, o posicionador de buildTaggedHtml (que busca
    // o texto da linha por indexOf) cravava o {%translation idN%} numa ocorrência do texto que
    // vivia DENTRO de um comentário divisor de seção (ex: "<!-- SECTION: Not a gym person? -->"),
    // em vez da ocorrência de conteúdo real. Resultado: a linha "não mudava no previewer" (um
    // <span data-tid> dentro de <!-- --> não é elemento de verdade, querySelector não acha) e o
    // id saía duplicado no export. Protegendo o comentário, o texto de conteúdo real é o próximo
    // alvo válido. (Condicionais mso/VML já foram tratadas acima — aqui só cai comentário comum.)
    if(/^<!--/.test(tok)){ ranges.push([tokStart, tokStart + tok.length]); continue; }
    if(msoDepth > 0) continue;

    const nameM = tok.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
    if(!nameM) continue;
    const tagName = nameM[1];
    const isClose = tok[1] === '/';
    const isSelfClose = tok.endsWith('/>');
    if(!SKIP_PAIR.test(tagName)) continue;

    if(!isClose && !isSelfClose){
      if(skipDepth === 0) skipStart = tokStart;
      skipDepth++;
    } else if(isClose){
      skipDepth = Math.max(0, skipDepth - 1);
      if(skipDepth === 0 && skipStart !== -1){ ranges.push([skipStart, tokStart + tok.length]); skipStart = -1; }
    }
  }
  // Abertura de bloco (skip-pair OU mso) que NUNCA fecha: NÃO protege até o fim do
  // documento. Protegia antes ("defensivo pra HTML malformado"), mas isso escondia conteúdo
  // real: no previewer, resolveConditionalBranch() dropa o ramo inativo da condicional e
  // pode levar junto o </code> (ou </style>) de fechamento, deixando um <code> órfão aberto
  // — daí TUDO daquele ponto até o EOF (incluindo o outro ramo, ex: id42 do Eligible) virava
  // "região protegida" e o Pass A do preview não conseguia posicionar aqueles trechos.
  // Melhor deixar uma abertura órfã proteger NADA (pior caso: um data-tid cai dentro de um
  // bloco de code/style solto — inofensivo) do que esconder metade do e-mail.
  return ranges.sort((a,b) => a[0]-b[0]);
}

function isPosProtected(pos, ranges){
  for(const [start,end] of ranges){
    if(start > pos) break; // ranges vêm ordenados — nenhum range depois pode conter pos
    if(pos < end) return true;
  }
  return false;
}

// "before" termina bem no meio de um {% ... %} ainda sem fechar (ex: a palavra "and" também
// aparece como operador booleano dentro de {% if x and y %}) — olha só a ÚLTIMA ocorrência
// de cada marcador antes de "pos", não uma contagem cumulativa desde o início do documento:
// um {% ou %} qualquer de uma tag JÁ fechada bem antes não pode mais "vazar" e confundir uma
// posição bem mais à frente (mesma classe de fragilidade que motivou trocar
// isInsideSkippedTag() por computeProtectedRanges() acima).
function isInsideOpenLiquidTag(before){
  return before.lastIndexOf('{%') > before.lastIndexOf('%}');
}

/* ═══════════ HTML EXPORT MODAL ═══════════ */
function buildTaggedHtml(silent) {
  if(!S.rawHtml) return '';
  function replaceFirst(str, search, replacement){
    const i = str.indexOf(search); if(i === -1) return str;
    return str.slice(0,i) + replacement + str.slice(i+search.length);
  }
  // Mesma normalização da extração: desembrulha <code> puramente-Liquid ANTES de tagueiar, senão
  // o src da linha ("Enjoy your first {{...}} days on us.", já sem o <code>) não seria encontrado
  // no HTML (que ainda teria o <code> no meio). Assim a frase inteira é achada e tagueada como
  // uma unidade só, com a merge tag dentro. O <code> some do HTML tagueado exportado — aceitável:
  // ele só dava monospace a um snippet de Liquid que renderiza como valor simples no Braze.
  let tagged = unwrapLiquidOnlyCode(S.rawHtml);
  // Limpa marcadores de tradução que ficaram GRUDADOS dentro de comentários HTML comuns
  // (<!-- -->) por um tageamento antigo — acontecia quando um comentário divisor de seção
  // repetia, como texto, o mesmo título de uma seção real (ex: "<!-- SECTION: Not a gym
  // person? -->") e o posicionador cravava o {%translation idN%} nessa primeira ocorrência
  // (dentro do comentário) em vez da de conteúdo. Sozinho o comentário nunca renderiza, então a
  // linha "não mudava no previewer", e sem limpar aqui o id sairia DUPLICADO no export (a tag
  // velha do comentário + a nova, agora posicionada no conteúdo real via computeProtectedRanges).
  // Só comentário COMUM — condicionais mso/VML (<!--[if ...]>, <![endif]-->) ficam intactos, que
  // é onde as traduções de fallback do Outlook legitimamente moram.
  tagged = tagged.replace(/<!--[\s\S]*?-->/g, c =>
    (/^<!--\[if/i.test(c) || /^<!--\s*<!\[endif\]/i.test(c) || /^<!--<!\[endif\]/i.test(c))
      ? c
      : c.replace(/\{%\s*translation\s+id\d+\s*%\}/gi, '').replace(/\{%\s*endtranslation\s*%\}/gi, ''));
  const allRows = S.csv.rows.filter(r=>r.src||(r.isStyle&&r.outerKey));
  // Linhas que não conseguimos encontrar/tagueiar no HTML final — sem isso, a linha some do
  // export em silêncio e a pessoa acha que a tradução foi aplicada quando não foi.
  const missed = [];
  allRows.forEach(r=>{
    if(r.isImg && r.imgTag){
      const pos = tagged.indexOf(r.imgTag);
      if(pos === -1){ missed.push(r); return; }
      const newImgTag = r.imgTag.replace(/\bsrc=(?:"[^"]*"|'[^']*')/i, `src="{%translation ${r.id}%}${r.src}{%endtranslation%}"`);
      tagged = tagged.slice(0, pos) + newImgTag + tagged.slice(pos + r.imgTag.length);
      return;
    }
    // Liquid expression with default: wrap the WHOLE expression as one unit.
    // {{custom_attribute.${x} | default: 'y'}} →
    // {%translation idN%}{{custom_attribute.${x} | default: 'y'}}{%endtranslation%}
    if((r.isLiquidFull || r.isLiquidDefault) && r.liquidToken){
      const key = r.liquidToken;
      const protectedRanges = computeProtectedRanges(tagged);
      let searchFrom = 0, tagged_ok = false;
      while(searchFrom < tagged.length){
        const pos = tagged.indexOf(key, searchFrom);
        if(pos === -1) break;
        const before = tagged.slice(0, pos);
        // Skip occurrences already wrapped by a previous row's translation tag —
        // without this check, repeated identical Liquid expressions (e.g. the same
        // {{custom_attribute...}} used in several places) all matched the SAME first
        // occurrence and nested {%translation%} tags on top of each other instead of
        // tagging their own distinct occurrence in the document.
        const opens  = (before.match(/\{%translation [^%]+?%\}/g)||[]).length;
        const closes = (before.match(/\{%endtranslation%\}/g)||[]).length;
        if(opens > closes){ searchFrom = pos + key.length; continue; }
        if(isInsideOpenLiquidTag(before)){ searchFrom = pos + key.length; continue; }
        if(isPosProtected(pos, protectedRanges)){ searchFrom = pos + key.length; continue; }
        tagged = tagged.slice(0, pos) + `{%translation ${r.id}%}${key}{%endtranslation%}` + tagged.slice(pos + key.length);
        tagged_ok = true;
        break;
      }
      if(!tagged_ok) missed.push(r);
      return;
    }
    const key = r.isStyle&&r.outerKey ? r.outerKey : r.src;
    if(!key){ missed.push(r); return; }
    // "key" continua com o texto CRU original (precisa bater literalmente com o HTML de
    // origem pra achar a posição certa) — mas o que é INSERIDO como conteúdo da tag de
    // tradução precisa ser exatamente csvSourceText(r), a MESMA função que gera a coluna
    // de origem do CSV exportado (ver buildCsvStringForSave). Antes disso usava
    // curlifyApostrophes(r.src) direto — src cru, sem o colapso de espaço/quebra de linha
    // interna que mergeLiquidInline() aplica (\s{2,} → um espaço só). Pra qualquer linha
    // cujo HTML de origem tivesse o texto quebrado em mais de uma linha/indentado no meio
    // (comum em e-mail escrito à mão), a Braze recebia um HTML com a quebra de linha crua
    // dentro da tag de tradução, mas um CSV com o mesmo trecho já colapsado num espaço só —
    // duas strings diferentes por um detalhe de espaço, e a Braze recusava o upload com
    // "translation file includes default text that doesn't match the message content".
    // Usando csvSourceText(r) aqui (a mesma função, não uma reimplementação do colapso),
    // os dois artefatos ficam garantidamente idênticos por construção, não só "parecidos".
    // A tag de tradução tem que ABRAÇAR o texto, sem espaço/quebra de linha sobrando dentro
    // ({%translation%}Start free trial{%endtranslation%}, não {%translation%} Start free trial ).
    // O espaço das pontas existia de propósito no HTML de origem (espaçamento visual entre
    // elementos) — então ele não some: sai de DENTRO da tag e volta pra FORA dela, preservando
    // o render. lead/trail vêm da versão crua; o conteúdo (srcCurly) e a coluna de origem do
    // CSV usam csvSourceText (já sem as pontas) — os dois batem por construção (a Braze exige).
    const raw = csvSourceTextRaw(r);
    const lead = raw.slice(0, raw.length - raw.replace(/^\s+/, '').length);
    const trail = raw.slice(raw.replace(/\s+$/, '').length);
    const srcCurly = curlifyApostrophes(csvSourceText(r));
    const replacement = r.isStyle
      ? `${r.openTag}${lead}{%translation ${r.id}%}${srcCurly}{%endtranslation%}${trail}${r.closeTag}`
      : `${lead}{%translation ${r.id}%}${srcCurly}{%endtranslation%}${trail}`;
    const protectedRanges = computeProtectedRanges(tagged);
    let searchFrom = 0, tagged_ok = false;
    while(searchFrom < tagged.length){
      const pos = tagged.indexOf(key, searchFrom);
      if(pos === -1) break;
      const before = tagged.slice(0, pos);
      // Skip if inside an HTML attribute (between < and > with an unclosed quote)
      const lastTag = before.lastIndexOf('<');
      const lastTagClose = before.lastIndexOf('>');
      if(lastTag > lastTagClose){
        // We're inside a tag — check if inside a quoted attribute value
        const inTag = before.slice(lastTag);
        const dq = (inTag.match(/"/g)||[]).length;
        const sq = (inTag.match(/'/g)||[]).length;
        if(dq % 2 !== 0 || sq % 2 !== 0){ searchFrom = pos + key.length; continue; }
      }
      const opens  = (before.match(/\{%translation [^%]+?%\}/g)||[]).length;
      const closes = (before.match(/\{%endtranslation%\}/g)||[]).length;
      if(opens > closes){ searchFrom = pos + key.length; continue; }
      // Skip if inside um {% ... %} ainda ABERTO (ex: dentro da condição de um {% if %} que
      // ainda não fechou) — sem isso, uma palavra comum tipo "and" que também aparece como
      // operador booleano dentro de uma condição podia casar com essa ocorrência ERRADA (a
      // primeira do documento), colocando a tag de tradução DENTRO da sintaxe do Liquid e
      // quebrando o parser do Braze ("endtranslation is not a valid delimiter for if tags").
      if(isInsideOpenLiquidTag(before)){ searchFrom = pos + key.length; continue; }
      if(isPosProtected(pos, protectedRanges)){ searchFrom = pos + key.length; continue; }
      tagged = tagged.slice(0, pos) + replacement + tagged.slice(pos + key.length);
      tagged_ok = true;
      break;
    }
    if(!tagged_ok) missed.push(r);
  });
  if(missed.length && !silent){
    console.warn(`[buildTaggedHtml] ${missed.length} linha(s) não encontrada(s) no HTML e ficaram de fora do export:`, missed.map(r=>({id:r.id, src:(r.src||'').slice(0,80)})));
    if(typeof showNotif === 'function') showNotif(`${missed.length} linha(s) não foram encontradas no HTML e ficaram sem tradução no export — veja o console para detalhes.`, 'warn');
  }
  return tagged;
}

// Re-sincroniza o texto DENTRO de cada {%translation idN%}...{%endtranslation%} JÁ EXISTENTE
// num HTML salvo, pra bater exatamente com csvSourceText() da linha correspondente (a mesma
// fonte usada pra gerar a coluna de origem do CSV, ver buildCsvStringForSave). Necessário
// porque um projeto só é tageado UMA VEZ, na criação (buildTaggedHtml, acima) — reabrir/
// editar/salvar de novo nunca re-tageia o HTML do zero (só criaria tags aninhadas em cima
// das que já existem), então um projeto tageado ANTES da correção do buildTaggedHtml ficaria
// com o texto antigo (não colapsado) preso dentro da tag PARA SEMPRE, mesmo com o código já
// corrigido — o autosave recalcula o CSV a cada save, mas nunca tocava no HTML já salvo.
// Ignora linhas de imagem (isImg): a tag ali envolve a URL dentro do atributo src=, não
// texto, e buildTaggedHtml nunca aplicou curlifyApostrophes nesse caso — refazer isso aqui
// mudaria um comportamento à parte, não relacionado ao mismatch de espaço/quebra de linha.
function repairTaggedHtmlDefaults(html, rows) {
  if(!html) return html;
  const byId = new Map((rows||[]).filter(r=>!r.isImg).map(r => [r.id, r]));
  return html.replace(/\{%translation\s+(\S+?)%\}([\s\S]*?)\{%endtranslation%\}/g, (match, id, oldInner) => {
    const row = byId.get(id);
    if(!row) return match;
    // csvSourceText já vem sem as pontas — o conteúdo da tag tem que bater com ele. O espaço
    // que porventura esteja nas pontas do conteúdo ATUAL não é deletado: sai de dentro da tag
    // e volta pra fora dela (mesmo critério do buildTaggedHtml), preservando o espaçamento
    // visual do e-mail. Assim a tag abraça o texto sem que o render mude.
    const fresh = curlifyApostrophes(csvSourceText(row));
    const lead = oldInner.slice(0, oldInner.length - oldInner.replace(/^\s+/, '').length);
    const trail = oldInner.slice(oldInner.replace(/\s+$/, '').length);
    const rebuilt = `${lead}{%translation ${id}%}${fresh}{%endtranslation%}${trail}`;
    return rebuilt === match ? match : rebuilt;
  });
}

// Convert lang code to Braze format: pt-BR → pt_br (lowercase, underscore)
// Retorna o locale key do Braze (ex: pt_br) — usado EXCLUSIVAMENTE no CSV/XLSX exportado.
function toBrazeLang(lang) {
  return lang.toLowerCase().replace(/-/g, '_');
}

// Ordem FIXA e global de exibição/exportação dos idiomas — mesma sequência em QUALQUER
// tela (editor, previewer, approver, cards) e em QUALQUER export (CSV/XLSX), independente
// da ordem em que os idiomas foram adicionados no projeto. Padrão da plataforma, não é
// configurável por projeto. Guardada no formato INTERNO (pt-BR, não pt_br) porque quase
// todo lugar itera nesse formato e só chama toBrazeLang() na hora de exibir/exportar.
const LOCALE_DISPLAY_ORDER = ['de-DE','en-GB','en-IE','es-AR','es-CL','es-ES','es-MX','it-IT','pt-BR','pt-PT','ro-RO'];

const _LOCALE_ORDER_INDEX = Object.fromEntries(LOCALE_DISPLAY_ORDER.map((l, i) => [l.toLowerCase(), i]));

// Devolve uma CÓPIA ordenada do array de idiomas: primeiro os locales da lista fixa acima,
// na ordem definida; depois qualquer locale fora da lista (customizado), em ordem
// alfabética, no fim. NUNCA reordena o array original in-place — vários lugares (ex:
// buildTable + rowsHTML, renderCampaignLangBar + renderCampaignGrid) iteram o MESMO array
// separadamente pra montar cabeçalho e corpo, e reordenar in-place desalinharia as colunas.
// É SÓ camada de apresentação/export — o array salvo (S.csv.langs/item.langs/p.data.langs)
// continua na ordem de criação, sem migração de nenhum dado existente.
function sortLangsForDisplay(langs) {
  const known = [], unknown = [];
  (langs || []).forEach(l => {
    (Object.prototype.hasOwnProperty.call(_LOCALE_ORDER_INDEX, (l||'').toLowerCase()) ? known : unknown).push(l);
  });
  known.sort((a, b) => _LOCALE_ORDER_INDEX[a.toLowerCase()] - _LOCALE_ORDER_INDEX[b.toLowerCase()]);
  unknown.sort((a, b) => (a||'').localeCompare(b||''));
  return [...known, ...unknown];
}

// Retorna o nome de exibição completo (ex: "Brazil (pt_br)") — usado na UI (headers da tabela,
// chips do viewer, header do modal de comentário). NUNCA no CSV.
function langDisplayName(lang) {
  const c = S.allC.find(x => x.lang === lang);
  const localeKey = toBrazeLang(lang);
  if(c && c.name) return `${c.name} (${localeKey})`;
  return localeKey;
}

// Renderiza o CORPO (linhas <tr>) da grade de tradução — extraído de rowsHTML() pra poder
// ser reaproveitado (loose grid + campaign grid) com a MESMA marcação. Lê tudo de cfg:
//   cfg.rows         — array de linhas (S.csv.rows)
//   cfg.langs        — array de idiomas JÁ na ordem de exibição (sortLangsForDisplay(...))
//   cfg.originLang   — idioma de origem (S.allC.find(c=>c.code===S.origin)?.lang || null)
//   cfg.pendingImgIds— ids de imagens pendentes (S.pendingImgIds || [])
// Os handlers inline (switchAndHL/setCellV/sendHL/autoH/highlightFromTable/delRow/
// ackTextMismatch) e os helpers csvSourceText/cellCommentBtn/escHtml continuam GLOBAIS.
function renderTranslationGridBody(cfg) {
  const langsOrdered = cfg.langs;
  return cfg.rows.map((row,ri)=>{
    // ── IMAGE ROW ──
    if(row.isImg){
      const id  = (row.id||'').replace(/"/g,'&quot;');
      const src = (row.src||'').replace(/"/g,'&quot;');
      const origLang = cfg.originLang;
      const tls = langsOrdered.map((l,ci)=>{
        const v=(row.translations[l]||'').replace(/"/g,'&quot;');
        const isEmpty = !(row.translations[l]||'').trim();
        return `<td class="tl tl-cell cell-nav${isEmpty ? ' tl-missing' : ''}" data-r="${ri}" data-c="${ci}">
          <div class="tl-inner">
            <input class="img-url" type="text" readonly placeholder="URL for ${l}…" value="${v}"
              onfocus="switchAndHL(${ri},'${l}')"
              oninput="setCellV(${ri},'${l}',this.value);sendHL(${ri},'${l}')"
            />
            ${cellCommentBtn(ri, l, row)}
          </div>
        </td>`;
      }).join('');
      const thumbSrc = src.startsWith('{{') ? '' : src;
      return `<tr class="img-row">
        <td class="rn">${ri+1}</td>
        <td class="cid">${id}</td>
        <td class="src" onclick="highlightFromTable(${ri},'${origLang||''}')">
          <div class="img-thumb-wrap">
            ${thumbSrc ? `<img class="img-thumb" src="${thumbSrc.replace(/"/g,'&quot;')}" onerror="this.style.display='none'">` : '<div class="img-thumb" style="display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--text3)">Liquid</div>'}
            <span class="img-src-txt">${src.length>60?src.slice(0,57)+'…':src}</span>
          </div>
        </td>
        ${tls}
        <td class="del"><button onclick="event.stopPropagation();delRow(${ri})">×</button></td>
      </tr>`;
    }
    const id  = (row.id||'').replace(/"/g,'&quot;');
    // Mesmo texto que vai pro CSV exportado (csvSourceText) — sem isso, a grade principal
    // (o que a pessoa realmente olha pra traduzir) mostrava o Liquid cru (content_blocks,
    // custom_attribute, context) no meio da frase, mesmo já tendo sido "limpo" só no CSV.
    const displaySrc = csvSourceText(row).replace(/</g,'&lt;').replace(/"/g,'&quot;');
    const origLang = cfg.originLang;
    const tls = langsOrdered.map((l,ci)=>{
      const v=(row.translations[l]||'').replace(/</g,'&lt;').replace(/"/g,'&quot;');
      const isEmpty = !(row.translations[l]||'').trim();
      return `<td class="tl tl-cell cell-nav${isEmpty ? ' tl-missing' : ''}" data-r="${ri}" data-c="${ci}">
        <div class="tl-inner">
          <textarea rows="1" readonly
            onfocus="switchAndHL(${ri},'${l}')"
            oninput="autoH(this);setCellV(${ri},'${l}',this.value);sendHL(${ri},'${l}')"
          >${v}</textarea>
          ${cellCommentBtn(ri, l, row)}
        </div>
      </td>`;
    }).join('');
    const mismatch = row._textMismatch;
    const mismatchTitle = mismatch ? `HTML: "${String(mismatch.htmlSrc).replace(/"/g,'&quot;').slice(0,150)}" — CSV said: "${String(mismatch.csvSrc).replace(/"/g,'&quot;').slice(0,150)}"` : '';
    const warnBadge = mismatch
      ? `<span class="text-warn-badge" id="warnBadge-${ri}" title="${mismatchTitle}" onclick="event.stopPropagation();ackTextMismatch(${ri})">⚠</span>`
      : '';
    // Marcador VML na coluna Origin: quando o trecho é o label de uma forma VML (fallback
    // Outlook, ex: botão <v:roundrect>), mostra a tag ali pra quem edita saber que é VML.
    const vmlBadge = row.vmlTag
      ? `<span class="vml-badge" title="Este trecho está dentro de uma forma VML (fallback Outlook): &lt;${escHtml(row.vmlTag)}&gt;">VML: ${escHtml(row.vmlTag)}</span>`
      : '';
    // Imagem adicionada DEPOIS que o projeto já tinha aprovação: a aprovação foi mantida (regra
    // silenciosa), mas o item fica marcado como "novo — revisar" até uma nova aprovação.
    const pendingBadge = cfg.pendingImgIds.includes(id)
      ? `<span class="vml-badge" style="background:#fff3cd;border-color:#ffe08a;color:#8a6d3b;" title="Image added after the project was already approved. The existing approval was kept, but this item came in later and needs review.">⏳ new — review</span>`
      : '';
    return `<tr>
      <td class="rn" style="width:22px!important;max-width:22px!important">${ri+1}</td>
      <td class="cid" style="width:38px!important;max-width:38px!important">${id}</td>
      <td class="src" onclick="highlightFromTable(${ri},'${origLang||''}')">${warnBadge}${vmlBadge}${pendingBadge}<textarea rows="1" readonly style="${row.isLiquidFull ? 'color:var(--text3);font-size:10.5px;' : ''}cursor:default;">${displaySrc}</textarea></td>
      ${tls}
      <td class="del"><button onclick="event.stopPropagation();delRow(${ri})">×</button></td>
    </tr>`;
  }).join('');
}

