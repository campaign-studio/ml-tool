-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- presence_diag — telemetria de PRESENÇA AO VIVO.
--
-- Para que serve: quando alguém reclama que "não aparece o nome do colega", esta tabela responde
-- sem precisar pedir para ninguém abrir o console. Cada cliente grava o próprio estado a cada 90s
-- enquanto está com um editor aberto: em qual projeto está, qual projeto ANUNCIOU na presença,
-- estado do canal, há quantos segundos foi o último anúncio, se o navegador tem o código novo, e
-- quem ele está enxergando.
--
-- Volume: 1 linha / 90s / pessoa, só com editor aberto. Com 8 pessoas = ~0,09 escritas/s e
-- ~320 linhas/hora. Linha minúscula (sem payload de projeto).
--
-- Como rodar: Supabase Dashboard -> SQL Editor -> cole tudo -> Run.
-- Enquanto a tabela não existir, o app detecta (42P01/PGRST205), desliga a telemetria na sessão
-- e segue funcionando normalmente — nada quebra.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.presence_diag (
  id                bigserial primary key,
  at                timestamptz not null default now(),
  email             text,
  project_open      text,          -- projeto que a pessoa tem aberto na tela
  project_announced text,          -- projeto que ela ANUNCIOU na presença (se diferir, é o bug)
  channel_state     text,          -- joined / closed / ...
  secs_since_track  int,           -- segundos desde o último anúncio (heartbeat = 20s)
  has_new_code      boolean,       -- false = navegador com cache velho
  peers             jsonb,         -- quem ela está enxergando
  ua                text
);

create index if not exists presence_diag_at_idx      on public.presence_diag (at desc);
create index if not exists presence_diag_project_idx on public.presence_diag (project_open, at desc);

-- O app é 100% cliente e usa a chave publishable (anon). Mesmo modelo das outras tabelas.
alter table public.presence_diag enable row level security;

drop policy if exists presence_diag_insert on public.presence_diag;
create policy presence_diag_insert on public.presence_diag for insert to anon, authenticated with check (true);

drop policy if exists presence_diag_select on public.presence_diag;
create policy presence_diag_select on public.presence_diag for select to anon, authenticated using (true);

drop policy if exists presence_diag_delete on public.presence_diag;
create policy presence_diag_delete on public.presence_diag for delete to anon, authenticated using (true);

-- Limpeza manual quando quiser (a tabela é pequena, mas não precisa guardar histórico):
--   delete from public.presence_diag where at < now() - interval '3 days';
