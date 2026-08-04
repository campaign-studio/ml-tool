-- Multilanguage Tool — migração 2026-08-04
-- Fase 2 da reconstrução do save: optimistic locking (compare-and-swap) por linha de projeto.
-- Adiciona projects.rev: todo save vira UPDATE ... WHERE rev = <esperado>; se outra pessoa
-- gravou no meio, o WHERE (atômico no Postgres) não casa, o cliente re-lê + re-mescla + re-tenta.
--
-- Rodar UMA vez no Supabase (SQL Editor). Idempotente. Seguro rodar com clientes já usando a
-- versão nova: enquanto a coluna não existir, o app cai no upsert em massa antigo (_casDisabled).

alter table projects add column if not exists rev integer not null default 0;

-- Nada mais é necessário: o incremento do rev é feito pelo cliente no UPDATE (rev = esperado+1)
-- e a exclusividade vem do WHERE rev = esperado. Não precisa de trigger.
