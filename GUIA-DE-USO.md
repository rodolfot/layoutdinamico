# Guia de uso — passo a passo

> Para quem está abrindo o sistema pela primeira vez. Não precisa saber programar.

---

## O que é este sistema (em uma frase)

É um **cadastro cujos campos são configuráveis sem programação**: você adiciona, esconde,
reordena ou torna obrigatório qualquer campo pela própria tela — sem chamar a TI, sem parar o sistema.
Ele ainda **protege dados sensíveis** (CPF, e-mail, renda), **guarda o histórico** de tudo que muda e
**separa os dados por cliente** (cada empresa só vê os seus).

Pense nele como um "formulário que você mesmo molda", com segurança e rastreabilidade embutidas.

---

## Antes de começar

- **Endereço:** abra no navegador `http://localhost:3000`
- Você cairá na **tela de login**.
- **Usuários de demonstração** (cada um enxerga o sistema de um jeito):

| Usuário | Senha | O que pode fazer |
|---|---|---|
| `admin` | `admin123` | Tudo: cadastrar, editar layout, e **ver dados sensíveis sem máscara** |
| `editor` | `editor123` | Cadastrar e editar registros/campos, mas **vê dados sensíveis mascarados** |
| `viewer` | `viewer123` | Apenas **consultar** (tudo mascarado) |

> Dica: comece com `admin` para conhecer tudo. Depois entre como `viewer` para ver a diferença
> (o CPF aparece como `*******8901`).

---

## Passo 1 — Entrar

1. Na tela de login, deixe **Tenant** = `default`.
2. Digite **usuário** `admin` e **senha** `admin123`.
3. Clique **Entrar**.

Você será levado ao **Painel** (a página inicial). No canto superior direito aparece quem você é
(`admin@default`) e um link **sair**.

*(“Tenant” é o cliente/empresa. Neste exemplo há dois: `default` e `acme`. Cada um tem seus próprios
dados e seu próprio layout — um nunca vê o do outro.)*

---

## Passo 2 — O Painel (visão geral)

É o seu ponto de partida. Mostra, de relance:

- **Layout ativo** — qual conjunto de campos está valendo agora.
- **Indicadores** — quantos registros existem, quantas versões de layout, quantos **campos pendentes**
  (campos novos que chegaram e ainda precisam de configuração).
- **Atividade recente** — as últimas ações feitas no sistema (quem fez o quê).

No topo há a **barra de navegação** com os atalhos: Cadastro, Consulta, Governança, Versões,
Editor de campos e Auditoria. Vamos por eles.

---

## Passo 3 — Cadastrar um registro

Clique em **+ Cadastro**.

Repare: **o formulário não é fixo** — ele é montado automaticamente a partir da configuração de campos.
Se amanhã alguém adicionar um campo, ele aparece aqui sozinho.

1. Preencha os campos. Os que têm **∗** são **obrigatórios** (ex.: CPF, Nome).
2. Campos com **🔒** são **sensíveis** (serão protegidos na hora de exibir).
3. Alguns campos são **inteligentes**:
   - **Estado civil = Casado** faz aparecer o campo **Nome do cônjuge** (some se você trocar para Solteiro).
   - **Telefones** aceita **vários valores** separados por vírgula.
4. Clique **Salvar**.

Abaixo aparece a resposta do sistema. Se você tentar salvar sem um obrigatório, ele **avisa o erro**
em vez de gravar errado.

> Experimento rápido: preencha um campo que **não existe no formulário** (por exemplo, edite o exemplo
> para incluir algo). O sistema **aceita e guarda mesmo assim** — e esse campo vira um "pendente" para
> ser configurado depois (ver Passo 5). É isso que dá flexibilidade sem quebrar nada.

---

## Passo 4 — Consultar registros

Clique em **Consulta**.

1. À esquerda, a **lista de registros**. Clique em um para abrir.
2. À direita, os dados aparecem **organizados por seção**, exatamente como a configuração manda
   (ordem, rótulos, o que é visível).
3. **Proteção de dados (LGPD):** se você entrou como `admin`, vê os valores reais. Se entrar como
   `viewer`, o CPF/e-mail/renda aparecem **mascarados** (`*******8901`). Isso é controlado pelo seu
   perfil — não por um botão.
4. Abra **Histórico de alterações** para ver a linha do tempo do registro (criação, edições, exclusão),
   com quem fez e quando.

