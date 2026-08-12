# save-user — como ativar (B-full, 1º incremento)

Servidor-no-meio pra escrita de usuário. **Você faz 1 vez** (precisa da CLI do Supabase logada);
o resto (código do app) já está pronto atrás do flag `_USE_SAVE_API`.

## Passos

1. **Instalar/logar a CLI** (se ainda não tiver):
   ```bash
   brew install supabase/tap/supabase      # ou veja supabase.com/docs/guides/cli
   supabase login
   supabase link --project-ref <SEU_PROJECT_REF>   # o ref está na URL do painel do Supabase
   ```

2. **Deploy da função** (a service_role é injetada automaticamente — não precisa colar chave):
   ```bash
   supabase functions deploy save-user
   ```

3. **Ligar no app**: em `index.html`, troque `let _USE_SAVE_API = false;` → `true;` e recarregue.
   (Enquanto estiver `false`, ou se a função não responder, o app usa o RPC `save_user` já ativo,
   e abaixo dele o caminho antigo — nada quebra.)

## Como testar (a gente faz junto)
- No app, entre em Members e faça uma troca de papel/departamento de teste → deve salvar normal.
- No painel do Supabase → Edge Functions → save-user → Logs: deve aparecer a invocação.
- Conflito (CAS) já foi validado no RPC equivalente; a função usa a mesma trava.

## Rollback
- É só voltar `_USE_SAVE_API = false` (recarrega e volta pro caminho atual na hora). A função pode
  ficar deployada sem uso, ou `supabase functions delete save-user`.

## Segurança (fase atual)
- A função exige o header Authorization (a anon key que o app já manda) — não fica aberta.
- Autenticação FORTE de verdade (o servidor validar QUEM é o chamador) é o próximo passo, separado
  (decisão "reliability agora, auth depois").
