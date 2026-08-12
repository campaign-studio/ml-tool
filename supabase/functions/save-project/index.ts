// ═══════════════════════════════════════════════════════════════════════════
// B-full (2º incremento) — SERVIDOR NO MEIO pra escrita de PROJETO.
// ───────────────────────────────────────────────────────────────────────────
// O navegador para de gravar projeto DIRETO no banco: chama esta função, que roda
// no Supabase, é dona da escrita (service_role) e faz o compare-and-swap ATÔMICO
// no rev. É uma trava fina: o MERGE por-célula continua no cliente (mergeTwoProjects,
// já testado à exaustão) — o cliente lê o remoto fresco, mescla e manda { id, payload,
// expected_rev }; a função grava só se o rev remoto ainda for o esperado. Em conflito,
// devolve data:[] e o cliente (casWriteProject) re-lê, re-mescla e re-tenta — MESMO
// fluxo de hoje, só que a escrita passa a ser dona do servidor.
//
// DEPLOY (você, 1x — CLI do Supabase logada):
//   supabase functions deploy save-project
// Depois, no app: _USE_SAVE_API = true (o mesmo flag do save-user liga os dois).
// A service_role é injetada automaticamente pelas Edge Functions — não precisa colar chave.
//
// Segurança (fase "reliability agora"): exige Authorization (a anon key que o app já manda).
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!req.headers.get("authorization")) return json({ error: "missing authorization" }, 401);

  let body: { id?: string; payload?: Record<string, unknown>; expected_rev?: number };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const id = (body.id || "").trim();
  const payload = body.payload;
  const expected = Number(body.expected_rev);
  if (!id || !payload || typeof payload !== "object" || !Number.isFinite(expected)) {
    return json({ error: "id, payload and expected_rev required" }, 400);
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const nowIso = new Date().toISOString();

  // Linha nova (expected_rev === 0 e não existe): insere com rev 0.
  if (expected === 0) {
    const { data: exists } = await supa.from("projects").select("id").eq("id", id).maybeSingle();
    if (!exists) {
      const { error: insErr } = await supa.from("projects")
        .insert({ id, payload, rev: 0, updated_at: nowIso });
      // corrida: se alguém inseriu no meio, cai no update abaixo
      if (!insErr) return json({ ok: true, rev: 0 });
    }
  }

  // CAS atômico: grava só se o rev remoto ainda for o esperado.
  const { data: upd, error: updErr } = await supa.from("projects")
    .update({ payload, rev: expected + 1, updated_at: nowIso })
    .eq("id", id).eq("rev", expected).select("rev");
  if (updErr) return json({ error: "update: " + updErr.message }, 500);

  if (upd && upd.length) return json({ ok: true, rev: (upd[0] as any).rev });

  // Conflito: rev mudou entre o read do cliente e este write. Devolve o remoto atual
  // pra ajudar o cliente a re-mesclar (ele re-lê de qualquer forma). data vazio => cliente re-tenta.
  const { data: cur } = await supa.from("projects").select("payload,rev").eq("id", id).maybeSingle();
  return json({ ok: false, conflict: true, rev: cur ? (cur as any).rev : null, payload: cur ? (cur as any).payload : null });
});
