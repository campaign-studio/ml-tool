/* ═══════════════════════════════════════════════════════════════════════════
   TESTE DE REGRESSÃO — invariantes do MERGE concorrente
   ───────────────────────────────────────────────────────────────────────────
   Este projeto não tem test runner (os testes são manuais no console). Este
   arquivo é um teste executável NO NAVEGADOR, contra o app rodando, que trava
   as duas invariantes de merge que já quebraram / poderiam quebrar:

   A) AVULSO (mergeLooseData): linha de CSV deletada NÃO ressuscita quando há
      tombstone (data.deletedRowIds) mais novo que a versão do outro lado; e a
      anti-perda de add concorrente continua valendo.
   B) CAMPANHA (mergeItemRows / mergeCampaignItems): as rows de um item são
      IMUTÁVEIS — o merge é por-célula sobre o conjunto de rows do vencedor, e
      uma row que só existe no lado mais antigo é DROPADA (não ressuscitada);
      item inteiro deletado respeita o tombstone deletedItemIds.

   COMO RODAR:
     1. Abra o app (localhost:3000 ou o Pages). Não precisa estar logado.
     2. No console do navegador, cole o conteúdo deste arquivo E chame:
            runMergeInvariantTests()
        (ou carregue o arquivo e chame a função).
     Retorna {passed, failed, results} e imprime uma tabela. failed===0 = OK.

   Usa só funções globais do app (mergeLooseData, mergeItemRows,
   mergeCampaignItems, _rowsFromSaveCsv, _buildSaveCsvFrom, unionDeletedItemIds)
   e dados sintéticos — NÃO toca no banco nem no estado do app.
   ═══════════════════════════════════════════════════════════════════════════ */
