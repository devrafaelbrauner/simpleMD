# @simplemd/ai

Interface de IA do simpleMD (etapa 11), em TypeScript puro.

- `AIProvider` segue exatamente o PLANO §4.4.
- Há três adaptadores: OpenAI, Anthropic e Ollama.
- O pacote inclui os construtores de pedido, os leitores de fluxo (SSE e NDJSON), o mapeamento de
  erros, a redação de chaves e os modelos dos comandos.

**O pacote não acessa a rede** (R-11.2, AC-11.19). Quem faz o pedido é um transporte injetado
(`AiTransport`):

- **No app:** o comando nativo `ai_send` (Rust). Ele aplica a lista de hosts, lê a chave do keychain
  e põe o cabeçalho de autenticação.
- **No harness e nos testes:** o transporte de replay (`@simplemd/ai/testing`).

O lint recusa nesta pasta:

- `fetch`, `XMLHttpRequest`, `WebSocket` e `EventSource`;
- React, Tauri e Node;
- outros pacotes do simpleMD.

```ts
interface AIProvider {
  id: 'openai' | 'anthropic' | 'ollama';
  listModels(): Promise<string[]>;
  chat(messages: Message[], opts: { model: string; stream?: boolean }): AsyncIterable<string>;
}
type Message = { role: 'system' | 'user' | 'assistant'; content: string };
```

- Com `stream: false`, o adaptador entrega **exatamente um** pedaço, com o texto inteiro.
- Para cancelar, use `break` ou `return()` no `for await`. O iterador chama `return()` no transporte,
  que aborta o pedido nativo (`ai_cancel`), inclusive com um `next()` pendente (AC-11.3).

## Endpoints e versões fixos

| Provedor  | Pedidos                                                                 | Fixos                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | `POST /v1/chat/completions` (SSE com `stream: true`) · `GET /v1/models` | Chat Completions v1. Corpo: `model`, `messages`, `stream`. Fim do fluxo: `data: [DONE]`                                                                                             |
| Anthropic | `POST /v1/messages` (SSE) · `GET /v1/models?limit=1000`                 | Cabeçalho `anthropic-version: 2023-06-01`. `max_tokens: 2048`. Mensagens `system` vão para o campo `system` de topo, juntadas com uma linha em branco. Fim do fluxo: `message_stop` |
| Ollama    | `POST /api/chat` (NDJSON) · `GET /api/tags`                             | Corpo: `model`, `messages`, `stream`, `think: false`. Fim do fluxo: `"done": true`                                                                                                  |

- **`think: false` (Ollama).** Pede a resposta direta a modelos que "pensam" antes (qwen3.5). Assim o
  primeiro texto chega logo. Os modelos que não pensam ignoram o campo.
- **Hosts.** Os hosts de nuvem são constantes no Rust: `https://api.openai.com` e
  `https://api.anthropic.com`.
- **Ollama.** Só aceita um endereço `http` de loopback (`127.0.0.1`, `localhost` ou `[::1]`). O
  padrão é `http://127.0.0.1:11434`. As configurações exigem a porta (`normalizeOllamaUrl`, STR-127).
- **Primeiro byte.** O tempo máximo de espera é 60 s na nuvem e 120 s no Ollama (NFR-35), aplicado no
  Rust.

### Regra de filtro de `listModels` da OpenAI

Fica na lista todo id que **começa** com `gpt-`, `o1`, `o3`, `o4` ou `chatgpt-` **e não contém**
nenhum destes trechos:

- `-audio`, `-realtime`, `-transcribe`, `-tts`;
- `-search`, `-image`;
- `embedding`, `moderation`;
- `dall-e`, `whisper`.

A lista volta em ordem alfabética. Anthropic e Ollama devolvem os ids na ordem do provedor.

## Erros (R-11.3, STR-129)

| Situação                               | `AIError.code`     | Mensagem                                                                      |
| -------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| HTTP 401/403                           | `AUTH`             | `Chave inválida ou sem permissão (<Provedor>)`                                |
| HTTP 429                               | `RATE_LIMIT`       | `Limite de uso atingido (<Provedor>)`                                         |
| HTTP 5xx                               | `PROVIDER`         | `Erro do provedor`                                                            |
| Outro 4xx                              | `PROVIDER`         | `Erro do provedor: <mensagem do provedor, redigida, até 200 caracteres>`      |
| Ollama sem resposta (conexão recusada) | `OLLAMA_NOT_FOUND` | `Ollama não encontrado em <endereço>`                                         |
| Fluxo malformado ou cortado            | `STREAM`           | `A resposta chegou incompleta.` (lançado **depois** dos pedaços já entregues) |
| Primeiro byte demorou                  | `TIMEOUT`          | `O provedor não respondeu em <60\|120> s.`                                    |
| Outros códigos nativos                 | `TRANSPORT`        | Texto de STR-129 por código. `CANCELLED` não tem texto                        |

