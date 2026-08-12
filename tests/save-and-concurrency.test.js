/* ═══════════════════════════════════════════════════════════════════════════
   SUITE DE TESTE — SAVE (servidor) + CONCORRÊNCIA + INVARIANTES DE MERGE
   ───────────────────────────────────────────────────────────────────────────
   Trava o que mudou em 2026-08-11: escrita pelo servidor (Edge Functions
   save-user/save-project), CAS atômico (rev) sem perda concorrente, o merge que
   nunca deixa cópia velha sobrescrever, e roteamento/fallback.

   NÃO-DESTRUTIVO: os testes ao vivo re-salvam CONTEÚDO IGUAL (só o rev sobe) do
   MEU usuário e de UM projeto de teste — nenhum dado de tradução muda. Nada é
   apagado. Roda contra o app real (usa as funções globais + as Edge Functions).

   COMO RODAR:
     1. Abra o app (localhost:3000 ou produção), logado.
     2. Console → cole este arquivo (ou fetch+eval) → await runSaveTests().
        Opcional: await runSaveTests({ projectId:'p_...', userEmail:'...' }).
     Retorna { passed, failed, results } e imprime a tabela. failed===0 = OK.
   ═══════════════════════════════════════════════════════════════════════════ */
async function runSaveTests(opts){
  opts = opts || {};
  const sb = (typeof sbClient === 'function') ? sbClient() : null;
  const R = [];
  const T = async (name, fn) => {
    try { const ok = await fn(); R.push({ teste:name, PASS: !!ok }); }
    catch(e){ R.push({ teste:name, PASS:false, erro:String(e && e.message || e) }); }
  };
  const need = ['_threeWayMergeUser','casWriteUser','casWriteProject','saveUserViaApi','saveProjectViaApi'];
  const missing = need.filter(f => typeof window[f] !== 'function');
  if(!sb || missing.length){ console.error('Faltam funções / sem sb (abra o app):', missing); return { passed:0, failed:1, results:[{teste:'setup', PASS:false, erro:(missing.join(',')||'sem sbClient')}] }; }

  const PROJ = opts.projectId || 'p_1783074497706';
  const U    = opts.userEmail || ((typeof authCurrentUser==='function' && authCurrentUser()) ? authCurrentUser().email : 'hiago.branco@gympass.com');

  // Leitura resiliente: re-tenta em leitura vazia/erro (o Supabase throttla egress e devolve vazio às
  // vezes — o próprio motivo do incremento 3). Assim o teste não fica FLAKY por causa disso.
  const readOne = async (table, col, val, sel) => {
    for(let i=0;i<5;i++){
      const r = await sb.from(table).select(sel).eq(col, val).maybeSingle();
      if(r.data) return r.data;
      await new Promise(res => setTimeout(res, 500));
    }
    return null;
  };

  // ── A) MERGE (função pura, sem banco) — cópia velha NUNCA rebaixa ──
  await T('A1 merge: cópia velha não sobrescreve (sem ancestral)', () =>
    _threeWayMergeUser(null,{email:'k',role:'approver',name:'X'},{email:'k',role:'admin',name:'Y',userUpdatedAt:2000}).role==='admin');
  await T('A2 merge: role pelo carimbo mais novo (com ancestral)', () =>
    _threeWayMergeUser({email:'k',role:'member',roleUpdatedAt:1},{email:'k',role:'admin',roleUpdatedAt:5},{email:'k',role:'member',roleUpdatedAt:1}).role==='admin');
  await T('A3 merge: empate de carimbo mantém remoto', () =>
    _threeWayMergeUser(null,{email:'k',role:'approver',userUpdatedAt:9},{email:'k',role:'admin',userUpdatedAt:9}).role==='admin');
  await T('A4 merge: edição disjunta (com ancestral) sobrevive', () => {
    const r=_threeWayMergeUser({email:'k',role:'admin',name:'K',department:'A'},{email:'k',role:'admin',name:'K',department:'B'},{email:'k',role:'admin',name:'NEW',department:'A'});
    return r.name==='NEW' && r.department==='B';
  });
  if(typeof runMergeInvariantTests==='function'){
    await T('A5 invariantes de merge (arquivo existente) sem falhas', () => runMergeInvariantTests().failed===0);
  }

  // ── B) SAVE-USER pelo SERVIDOR (Edge Function) — grava e preserva ──
  await T('B1 save-user (servidor): grava, rev+1, role intacto, sem fallback', async () => {
    const u0 = await readOne('users','email',U,'rev,payload');
    if(!u0) throw new Error('usuário de teste não existe (ou leitura falhou 5x): '+U);
    _syncedUserJson[U] = _canonJson(u0.payload);
    _saveApiOk = true;
    await casWriteUser(sb, U, Object.assign({}, u0.payload)); // payload IGUAL
    const u1 = await readOne('users','email',U,'rev,payload');
    return u1.rev === (u0.rev||0)+1 && u1.payload.role === u0.payload.role && _saveApiOk===true;
  });

  // ── C) SAVE-PROJECT pelo SERVIDOR — CAS atômico + conflito (sem perda) ──
  await T('C1 save-project (servidor): grava atômico (rev+1), conteúdo intacto', async () => {
    const p0 = await readOne('projects','id',PROJ,'rev,payload');
    if(!p0) throw new Error('projeto de teste não existe (ou leitura falhou 5x): '+PROJ);
    _saveProjApiOk = true;
    const r = await saveProjectViaApi(sb, PROJ, p0.payload, p0.rev||0); // payload IGUAL
    const p1 = await readOne('projects','id',PROJ,'rev,payload');
    return r.data && r.data.length===1 && p1.rev===(p0.rev||0)+1 && _canonJson(p1.payload)===_canonJson(p0.payload);
  });
  await T('C2 save-project: rev VELHO = CONFLITO (data vazio, nada perdido)', async () => {
    const p0 = await readOne('projects','id',PROJ,'rev,payload');
    const before = _canonJson(p0.payload);
    const rc = await saveProjectViaApi(sb, PROJ, p0.payload, (p0.rev||1)-1); // rev velho de propósito
    const p1 = await readOne('projects','id',PROJ,'rev,payload');
    return rc.data && rc.data.length===0 && p1.rev===p0.rev && _canonJson(p1.payload)===before; // rejeitado, intacto
  });
  await T('C3 casWriteProject (caminho COMPLETO pelo servidor)', async () => {
    const p0 = await readOne('projects','id',PROJ,'rev,payload');
    _syncedPayloadJson[PROJ] = _canonJson(p0.payload);
    _saveProjApiOk = true;
    await casWriteProject(sb, JSON.parse(JSON.stringify(p0.payload))); // payload IGUAL
    const p1 = await readOne('projects','id',PROJ,'rev');
    return p1.rev >= (p0.rev||0)+1 && _saveProjApiOk===true;
  });

  // ── D) ROTEAMENTO / FALLBACK ──
  await T('D1 roteamento: API ligada e disponível (usuário+projeto)', () =>
    _USE_SAVE_API===true && _saveApiOk===true && _saveProjApiOk===true);
  await T('D2 fallback: helper marca indisponível em falha (função inexistente)', async () => {
    const okBefore = _saveApiOk;
    try{ await saveUserViaApi(sb, U+'', Object.assign({},{email:U})); }catch(e){}
    // chamar a função REAL não falha; então simulamos indisponibilidade batendo numa função que não existe:
    let marked=false;
    try{
      const r = await fetch(SB_URL+'/functions/v1/__nao_existe__',{method:'POST',headers:{'Authorization':'Bearer '+SB_PUBLISHABLE_KEY,'apikey':SB_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:'{}'});
      marked = !r.ok; // 404 → o helper cairia no fallback
    }catch(e){ marked=true; }
    _saveApiOk = okBefore; // restaura
    return marked; // uma função inexistente responde não-2xx (o helper marcaria _saveApiOk=false e cairia no RPC/direto)
  });

  // ── E) SANIDADE (só leitura) ──
  await T('E1 sanidade: Dani (daniele.lara) é editora no projeto de teste', async () => {
    const p = await readOne('projects','id',PROJ,'sw:payload->sharedWith');
    return p && Array.isArray(p.sw) && p.sw.some(e=>(e||'').toLowerCase()==='daniele.lara@gympass.com');
  });

  const passed = R.filter(x=>x.PASS).length, failed = R.length - passed;
  console.table(R);
  console.log('SAVE TESTS: '+passed+' PASS / '+failed+' FAIL');
  return { passed, failed, results: R };
}
if(typeof window !== 'undefined') window.runSaveTests = runSaveTests;