function runMergeInvariantTests() {
  const results = [];
  const T = (name, fn) => {
    try { const ok = fn(); results.push({ teste: name, PASS: !!ok }); }
    catch (e) { results.push({ teste: name, PASS: false, erro: String(e && e.message || e) }); }
  };
  const need = ['mergeLooseData','mergeItemRows','mergeCampaignItems','_rowsFromSaveCsv','_buildSaveCsvFrom','unionDeletedItemIds'];
  const missing = need.filter(f => typeof window[f] !== 'function');
  if (missing.length) { console.error('Funções ausentes (abra o app):', missing); return { passed:0, failed:1, results:[{teste:'setup', PASS:false, erro:'faltam '+missing.join(',')}] }; }

  // ---- helpers avulso -------------------------------------------------------
  const LANGS = ['pt-BR','de-DE'];
  const mkRowsById = (ids) => { const m = new Map(); ids.forEach(id => m.set(id, { id, src: id+'-src', tls: Object.fromEntries(LANGS.map(l => [l, id+'-'+l])) })); return m; };
  const baseCsv = (ids) => _buildSaveCsvFrom('T', LANGS, mkRowsById(ids), [...ids]);
  const csvWithout = (csv, id) => csv.split('\n').filter(l => !new RegExp('^'+id+',').test(l)).join('\n');
  const has = (csv, id) => _rowsFromSaveCsv(csv).rowsById.has(id);
  const mkLoose = (csv, upd, extra) => ({ id:'p_T', updatedAt: upd, data: Object.assign({ html:'<p>x</p>', csv }, extra || {}) });

  const FULL = baseCsv(['id1','id2','id3']);

  // A1 — ressurreição bloqueada por tombstone (novo deletou; velho ainda tem)
  T('A1 avulso: tombstone bloqueia ressurreição', () => {
    const a = mkLoose(csvWithout(FULL,'id2'), 2000, { deletedRowIds:[{ id:'id2', at:2000 }] });
    const b = mkLoose(FULL, 1000);
    const m = mergeLooseData(a, b, null);
    return m && !has(m.csv,'id2') && (m.deletedRowIds||[]).some(d => d.id==='id2');
  });
  // A2 — SEM tombstone: comportamento antigo (anti-perda: linha fica)
  T('A2 avulso: sem tombstone mantém a linha (anti-perda)', () => {
    const a = mkLoose(csvWithout(FULL,'id2'), 2000);
    const b = mkLoose(FULL, 1000);
    const m = mergeLooseData(a, b, null);
    return m && has(m.csv,'id2');
  });
  // A3 — add concorrente dos dois lados: ambos sobrevivem
  T('A3 avulso: add concorrente preserva os dois', () => {
    const aCsv = _buildSaveCsvFrom('T', LANGS, mkRowsById(['id1','id2','id3','id90']), ['id1','id2','id3','id90']);
    const bCsv = _buildSaveCsvFrom('T', LANGS, mkRowsById(['id1','id2','id3','id91']), ['id1','id2','id3','id91']);
    const m = mergeLooseData(mkLoose(aCsv,2000), mkLoose(bCsv,1000), null);
    return m && has(m.csv,'id90') && has(m.csv,'id91');
  });
  // A4 — deleção ANTIGA não vence re-add mais novo (novo ainda tem a linha)
  T('A4 avulso: deleção antiga não vence', () => {
    const a = mkLoose(FULL, 2000); // novo AINDA tem id2
    const b = mkLoose(csvWithout(FULL,'id2'), 1000, { deletedRowIds:[{ id:'id2', at:1500 }] }); // velho deletou antes
    const m = mergeLooseData(a, b, null);
    return m && has(m.csv,'id2');
  });

  // ---- helpers campanha -----------------------------------------------------
  const mkItem = (id, upd, rows) => ({
    id, updatedAt: upd, rows, langs: LANGS.slice(), clearedCells: [],
    approvalComments: [], approvalActivity: [], approvalDoneByLang: {}, approvalDeletedIds: []
  });

  // B1 — mergeItemRows: rows imutáveis (só-no-velho é DROPADA), célula funde os dois lados
  T('B1 campanha: rows imutáveis + célula funde (extra do velho é dropada)', () => {
    const winner = mkItem('it1', 2000, [
      { id:'r1', src:'A', translations:{ 'pt-BR':'a-pt' } },
      { id:'r2', src:'B', translations:{} },
    ]);
    const older = mkItem('it1', 1000, [
      { id:'r1', src:'A', translations:{ 'de-DE':'a-de' } },
      { id:'r2', src:'B', translations:{} },
      { id:'rX', src:'X', translations:{ 'pt-BR':'x-pt' } }, // só no velho
    ]);
    const merged = mergeItemRows(winner, older);
    const ids = merged.map(r => r.id);
    const r1 = merged.find(r => r.id==='r1');
    const rXausente = !ids.includes('rX');
    const idsSaoDoVencedor = ids.length===2 && ids.includes('r1') && ids.includes('r2');
    const celulaFundiuOsDois = r1 && r1.translations['pt-BR']==='a-pt' && r1.translations['de-DE']==='a-de';
    return rXausente && idsSaoDoVencedor && celulaFundiuOsDois;
  });
  // B2 — mergeCampaignItems: item deletado respeita tombstone deletedItemIds
  T('B2 campanha: item deletado não ressuscita (deletedItemIds)', () => {
    const a = { kind:'campaign', updatedAt:2000, items:[ mkItem('itKeep',2000,[{id:'r1',src:'A',translations:{}}]) ], deletedItemIds:[{ id:'itDel', at:2000 }] };
    const b = { kind:'campaign', updatedAt:1000, items:[ mkItem('itKeep',1000,[{id:'r1',src:'A',translations:{}}]), mkItem('itDel',1000,[{id:'r9',src:'D',translations:{}}]) ], deletedItemIds:[] };
    const out = mergeCampaignItems(a, b);
    const ids = out.map(it => it.id);
    return ids.includes('itKeep') && !ids.includes('itDel');
  });
  // B3 — mergeCampaignItems: item novo só num lado é preservado (anti-perda de item)
  T('B3 campanha: item novo de um lado é preservado', () => {
    const a = { kind:'campaign', updatedAt:2000, items:[ mkItem('it1',2000,[{id:'r1',src:'A',translations:{}}]), mkItem('itNovoA',2000,[{id:'r2',src:'B',translations:{}}]) ], deletedItemIds:[] };
    const b = { kind:'campaign', updatedAt:1000, items:[ mkItem('it1',1000,[{id:'r1',src:'A',translations:{}}]) ], deletedItemIds:[] };
    const out = mergeCampaignItems(a, b);
    return out.map(it => it.id).includes('itNovoA');
  });

  const passed = results.filter(r => r.PASS).length;
  const failed = results.length - passed;
  console.table(results);
  console.log(`Merge invariants: ${passed} PASS / ${failed} FAIL`);
  return { passed, failed, results };
}
if (typeof window !== 'undefined') window.runMergeInvariantTests = runMergeInvariantTests;