Toda mensagem passa por `redact()`, que espelha `src-tauri/src/ai/redact.rs`. Ela troca `sk-…`,
`sk-ant-…` e `Bearer …` por `[chave redigida]`.

## Modelos dos comandos (R-11.8)

Cada comando envia o modelo como mensagem `system` e a seleção, sem mudança, como `user`.

| Comando    | Modelo                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Reescrever | Reescreva o texto a seguir com clareza, mantendo o sentido, o idioma e a formatação markdown. Responda só com o texto reescrito. |
| Resumir    | Resuma o texto a seguir em poucas frases, no mesmo idioma. Responda só com o resumo.                                             |
| Continuar  | Continue o texto a seguir no mesmo estilo e idioma, por um ou dois parágrafos. Responda só com a continuação.                    |
| Traduzir   | Traduza o texto a seguir para {idioma}, preservando a formatação markdown. Responda só com a tradução.                           |

`{idioma}` recebe o nome em pt-BR do idioma escolhido em Configurações → IA. O padrão é English
(Q-13).

| Idioma escolhido   | Nome usado no modelo |
| ------------------ | -------------------- |
| Português (Brasil) | português do Brasil  |
| English            | inglês               |
| Español            | espanhol             |
| Français           | francês              |
| Deutsch            | alemão               |

## Fixtures de contrato (R-11.10, AC-11.2, AC-11.4)

As fixtures ficam em `test/fixtures/<provedor>/`.

**Casos:**

- `list-models`, `chat-stream`, `chat-nostream` e `stream-truncated`;
- `error-401` (nuvem) e `error-404` (Ollama, modelo inexistente);
- `error-429` e `error-500`;
- `connection-refused` (Ollama).

**Formato de cada arquivo** (o mesmo do gravador nativo, mais o que o teste espera):

```json
{ "request": { "provider", "method", "path", "body" },
  "response": { "status", "contentType", "chunks": ["…"] },
  "expected": { "models" | "text" | "partialText" | "status" | "error" | "message" } }
```

**`meta.json`.** Cada conjunto tem um, com `provider`, `model`, `apiVersion`, `date` e
`origem: gravado | sintético`. Ele também lista os casos gravados e os sintéticos.

**Estado atual:**

- **Ollama:** `gravado` (qwen3.5:9b, 2026-10-07). Os casos 429, 500 e conexão recusada são
  sintéticos e documentados.
- **OpenAI:** `gravado` (gpt-4o-mini, 2026-10-07, com a chave do usuário pelo gravador nativo; o
  401 usa a constante inválida). Os casos 429 e 500 são sintéticos e documentados.
- **Anthropic:** `gravado` (claude-haiku-4-5, 2026-10-07, com a chave do usuário pelo gravador
  nativo; o 401 usa a constante inválida). Os casos 429 e 500 são sintéticos e documentados.
  Critério 7 para a Anthropic: gravado; verificação no app pendente (MAC-K).

**Sem segredo.** Um teste confere todo arquivo:

- 0 ocorrências de `sk-[A-Za-z0-9_-]{16,}`, `sk-ant-` e `Bearer [A-Za-z0-9]`;
- nenhuma entrada de cabeçalho `x-api-key` ou `authorization`;
- `response` só com `status`, `contentType` e `chunks`.

### Plano de gravação e gravador (só debug)

`test/fixtures/plan.json` guarda os pedidos exatos que os adaptadores fazem, com `{{model}}` no
lugar do modelo. `test/plan.test.ts` prova que o plano é idêntico ao que o app envia. Para regravar
o plano: `SIMPLEMD_WRITE_AI_PLAN=1 pnpm exec vitest run --project ai`.

O gravador fica no Rust (`src-tauri/src/ai/recorder.rs`, `#[cfg(debug_assertions)]`) e não existe
no binário de release (AC-11.17, `scripts/assert-no-ai-recorder.mjs`). Exemplo de uso, sempre com
uma pasta **fora do repositório**:

```sh
cd apps/desktop/src-tauri
cargo run --example record_ai_fixtures -- \
  --provider ollama --model qwen3.5:9b --out <pasta fora do repositório>
```

O gravador:

- usa o mesmo transporte do app (política, hosts fixos, chave lida do keychain por pedido);
- grava só os corpos e o `content-type`, redigidos;
- deriva `stream-truncated` do `chat-stream` gravado, cortado no meio de um evento;
- escreve `meta.json` com `origem: gravado`;
- no caso 401, troca a chave pela constante `invalid-key-for-401-fixture`, nunca por uma alteração
  da chave real.

O app em debug também grava cada pedido quando `SIMPLEMD_AI_RECORD_DIR=<pasta>` está definida.