*(Excluir um registro é "exclusão lógica": ele some das listas, mas o histórico é preservado.)*

---

## Passo 5 — Adicionar um campo novo **sem programar** (Governança)

Esta é a ideia central do produto. Clique em **Governança**.

Quando um campo novo chega no sistema (por integração ou cadastro) e ainda não está configurado, ele
aparece aqui como **pendente**, mostrando quantas vezes já apareceu e um exemplo do valor.

Para cada pendente você decide:

- **Aprovar** — preencha rótulo, tipo, seção, ordem e as opções (visível, editável, obrigatório) e
  confirme. **Na hora**, o campo passa a aparecer no cadastro e na consulta.
- **Ignorar** — tira da fila (o dado que já chegou **não é apagado**, só deixa de ser sugerido).

> Ou seja: dá para **evoluir o formulário pela tela**, sem alterar banco nem publicar sistema.

---

## Passo 6 — Evoluir o layout com segurança (Versões)

Se a mudança for grande (vários campos, reorganização), o certo é fazer numa **versão de rascunho** e
só então publicar. Clique em **Versões**.

Fluxo recomendado:

1. **Criar** uma versão nova, marcando **clonar** a partir da ativa (ela nasce como **DRAFT/rascunho**).
2. Clicar em **editar campos** na linha do rascunho (vai para o Editor — Passo 7) e ajustar à vontade.
3. **Comparar** o rascunho com a versão ativa: o sistema mostra o que foi **adicionado / removido /
   alterado**.
4. Quando estiver satisfeito, **Ativar** o rascunho. Só então ele passa a valer para todos.

Os registros antigos continuam íntegros — cada um é lido com a versão de layout em que foi criado.

**Levar/trazer um layout entre ambientes** (ex.: de homologação para produção):
- **Exportar** baixa o layout como um arquivo.
- **Importar** cola esse arquivo e cria um rascunho. Antes de confirmar, o sistema faz um **preview** e
  **bloqueia conflitos perigosos** (ex.: um campo que mudaria de número para texto) — a não ser que você
  marque explicitamente "prosseguir mesmo com conflitos".

---

## Passo 7 — Editor de campos (dentro de um rascunho)

Clique em **Editor de campos** (ou no link "editar campos" de um rascunho, no Passo 6).

- Escolha uma versão **DRAFT** no seletor do topo. (Versões já ativas ficam **somente leitura** — para
  não mudar por engano o que está no ar.)
- Para cada campo você ajusta: **rótulo, tipo, seção, ordem** e as chaves **obrigatório / visível /
  editável / sensível** (e o estilo de máscara).
- Botão **Adicionar** cria um campo novo; **Salvar** grava a linha; **x** remove.

Quando terminar, volte em **Versões** e **ative** o rascunho.

---

## Passo 8 — Auditoria (quem fez o quê)

Clique em **Auditoria**.

Uma trilha de tudo que aconteceu: criação/edição/exclusão de registros, aprovação de campos, mudanças
de versão e **acessos a dados sensíveis** (quando alguém revela um dado protegido, fica registrado).
Dá para **filtrar** por tipo de ação, por usuário e por entidade.

---

## Resumo em 1 minuto

1. **Entrar** → escolha o usuário conforme o que quer fazer.
2. **Cadastro** → preencher e salvar (formulário se monta sozinho).
3. **Consulta** → ver registros; sensível fica mascarado conforme seu perfil; ver histórico.
4. **Governança** → aprovar/ignorar campos novos **sem programar**.
5. **Versões + Editor** → montar um rascunho, comparar e **ativar** quando pronto.
6. **Auditoria** → conferir tudo que foi feito.

---

## Perguntas comuns

**Por que o CPF aparece com asteriscos?**
Proteção de dados. Só quem tem o perfil autorizado (papel *pii*, como o `admin`) vê o valor real —
e esse acesso fica auditado.

**Adicionei um campo e ele não apareceu no formulário.**
Se você adicionou numa versão **rascunho**, ela precisa ser **ativada** (Passo 6). Se aprovou pela
Governança na versão ativa, ele aparece na hora (recarregue a tela).

**Cada empresa vê os dados da outra?**
Não. Cada **tenant** (cliente) só enxerga os seus registros, seu layout, seu histórico e sua auditoria —
inclusive garantido no próprio banco de dados.

**Excluí um registro por engano.**
A exclusão é lógica: o dado sai das listas mas permanece no histórico. Fale com um administrador para
recuperá-lo se necessário.
