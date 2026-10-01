# VJOY Estoque — controle físico pós-fabricação

Sistema web (PWA) para controlar o produto **depois que sai da fábrica embalado**:

```
ENTRADA (bipa cliente → bipa produto) → ESTOQUE na rua do cliente → SEPARAÇÃO → DOCA
→ CONFERÊNCIA por bipagem → SAÍDA (expedição) → ANÁLISE: ENTROU → SAIU → SOBROU
```

O sistema **não controla a produção**. Ele mostra onde há excesso (entrou mais do que o pedido pedia) para a gestão decidir.

---

## 1. Regras de importação (confirmadas em 30/09/2026 a partir do `modelo pedido.csv`)

| Regra | Decisão |
|---|---|
| Quais linhas entram | **Só `Tipo = PA`** (produto acabado: baú, box, auxiliar, colchão, conjugado). `SA` são componentes (estrutura, capa, faixa, TNT, grampo, kits) e são **ignoradas**. |
| O que é um pedido | **A base do campo `Número`**: `043334/K/001` → pedido `043334`, sub-pedido `K`, item `001`. `043334/1`, `/K` e `/L` são o mesmo pedido. |
| Chave única do item | O `Número` completo. Reimportar o mesmo arquivo **não duplica** pedido, item, entrada nem estoque. |
| Necessidade | `Qtde. Produzir`. Os campos `Qtde. Produzida`, `Perda`, `Data Baixa`, etc. vêm vazios e não são usados. O que entrou fisicamente vem da **bipagem**. |
| Código de barras do produto | O campo `Código` (ex.: `BBD07932LB`). Todas as unidades do mesmo produto têm o mesmo código, e cada leitura conta 1 unidade. |
| Cliente | Fica gravado **no item**, porque 6 pedidos do arquivo têm mais de um cliente. Nomes diferentes do mesmo cliente (ex.: `KINGSTAR COLCHOES` = `KING STAR`) viram apelidos, decididos na prévia. |
| Linhas pendentes | Linhas sem cliente, sem unidade, com quantidade inválida ou data inválida **não são importadas** e aparecem na prévia. |
| Possível duplicidade | Mesmo pedido + produto + quantidade + **cliente**, com emissão diferente. É importado, mas fica marcado como "dup?". |

Resultado com o arquivo real: 2.949 linhas → 1.893 PA / 1.056 SA ignoradas → **1.891 itens em 536 pedidos**, 64 clientes e 851 produtos. As 2 linhas pendentes são `003503/X/001` (sem cliente) e `044504/1/002` (sem unidade).

---

## 2. Arquitetura

```
 Celulares / tablets / PCs (PWA React)
      │  HTTPS (REST)  +  WebSocket (Socket.IO: "algo mudou" → telas atualizam sozinhas)
      ▼
 Servidor Node.js (Fastify) ── regras de negócio em transações, travas por produto/pedido
      ▼
 PostgreSQL ── razão de movimentações imutável (triggers impedem UPDATE/DELETE)
```

- **Stack:**
  - Frontend: React 19 + Vite + vite-plugin-pwa
  - Leitura de código: ZXing, com `BarcodeDetector` nativo quando existe
  - Etiquetas: JsBarcode (Code128)
  - Backend: Node 22 + Fastify + Socket.IO + `pg`
  - Banco: PostgreSQL 16
- **Um único serviço:** o Node serve a API e o app já compilado (`web/dist`).

### Estoque = soma das movimentações

Nada altera o saldo diretamente.

- Cada operação grava uma `movimentacoes` (cabeçalho: tipo, usuário, autorizado por, data/hora) com linhas em `movimentacao_itens`.
- Cada linha soma ou subtrai (`delta`) de um **saldo** = produto + cliente + rua + item de pedido (ou *livre*) + status.

| Operação | Linhas geradas |
|---|---|
| Entrada | `+1 ESTOQUE` |
| Separação | `−1 ESTOQUE` / `+1 SEPARADO` |
| Enviar à doca | `−n SEPARADO` / `+n DOCA` |
| Finalizar conferência | `−n DOCA` / `+n CONFERIDO` |
| Saída | `−n CONFERIDO` / `+n EXPEDIDO` |
| Ajuste | `±n ESTOQUE`, com motivo, qtd. anterior e final em `ajustes` |
| Vínculo de sobra | `−n` no item de origem (ou livre) / `+n` no item de destino |
| Transferência de rua | `−n` na rua antiga / `+n` na rua atual |

O **status do pedido** é calculado a partir desses saldos, nunca gravado, e por isso nunca fica inconsistente. Os status são:

