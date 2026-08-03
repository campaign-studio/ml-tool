# Boas práticas para montar o HTML do e-mail

Guia rápido pra quem cria os templates que entram na **Multilanguage Tool**. Seguindo isto, o
tagueador acerta a posição das traduções sozinho e o previewer sempre reflete a edição.

> **Regra de ouro:** o que é texto pra traduzir deve estar no **corpo renderizado** — e nada mais
> deve *parecer* texto (comentário, nota, fragmento solto).

---

## Checklist rápido

- [ ] **Comentário HTML só com rótulo neutro** — nunca repetindo texto real do e-mail.
- [ ] **Todo texto traduzível existe no corpo visível** (não só num comentário/nota).
- [ ] **Sem fragmentos curtos** (1–3 caracteres / palavras soltas) como segmento próprio.
- [ ] **Frase inteira num nó só** — não picar no meio com `<br>`/`<span>`/`<b>`.
- [ ] **Evitar frases idênticas repetidas** sem contexto próprio.
- [ ] **Fallback VML do Outlook** (`<!--[if mso]>`) pode ficar como está.
- [ ] **Upload do HTML original, sem tags** `{%translation%}`.
- [ ] **Conferir no previewer logo após importar** (toda linha muda ao editar?).

---

## Detalhe de cada item

### 1. Comentário HTML só com rótulo neutro
Comentário que **repete** uma frase real confunde o posicionador — a tag de tradução acaba caindo
dentro do `<!-- -->` (que o navegador não renderiza) e a linha "não muda no previewer".

- ❌ `<!-- ===== SECTION: Not a gym person? / Why Wellhub? ===== -->`
- ✅ `<!-- SECTION 1 -->`  ·  `<!-- hero / cta / footer -->`

### 2. Todo texto traduzível existe no corpo visível
Se uma frase deve aparecer no e-mail, ela precisa estar num elemento real (`<td>`, `<p>`, `<span>`…).
Texto que só existe num comentário vira **linha fantasma** (não-posicionável).

### 3. Sem fragmentos curtos como segmento próprio
Trechos de 1–3 caracteres casam como substring dentro de atributos (ex.: `"or"` casa em
`cr`**`or`**`igin`, `b`**`or`**`der`). Mantenha **frases inteiras** como unidade de tradução.

### 4. Frase inteira num nó só
Texto picado atrapalha o casamento posicional.

- ⚠️ `Não sabe por <br> onde começar?`  ·  `Comece <span>agora</span> mesmo`
- ✅ manter a frase contínua; usar negrito/quebra sem partir a frase em vários nós quando der.

### 5. Evitar frases idênticas repetidas
Se a **mesma** frase aparece várias vezes, o posicionador precisa adivinhar qual é qual. Dê contexto
próprio a cada instância, ou lembre que a ordem no CSV segue a ordem no HTML.

### 6. Fallback VML do Outlook é normal
Imagens dentro de `<!--[if mso]> … <![endif]-->` **legitimamente** duplicam o id (versão Outlook +
versão moderna). É esperado, não é erro. Só não misture comentário **comum** com conteúdo real (item 1).

### 7. Upload do HTML original, sem tags
A ferramenta taguea sozinha. HTML que **já tem** `{%translation%}` é recusado — parta sempre do HTML
limpo exportado da build.

### 8. Conferir no previewer logo após importar
Passe o olho assim que criar o projeto: se alguma linha **não muda** ao trocar de idioma / editar,
quase sempre é um destes casos (texto em comentário, fragmento curto, frase partida). É o sinal pra
ajustar o HTML de origem antes de seguir.

---

_Em uma frase:_ **comentário só pra rótulo neutro, frase inteira como unidade, e todo texto que
deve aparecer tem que estar no corpo renderizado.**
