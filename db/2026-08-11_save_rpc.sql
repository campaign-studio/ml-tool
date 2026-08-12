-- ═══════════════════════════════════════════════════════════════════════════
-- MULTILANGUAGE TOOL — B-lite: escrita ATÔMICA no servidor (compare-and-swap)
-- ───────────────────────────────────────────────────────────────────────────
-- POR QUÊ: hoje o navegador fala DIRETO com o banco. Projetos já têm CAS atômico
-- (update ... where rev = esperado). A tabela `users` NÃO tinha coluna rev, então
-- a proteção era por carimbo (userUpdatedAt). Esta migração dá à `users` o MESMO
-- CAS atômico dos projetos, via uma função no Postgres — sem servidor novo, sem
-- CLI, sem chave de serviço exposta (a função roda no banco; RLS cuida da permissão).
--
-- COMO APLICAR (uma vez):
--   Supabase → SQL Editor → cole este arquivo inteiro → Run.
-- Depois, no app, ligue o flag `_USE_SAVE_RPC = true` (index.html) e recarregue.
-- Enquanto o flag estiver false OU a função não existir, o app usa o caminho atual
-- (nada quebra).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Coluna rev na tabela users (default 0; idempotente).
alter table public.users add column if not exists rev integer not null default 0;

-- 2) save_user: CAS atômico. Só grava se o rev remoto ainda for o esperado.
--    Retorna a nova rev em caso de sucesso; 0 linhas = conflito (o cliente re-lê,
--    re-mescla e re-tenta — mesma lógica do casWriteProject dos projetos).
create or replace function public.save_user(
  p_email        text,
  p_payload      jsonb,
  p_expected_rev integer
) returns table(rev integer)
language plpgsql
security invoker            -- respeita a RLS de quem chamou (não eleva privilégio)
as $$
begin
  return query
  update public.users u
     set payload = p_payload,
         rev     = u.rev + 1
   where u.email = p_email
     and u.rev   = p_expected_rev
  returning u.rev;
end;
$$;

-- 3) (OPCIONAL) save_project: os projetos JÁ fazem CAS atômico direto no update
--    (.eq('rev', esperado)), então esta função é só conveniência/uniformidade —
--    NÃO é necessária pra corrigir nada. Deixada comentada de propósito.
-- create or replace function public.save_project(
--   p_id text, p_payload jsonb, p_expected_rev integer
-- ) returns table(rev integer)
-- language plpgsql security invoker as $$
-- begin
--   return query
--   update public.projects p
--      set payload = p_payload, rev = p.rev + 1
--    where p.id = p_id and p.rev = p_expected_rev
--   returning p.rev;
-- end; $$;

-- Verificação rápida (opcional): deve retornar 1 linha com a função.
-- select proname from pg_proc where proname = 'save_user';