Aguardando produção → Recebendo → Pronto p/ separar → Em separação → Na doca → Em conferência → Conferido → Expedido (ou Expedido parcial, ou Cancelado).

### Tabelas

`usuarios`, `localizacoes` (ruas), `clientes`, `cliente_aliases`, `produtos`, `importacoes`, `importacao_linhas`, `pedidos`, `pedido_itens`, `separacoes`, `conferencias`, `conferencia_itens`, `expedicoes`, `expedicao_conferencias`, `movimentacoes`, `movimentacao_itens`, `ajustes`, `leituras` (**toda** bipagem, certa ou errada), `logs` (auditoria).

Views: `v_saldos`, `v_item_resumo`.

Não existe tabela `entradas` separada: uma entrada é uma movimentação do tipo ENTRADA, e isso evita guardar a mesma informação duas vezes.

---

## 3. Fluxos e validações

- **Entrada:**
  1. Bipar o cliente. O sistema mostra a **RUA** grande.
  2. Bipar o produto. O sistema valida e registra, e a tela volta para o próximo produto.
  - Se o produto tem pedido em aberto desse cliente, a unidade é vinculada ao item.
  - ⚠️ **Acima do pedido** → pede confirmação e registra como excedente/sobra.
  - ⚠️ **Produto de outro cliente** → oferece "Trocar para o cliente X", ou continuar **com autorização** (login e senha de Gestão ou Admin).
  - ⚠️ **Sem pedido** → confirmação; a unidade fica como estoque livre.
  - ❌ Código inexistente, cliente sem rua ou cliente inativo são bloqueados.
  - Opção "exigir bipar o cliente antes de cada produto".
- **Separação:**
  - O operador abre o pedido e vê os itens agrupados por **rua → cliente**, depois bipa cada unidade retirada.
  - ❌ Produto que não é do pedido, quantidade excedida e estoque insuficiente são bloqueados.
  - Estoque livre do mesmo cliente é vinculado automaticamente (a operação fica rastreável).
  - "Enviar para a doca": se o pedido estiver incompleto, pede confirmação.
- **Conferência:**
  - Tabela Produto × Esperado × Conferido.
  - ✓ Leitura correta mostra `1/2`, `2/2`.
  - ❌ Produto incorreto ou quantidade excedida: a leitura não conta.
  - ❌ Produto que não consta na doca também é bloqueado.
  - Só finaliza com **todos = esperado**. Finalizar incompleta é possível só com autorização.
- **Saída:** só sai o que foi conferido (tentar expedir sem conferência é bloqueado e fica registrado). Ao sair, o sistema mostra **⚠️ N UNIDADES SOBRARAM** quando for o caso.
- **Sobras / Excedentes:** saldo físico cujo item já foi todo expedido, cujo pedido foi cancelado, ou que entrou sem pedido. Na tela de sobras é possível:
  - "Usar em pedido": vincula a sobra a outro item e mostra quanto ainda falta produzir.
  - "Ajustar": ajuste com motivo obrigatório.

---

## 4. Perfis

| Perfil | Pode |
|---|---|
| Administrador | tudo, inclusive usuários |
| Estoque | entrada, consulta, estoque |
| Expedição | separação, consulta, estoque |
| Conferência | conferência e registro de saída |
| Gestão | dashboard, relatórios, rastreabilidade, sobras/vínculos, ajustes, importação, cadastros, autorizar divergências |

As permissões são verificadas **no servidor** em toda requisição.

---

## 5. Leitura de código de barras

- **Leitor USB/Bluetooth:** funciona como teclado. O campo de leitura fica sempre focado e cada leitura termina com Enter. No celular, o teclado virtual não abre (use o botão "⌨️ Digitar" se precisar digitar).
- **📷 BIPAR CÓDIGO:**
  - Abre a câmera traseira em modo contínuo: lê, valida, mostra verde/vermelho/amarelo e volta a ler sozinha.
  - Tem botão de lanterna quando o aparelho suporta.
  - Para contar a mesma etiqueta de novo, é preciso tirar a câmera do quadro e apontar outra vez. Isso evita contar a mesma unidade duas vezes.
- **Feedback:** som (pode ser desligado no menu) e vibração.
- ⚠️ **A câmera só funciona em HTTPS.** No Railway o HTTPS já vem pronto.

## 6. PWA

- Instalação no Android/Chrome: menu → "Instalar app".
- Instalação no iPhone/Safari: Compartilhar → "Adicionar à Tela de Início".
- Abre em tela cheia.
- As operações precisam de conexão (Wi-Fi da fábrica). Isso é proposital: vários aparelhos trabalhando offline gerariam saldos conflitantes. Sem conexão, aparece uma faixa de aviso no topo.

