-- Multilanguage Tool — migração 2026-08-04
-- Correção robusta do incidente de colaboração simultânea: garante que projects.updated_at
-- SEMPRE avance no relógio do SERVIDOR a cada UPDATE (o DEFAULT now() só valia no INSERT).
-- Assim o pull incremental (.gt('updated_at', cursor)) usa um único relógio confiável,
-- independente do relógio de cada navegador que salva.
--
-- Rodar UMA vez no Supabase (SQL Editor). Idempotente.

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_projects_set_updated_at on projects;
create trigger trg_projects_set_updated_at
  before update on projects
  for each row
  execute function set_updated_at();

-- (opcional, mas recomendado) mesmo trigger para users, caso um dia o pull de users
-- também vire incremental:
-- drop trigger if exists trg_users_set_updated_at on users;
-- create trigger trg_users_set_updated_at
--   before update on users
--   for each row
--   execute function set_updated_at();

-- Desbloqueio imediato: normaliza os updated_at congelados para agora, para que os clientes
-- já ativos re-sincronizem na próxima janela de pull (roda só uma vez, junto da migração):
-- update projects set updated_at = now();
