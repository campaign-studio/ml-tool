// ═══════════════════════════════════════════════════════════════════════════
// B-full (1º incremento) — SERVIDOR NO MEIO: escrita de USUÁRIO via Edge Function.
// ───────────────────────────────────────────────────────────────────────────
// O navegador NÃO fala mais direto com o banco pra salvar usuário: chama esta
// função, que roda no Supabase, é dona da escrita (service_role) e faz o
// compare-and-swap atômico (rev) + o merge server-side. Mesma regra do cliente
// (newest-wins por userUpdatedAt; role pelo roleUpdatedAt) — uma cópia velha
// NUNCA sobrescreve.
//
// Segurança (fase "reliability agora, auth depois"): a função exige o header
// Authorization (a anon key que o app já manda via supabase.functions.invoke),
// então não fica aberta a qualquer um — mesma postura de hoje. A autenticação
// forte de verdade (validar QUEM é o chamador) é o próximo passo, separado.
//
// DEPLOY (você, 1x — precisa da CLI do Supabase logada):
//   supabase functions deploy save-user
// (A service_role já é injetada automaticamente pelo Supabase nas Edge Functions
//  como SUPABASE_SERVICE_ROLE_KEY — não precisa colar chave nenhuma.)
// Depois, no app: _USE_SAVE_API = true; recarregue.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const isDup = (e: { code?: string; message?: string } | null) =>
  !!e && (String(e.code) === "23505" || /duplicate key/i.test(e.message || ""));

// Merge de UM registro de usuário — MESMA regra do cliente (ramo "sem ancestral": newest-wins do
// registro inteiro por userUpdatedAt; role sempre pelo roleUpdatedAt mais novo). O servidor não tem
// o ancestral (baseline) do cliente, então usa este ramo conservador: cópia velha não sobrescreve nada.
function mergeUser(mine: Record<string, unknown>, remote: Record<string, unknown> | null) {
  if (!remote) return mine;
  const mt = Number((mine as any)?.userUpdatedAt) || 0;
  const rt = Number((remote as any)?.userUpdatedAt) || 0;
  const out: Record<string, unknown> = mt > rt ? { ...remote, ...mine } : { ...remote };
  const mRt = Number((mine as any)?.roleUpdatedAt) || 0;
  const rRt = Number((remote as any)?.roleUpdatedAt) || 0;
  if (mine && "role" in mine && mRt > rRt) {
    out.role = (mine as any).role;
    out.roleUpdatedAt = mRt;
  } else {
    if ("role" in remote) out.role = (remote as any).role;
    if ("roleUpdatedAt" in remote) out.roleUpdatedAt = (remote as any).roleUpdatedAt;
  }
  const uMax = Math.max(mt, rt);
  if (uMax) out.userUpdatedAt = uMax;
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // Exige Authorization (anon key do app) — não deixa a função aberta a qualquer um.
  if (!req.headers.get("authorization")) return json({ error: "missing authorization" }, 401);

  let body: { email?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const email = (body.email || "").toLowerCase().trim();
  const payload = body.payload;
  if (!email || !payload || typeof payload !== "object") return json({ error: "email and payload required" }, 400);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // CAS atômico com re-tentativa em conflito (mesma lógica do casWriteProject dos projetos).
  for (let tries = 0; tries < 6; tries++) {
    const { data: cur, error: readErr } = await supa
      .from("users").select("payload,rev").eq("email", email).maybeSingle();
    if (readErr) return json({ error: "read: " + readErr.message }, 500);

    if (!cur) { // usuário novo → insere (rev default 0)
      const { error: insErr } = await supa.from("users").insert({ email, payload });
      if (insErr) { if (isDup(insErr)) continue; return json({ error: "insert: " + insErr.message }, 500); }
      return json({ ok: true, rev: 0, payload });
    }

    const expected = Number((cur as any).rev) || 0;
    const merged = mergeUser(payload, (cur as any).payload);
    const { data: upd, error: updErr } = await supa
      .from("users").update({ payload: merged, rev: expected + 1 })
      .eq("email", email).eq("rev", expected).select("rev");
    if (updErr) return json({ error: "update: " + updErr.message }, 500);
    if (upd && upd.length) return json({ ok: true, rev: (upd[0] as any).rev, payload: merged });
    // 0 linhas = rev mudou entre read e write → conflito → re-tenta
  }
  return json({ error: "too many conflicts" }, 409);
});