---

## 7. Publicar no Railway

1. Crie um projeto no Railway e adicione **PostgreSQL**.
2. Adicione um serviço a partir deste código: envie para um repositório GitHub e escolha "Deploy from GitHub repo". O `railway.json` e o `Dockerfile` já configuram o build.
3. Crie as variáveis do serviço:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET` = um texto longo e aleatório
   - `ADMIN_LOGIN` e `ADMIN_SENHA`: o primeiro administrador
   - `TZ_EMPRESA=America/Sao_Paulo`
4. Faça o deploy. As tabelas são criadas automaticamente na primeira inicialização (`server/migrations`).
5. Em *Settings → Networking*, gere o domínio público (HTTPS).
6. Entre como admin, crie os usuários, importe o CSV, cadastre as **ruas**, associe cada cliente a uma rua e imprima as etiquetas em Cadastros → Etiquetas.

Use **1 réplica**: o tempo real (Socket.IO) funciona em memória.

## 8. Rodar localmente

```bash
npm install
npm run build          # compila o app (web/dist)
DATABASE_URL=postgres://usuario:senha@localhost/vjoy JWT_SECRET=dev npm start
# abre em http://localhost:3000  (admin / admin123 se ADMIN_SENHA não for definido)
```

Desenvolvimento com recarga: `npm run dev` (API na porta 3000) e `cd web && npm run dev` (app em http://localhost:5173).

## 9. Testes

`tests/e2e.js` roda o fluxo completo com o **CSV real**:

- importação e reimportação;
- entrada com excedente, cliente divergente e autorização;
- separação, doca, conferência (incorreto e excedido), saída;
- sobra de 2 unidades e vínculo da sobra a outro pedido;
- ajuste;
- 8 entradas simultâneas;
- relatórios e rastreio.

```bash
./tests/run.sh    # sobe um servidor de teste na porta 3100 com banco limpo "vjoyestoque_test"
```

## 10. Versão de teste (sem servidor)

`cd web && npx vite build --config vite.demo.config.js` gera `web/dist-teste/`: o mesmo app e as mesmas regras (`server/services`, `server/routes`), com o PostgreSQL rodando **dentro do navegador** (PGlite/WebAssembly). Serve para testar as telas sem publicar: os dados ficam só naquele navegador. Usuários de teste: `admin/admin123`, `estoque`, `expedicao`, `conferencia`, `gestao` (senha `1234`).

## 11. Fluxo simplificado (outubro/2026)

- **Entrada:** o operador escolhe o cliente **pelo nome** (digita e toca na lista; se não existir, "Usar novo cliente" cadastra na hora) e bipa os produtos. O produto é reconhecido pelo código de barras e a descrição vem do catálogo carregado da base (`004_catalogo_produtos.sql`, 852 produtos PA). Rua é opcional. Produto sem pedido em aberto entra direto como estoque do cliente, sem pergunta.
- **Saída:** menu **Saída** → escolhe o pedido → bipa cada produto (o sistema confere com o pedido e com o estoque) → **DAR SAÍDA DO PEDIDO**. Baixa o estoque e registra a expedição. Separação/doca/conferência continuam disponíveis para quem quiser usar o fluxo completo.
- Códigos de barras de outro sistema: vincular na hora da bipagem ou importar lista em **Produtos**.

## 12. Pedidos mensais, carregamento e romaneio (outubro/2026)

- **Pedidos mensais** (menu Gestão → 🗓️ Pedidos mensais, ou tocando no nome do cliente em Clientes): cada cliente tem a lista do mês, por exemplo 500 CBOT088, 500 BBK07932P e 500 CBOT128. Para montar a lista, suba uma planilha `.xlsx` ou `.csv` com as colunas **Código** e **Quantidade** (cabeçalhos repetidos no meio são ignorados) ou digite as linhas. A tela mostra Pedido / Carregado / Falta / Em estoque por produto e permite navegar entre os meses.
- **Carregamento** (🚛 no menu de operação): escolha o cliente (placa e motorista são opcionais) e bipe cada peça que sobe no caminhão. A tela mostra o que está no caminhão, o pedido do mês e quanto falta. "−1" tira uma peça. Se a peça não tem entrada no estoque, o sistema pergunta e registra a entrada que faltou. Se passa do pedido do mês, também pergunta.
- **FINALIZAR CARREGAMENTO**: baixa o estoque do cliente e baixa o **romaneio em PDF** (código, descrição, unidade, quantidade, total, campos de assinatura) para enviar ao faturamento. O PDF dos carregamentos anteriores fica na lista do Carregamento e no pedido mensal do cliente.
- **Bipagem:** depois de cada leitura abre uma **tela de confirmação** com o código do produto (o que aparece embaixo do código de barras) e a descrição em letras grandes. Você confirma (ou aperta Enter / bipa de novo), ajusta a quantidade ou toca em "Não é este — ler de novo". Essa tela pode ser desligada na própria tela de bipagem. A câmera agora só aceita os formatos de código de produto, exige duas leituras iguais seguidas (evita código errado) e lê em resolução maior.

## 13. Carregamento sem internet (outubro/2026)

- **Cada leitura confirmada é gravada no servidor na hora.** Se o app fechar sozinho, o caminhão continua "EM CARREGAMENTO". Ao abrir de novo o Carregamento, é só tocar nele e continuar.
- **Se a internet cair**, o operador continua bipando normalmente:
  - A tela de confirmação usa a cópia do catálogo guardada no celular, que é atualizada a cada 6 h quando há internet.
  - A leitura fica **salva no aparelho**, com data e hora da bipagem. Ela continua lá mesmo se o app fechar ou o celular reiniciar.
  - Quando a conexão volta, as leituras são enviadas sozinhas e em ordem. O aparelho tenta a cada 8 s, ao voltar a internet e ao reabrir o app.
- **Nunca duplica:** cada leitura tem uma chave única. Se o envio se repetir (por exemplo, quando o servidor gravou mas a resposta não chegou ao celular), ela conta uma vez só (tabela `envios_aparelho`, migração 007).
- **Leituras que precisam de decisão** ficam no quadro amarelo com "Carregar mesmo assim" / "Descartar". São os casos de peça sem entrada no estoque, quantidade acima do pedido do mês ou código fora da base.
- Não dá para **finalizar** o caminhão enquanto houver leituras guardadas no celular.
- Abrir o app sem internet não desconecta o usuário: ele só sai se o login realmente expirar.
- O histórico (Rastreio) mostra "lido sem internet em …" nessas leituras.

## 14. Leitor físico (USB/Bluetooth) — comportamento

- O leitor funciona como teclado: digita o código e manda **Enter** (ou **Tab**, os dois são aceitos). Não precisa tocar na tela: o campo de leitura fica sempre com o foco.
- **Bipagem rápida:** se o operador bipar a próxima peça antes de o sistema terminar a anterior, a leitura entra numa fila. Nenhuma se perde.
- **Tela de confirmação aberta:**
  - Bipar a **mesma** peça (ou apertar Enter) confirma.
  - Bipar **outra** peça descarta a leitura da tela e mostra a nova, com o aviso "leitura anterior descartada". Assim uma leitura errada nunca é confirmada sem querer.
- **Pergunta aberta** (sem estoque, acima do pedido etc.): o Enter do leitor **não responde a pergunta**. A leitura é ignorada, com um aviso, e a pessoa precisa tocar no botão.
- **Leitor Bluetooth no celular:** pareie em modo teclado (HID). O teclado da tela não abre enquanto a opção "Digitar" estiver desligada.

### Leitor que "não lê": o que o sistema faz e como testar

- Acima do campo de leitura aparece **🟢 Leitor pronto** ou **🔴 Leitor parado — clique aqui**. Vermelho quer dizer que a janela do navegador não está selecionada (por exemplo, o cursor está na barra de endereço ou em outro programa). Basta clicar ali.
- **🔧 Leitor de código de barras: opções e teste → 🧪 Testar meu leitor** mostra cada tecla que o leitor envia e diz o que fazer. Nada é registrado durante o teste.
- **Leitor sem Enter no final:** quando a opção "Enviar sozinho quando o leitor não manda Enter" está ligada (já vem ligada), o sistema percebe que a rajada de teclas terminou e envia sozinho. Uma pessoa digitando devagar não dispara o envio.
- **Leitor que termina com Tab ou Ctrl+J** também é aceito. O Ctrl+J não abre mais a tela de downloads do Chrome.
- **Foco fora do campo:** se o leitor bipar com o foco num botão ou numa caixinha de marcar, a leitura é capturada mesmo assim.
- **Leitor USB no modo serial (COM):** no Chrome ou Edge do computador, use "Conectar leitor USB no modo serial (COM)". O navegador pergunta qual porta usar uma vez e depois reconecta sozinho. A configuração usada é 9600 baud.
