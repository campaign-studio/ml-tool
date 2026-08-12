# save-project — como ativar (B-full, 2º incremento)

Servidor-no-meio pra escrita de PROJETO (o caminho mais crítico — traduções). Código do app já
pronto atrás do MESMO flag `_USE_SAVE_API` que liga o save-user.

## Passos (você, 1x — CLI do Supabase logada)
```bash
supabase functions deploy save-project      # (deploy save-user também, se ainda não fez)
```
Depois, no app: `index.html` → `_USE_SAVE_API = true;` → recarregue.
(A service_role é injetada automaticamente. Enquanto `false`, o app grava projeto pelo caminho atual
— CAS direto no rev — INALTERADO.)

## Como testar (a gente faz junto, com cuidado no caminho de traduções)
1. Deploy das DUAS funções (save-user + save-project) e ligue o flag.
2. Faça uma edição pequena de tradução num projeto de teste → salve.
3. Supabase → Edge Functions → save-project → Logs: deve aparecer a invocação e `ok:true`.
4. Abra em duas abas e edite ao mesmo tempo → o CAS deve resolver sem perder conteúdo (o merge
   continua no cliente; a função só garante a gravação atômica).

## Rollback (imediato)
`_USE_SAVE_API = false` → recarrega e volta pro CAS direto na hora. Nenhum dado muda de formato
(o `rev` já existe e é o mesmo usado hoje).

## Segurança (fase atual)
Exige Authorization (anon key que o app já manda). Auth forte de verdade = próximo passo, separado.
```
