# Plugins do simpleMD — API v1

Um plugin é uma pasta com `manifest.json` e `main.js` dentro de `<sua pasta>/.simplemd/plugins/<id>/`.
O `main.js` é um ES module que exporta por padrão uma função `activate(api)`. Esta página é o
contrato da **API v1** (PLANO §4.1, aprovada pelo usuário antes da etapa 6).

> **Leia a seção [Segurança](#segurança) antes de ativar um plugin.** Um plugin **não roda numa
> sandbox**: o código dele roda dentro do app, com o mesmo acesso que o simpleMD tem.

## Instalação

1. Copie a pasta do plugin (só `manifest.json` e `main.js`; `README.md` é opcional) para
   `.simplemd/plugins/<id>/` da sua pasta de notas. O nome da pasta é igual ao `id` do manifesto.
2. No app: Configurações → **Plugins** (ou paleta de comandos → “Plugins…”) → **Recarregar lista**.
3. Ligue o interruptor do plugin. Na primeira vez neste dispositivo (e sempre que o código mudar)
   aparece o aviso “Ativar um plugin de terceiros?”. O padrão é **Cancelar**; para ativar, escolha
   **Ativar mesmo assim**.

Exemplo pronto: `plugins-examples/hello-world` (um comando “Dizer olá” com `Mod-Shift-H` e uma
decoração na palavra `hello`).

## Manifesto (`manifest.json`)

| Campo           | Tipo            | Regra                                                                                                            |
| --------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`            | texto           | `^[a-z0-9]+(\.[a-z0-9-]+)+$`, até 128 caracteres, **igual ao nome da pasta**                                     |
| `name`          | texto           | até 80 caracteres, sem caracteres de controle                                                                    |
| `version`       | texto           | SemVer 2.0 (ex.: `1.0.0`)                                                                                        |
| `minAppVersion` | texto           | SemVer; acima da versão do app → status `Incompatível` (“requer simpleMD ≥ x.y.z”)                               |
| `main`          | texto           | caminho relativo de um `.js` dentro da pasta do plugin (sem `..`, sem `/` inicial, sem `\`, sem segmento oculto) |
| `description`   | texto, opcional | até 500 caracteres                                                                                               |

Limites: `manifest.json` até **64 KB**; `main.js` até **5 MB**. Chaves desconhecidas são ignoradas.
Um manifesto inválido deixa o plugin `Inválido`, com o motivo nomeando o campo, e o `main.js` **não
é lido nem executado**.

Status no gerenciador: `Desativado`, `Ativo`, `Erro`, `Incompatível`, `Alterado — confirme de novo`,
`Inválido`.

## Referência da API v1

```ts
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  main: string;
  description?: string;
}
interface PluginAPI {
  registerCommand(id: string, cmd: { name: string; hotkey?: string; run(): void }): void;
  registerEditorExtension(ext: { source?: CMExtension; wysiwyg?: MilkdownPlugin }): void;
  registerPanel(id: string, panel: { title: string; render(el: HTMLElement): void }): void;
  registerCompletionSource(src: CompletionSource): void;
  on(evt: 'file:open' | 'file:save' | 'vault:change', handler: (e) => void): Unsubscribe;
  vault: {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    list(): Promise<string[]>;
  };
  settings: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): Promise<void> };
  ui: { notify(msg: string, level?: 'info' | 'warn' | 'error'): void };
}
// main.js: export default function activate(api: PluginAPI): void | (() => void)
```

Tipos fixados pela decisão D-7: `path`/`text`/`key` são `string`; `Unsubscribe = () => void`;
`CMExtension` = `Extension` de `@codemirror/state`; `CompletionSource` = o de
`@codemirror/autocomplete`; `MilkdownPlugin` é um tipo opaco reservado. Os tipos ficam em
`@simplemd/plugin-api`. `on` é tipado por evento (decisão C-R2-2): mesmo membro, mesma aridade.

`activate` recebe **exatamente um argumento**: uma instância da API criada para o plugin,
congelada (`Object.freeze`), com exatamente os 8 membros acima e presa ao id do plugin.

- **`registerCommand(id, cmd)`** — o comando vira `<pluginId>:<id>` e aparece na paleta
  (`Mod-Shift-P`) como “<nome do plugin>: <cmd.name>”. Registrar o mesmo `id` duas vezes lança erro.
  `hotkey` usa a notação do CodeMirror (`Mod-Shift-H`; `Mod` = Cmd no macOS, Ctrl nos demais). Veja
  [Atalhos e conflitos](#atalhos-e-conflitos).
- **`registerEditorExtension({ source, wysiwyg })`** — `source` (uma extensão do CodeMirror 6) entra no
  editor principal por reconfiguração; o editor nunca é recriado (documento, seleção e desfazer
  ficam intactos) e desligar o plugin tira a extensão. `registerEditorExtension({})` lança
  `TypeError` citando `source` e `wysiwyg`.
- **`registerPanel(id, { title, render })`** — o painel vira uma aba “title” no painel lateral
  (`Mod-Shift-L` ou o botão “Painel lateral”). Na primeira exibição, `render(el)` é chamado **uma vez**
  com um `HTMLElement` persistente, dentro de uma região nomeada pelo título. Também aparece na paleta
  “Mostrar painel: <título>”. Desligar o plugin esvazia `el` e remove a aba. O conteúdo do painel é
  responsabilidade do plugin.
- **`registerCompletionSource(src)`** — a fonte entra nas sugestões do editor principal e obedece ao
  interruptor global de autocompletar (etapa 8): desligado, ela não é chamada.
- **`on(evt, handler)`** — devolve um `Unsubscribe`. Cargas (objetos congelados):
  - `file:open` → `{ path }` quando uma aba **nova** abre um arquivo (não numa troca de aba);
  - `file:save` → `{ path, mtime }` depois de cada gravação bem-sucedida (inclusive o autosave e a
    cópia de “Manter ambos”);
  - `vault:change` → `{ paths: string[] }` depois de abrir a pasta, de uma criação no app ou de uma
    mudança externa (adição, alteração, remoção).
- **`vault.list()`** — todos os `.md` da pasta, recursivo, relativos, com `/`, ordenados, sem itens
  ocultos. **`vault.read(path)`** — o texto **do disco** (numa aba com edições não salvas, é a versão
  do disco, não o buffer). **`vault.write(path, text)`** — veja [Regras de gravação](#regras-de-gravação-vaultwrite).
  Caminhos absolutos, com `..`, sob pastas ocultas (inclusive `.simplemd/`), que não terminam em
  `.md` ou que escapam da pasta por link simbólico são recusados sem tocar o disco fora da pasta.
- **`settings.get(key)` / `settings.set(key, value)`** — veja [Configurações](#configurações-do-plugin).
- **`ui.notify(msg, level)`** — aviso do app com o prefixo “<nome do plugin>: ”. `info` e `warn` vão
  para a região `role="status"`; `error`, para `role="alert"`.

### O campo `wysiwyg`

`registerEditorExtension({ wysiwyg })` está **reservado para o modo WYSIWYG (etapa 15); aceito e
ignorado hoje**. O valor é guardado e não muda nada no editor. Um plugin que hoje registra só
`source` continua válido quando o modo WYSIWYG existir (PLANO §4.1).

## Módulos do host (parte do contrato v1)

Para montar uma `CMExtension` o plugin precisa das **mesmas instâncias** do CodeMirror que o app
usa (uma segunda cópia de `@codemirror/state` quebra `instanceof`). Por isso o `main.js` pode
importar exatamente estes especificadores, que resolvem para as instâncias do app:

| Especificador              | Versão maior |
| -------------------------- | ------------ |
| `@codemirror/state`        | 6            |
| `@codemirror/view`         | 6            |
| `@codemirror/language`     | 6            |
| `@codemirror/autocomplete` | 6            |

Qualquer outro `import` (pacote, caminho relativo, URL ou `import()` com expressão) faz a ativação
falhar com “Importa um módulo indisponível: “<especificador>”.”. Na v1 o plugin externo é **um único
arquivo** `main.js`.

### Nomes de nós da árvore de sintaxe (parte do contrato v1)

Um plugin pode percorrer `syntaxTree(state)` (de `@codemirror/language`) e confiar nestes nomes de
nó do Lezer Markdown: `FencedCode`, `CodeInfo`, `CodeText`, `CodeBlock`, `InlineCode`,
`ATXHeading1`…`ATXHeading6`, `SetextHeading1`, `SetextHeading2` e `FrontMatter` (bloco de front
matter YAML no início da nota, desde a etapa 7; é a forma de um plugin ignorar o front matter).

`FrontMatter` é um nó de bloco no topo da árvore. Ele existe quando a nota começa (offset 0) com uma
linha exatamente `---` (espaços no fim são aceitos) e há, mais adiante, uma linha exatamente `---`
ou `...` que o fecha. Sem fechamento não há nó, e o `---` volta a ser uma regra horizontal. O nó
cobre da primeira cerca até o fim da linha de fechamento.

## Plugins internos: Mermaid, KaTeX e Cálculo (etapa 7)

Os três plugins de renderização do simpleMD são escritos **só com a API v1**: cada um exporta
`activate(api)` e chama apenas `api.registerEditorExtension({ source })`. Eles importam só os tipos de
`@simplemd/plugin-api`, os módulos do host acima, a própria biblioteca (`mermaid`, `katex`) e os
próprios arquivos, e uma regra de lint (`pnpm lint`) recusa qualquer outro import, `eval` ou
`new Function`. O código fica em `packages/plugins-internal/` e prova que a API basta para
renderização (nenhuma lacuna da API foi encontrada).

| Plugin (id)                            | O que faz                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Diagramas Mermaid (`simplemd.mermaid`) | Cercas ` ```mermaid ` de topo viram SVG (`securityLevel: 'strict'`, cores do tema atual). |
| Fórmulas KaTeX (`simplemd.katex`)      | `$…$` em linha (regras do Pandoc) e blocos `$$` em linhas próprias.                       |
| Cálculo (`simplemd.calc`)              | Um token `=2+3` vira `5`.                                                                 |

- Ficam em Configurações → Plugins → “Plugins internos”; ligar ou desligar não pede confirmação,
  vale na hora (o editor não é recriado) e é guardado em `.simplemd/config.json` como
  `"plugins": { "internal": { "<id>": false } }`. O padrão é ligado.
- O cursor dentro de uma unidade mostra o texto cru (o bloco Mermaid ou `$$` inteiro, a fórmula em
  linha, o token calc), como nos blocos de código. Nada disso altera o texto da nota.
- Mermaid e KaTeX são carregados só quando um diagrama ou uma fórmula aparece na tela. Enquanto
  carregam, a fonte crua fica visível. Os resultados ficam em cache: editar fora de um diagrama não
  o desenha de novo, e uma edição dentro dele redesenha 300 ms depois da última tecla.
- Matemática e calc não valem dentro de código (cercado, indentado ou em linha) nem do front matter;
  calc também não vale dentro de uma fórmula.
- **Regras do calc:** o token começa com `=` no início da linha ou depois de um espaço e vai até o
  próximo espaço ou o fim da linha. Ele só pode ter dígitos, `.` e `+ - * / % ^ ( )`, precisa de pelo
  menos um operador binário e tem no máximo 200 caracteres. O separador decimal é só o ponto. Um
  token com outro caractere, inclusive uma vírgula ou um ponto final colado (`=2+3.`), não é calculado.
  O resultado tem até 10 algarismos significativos (`=0.1+0.2` → `0.3`); `=1/0` mostra “divisão por
  zero”.
- `plugins-examples/calc/` é o mesmo código do Cálculo, empacotado como plugin externo (gerado por
  `node scripts/build-plugin-example.mjs`; o CI confere que o arquivo commitado é igual ao gerado).

## Ciclo de vida e descarte

- Ordem de carga: plugins internos primeiro, depois os da pasta por `id`; um de cada vez.
- `activate` é chamado uma vez por ativação. Se ele devolver uma função, ela é chamada **exatamente
  uma vez** ao desligar; depois disso o app remove tudo o que o plugin registrou (comandos, atalhos,
  extensões, painéis, fontes de sugestões, ouvintes de evento) e a instância da API passa a lançar
  `Error('plugin desativado')`.
- Religar funciona sem reiniciar o app.
- Trocar ou fechar a pasta descarta todos os plugins da pasta antiga antes de carregar os da nova.
- Uma exceção em `activate`, num comando, num ouvinte, em `render`, numa fonte de sugestões ou dentro
  da extensão do editor é capturada: o editor e os outros plugins continuam funcionando, o plugin
  fica `Erro` com a mensagem e aparece **um** aviso por plugin e tipo de falha. Se `activate` lança,
  o que ele registrou antes de lançar é desfeito.
- **Não coberto:** um laço infinito num plugin trava o app. Sem sandbox isso não pode ser evitado.

## Configurações do plugin

- Ficam em `.simplemd/plugins/<id>/data.json` (por plugin), gravadas por ler-mesclar-gravar
  (chaves desconhecidas ficam).
- São carregadas **antes** de `activate`: `get` é síncrono e devolve uma cópia.
- `set` resolve depois da gravação. Valores que não viram JSON lançam `TypeError`; acima de **1 MB**
  serializado, `set` rejeita e nada é gravado.
- Um `data.json` ilegível vale como `{}` nesta sessão e nunca é sobrescrito.
- Pela API, um plugin não lê as configurações de outro.

## Atalhos e conflitos

Um `hotkey` que colide com um atalho embutido **não é ligado**: o embutido vence, um aviso nomeia o
conflito e o comando continua na paleta. Embutidos: `Mod-B`, `Mod-I`, `Mod-K`, `Mod-W`, `Mod-,`,
`Mod-O`, `Mod-Shift-P`, `Mod-P`, `Ctrl-Tab`, `Ctrl-Shift-Tab`, `Tab`, `Shift-Tab`, `Escape`,
`Enter`, as teclas de sugestão (`Ctrl-Space` e `Mod-Shift-Space`: ⌘⇧Espaço no macOS,
Ctrl+Shift+Espaço nos demais), `Mod-Shift-L`,
`Mod-Shift-A` e toda tecla dos keymaps padrão e de histórico do CodeMirror (ex.: `Mod-Z`,
`Mod-Shift-Z`/`Mod-Y`, `Mod-A`): um plugin nunca rouba o desfazer. Entre dois plugins, o primeiro a
carregar vence e o segundo recebe o mesmo aviso. Atalhos de plugin funcionam com o foco no editor,
no explorador, nas abas ou no painel lateral, e nunca antecipam um atalho do editor.

## Regras de gravação (`vault.write`)

As regras 1 (nunca reescrever o que o usuário não pediu) e 6 (nunca sobrescrever em silêncio) valem
para plugins:

- **Caminho novo:** cria o arquivo (a pasta precisa existir; plugins não criam pastas) e emite
  `vault:change`.
- **Caminho existente:** só grava se **este plugin leu o arquivo nesta sessão** com `vault.read` e o
  disco **ainda tem o que ele leu**. Senão rejeita com `ConflictError` e grava 0 bytes. Leia antes de
  atualizar.
- **Arquivo aberto numa aba com edições pendentes:** `ConflictError`; o buffer fica intacto.
- **Arquivo aberto numa aba limpa:** é gravado e a aba recarrega com o aviso de sempre.
- Finais de linha e BOM: a gravação usa exatamente o `text` recebido; preservá-los é
  responsabilidade do plugin.

## Compatibilidade e estabilidade

- `minAppVersion` acima da versão do app → `Incompatível`; o plugin não roda.
- **A API v1 está congelada:** só mudanças aditivas. Nenhum membro de `PluginAPI` será renomeado,
  removido ou terá a assinatura alterada na v1. A lista de módulos do host e os nomes de nó acima
  também fazem parte da v1.

## Segurança

**Plugins não são sandbox.** A decisão do usuário antes da etapa 6 (isolamento = API estreita, sem
globais do Tauri e aviso na ativação) substitui a frase do PLANO §6 “plugin não acessa Tauri nem
`window`”: o `main.js` roda no mesmo realm JavaScript do app e alcança `window`.

### O que um plugin ativado PODE fazer

1. Rodar JavaScript arbitrário no realm do app, com acesso a `window`, ao DOM e a toda tecla digitada
   no app — **inclusive uma chave de API enquanto ela é digitada** em Configurações → IA.
2. Chamar qualquer comando IPC do Tauri que as capabilities da janela principal permitem, por
   `window.__TAURI_INTERNALS__`. Isso inclui:
   - ler e gravar notas e, em `.simplemd/`, a configuração, o `index.json`, os temas e o
     `data.json` de qualquer plugin. O código e o manifesto dos plugins (`plugins/**/*.js`,
     `manifest.json`) o gateway do vault só deixa **ler**: um plugin não reescreve o código de outro
     pelo IPC;
   - abrir diálogos nativos. Se você escolher um arquivo num deles, o plugin lê esse arquivo (abrir:
     só `.json` de até 1 MiB) ou grava bytes quaisquer no destino que você confirmou (salvar);
   - disparar pedidos de IA com a chave salva do usuário, gastando a cota dele e enviando conteúdo
     ao provedor, e ler as respostas;
   - **pedir para trocar ou apagar a chave de API salva.** Cada pedido de gravar ou apagar a chave
     abre um diálogo nativo que diz qual provedor e qual ação; nada muda no keychain sem o seu
     clique em "Salvar chave" ou "Remover chave" (Esc, fechar ou "Cancelar" recusa, sem mensagem
     de erro). Restam três coisas: o plugin ainda lê uma chave **enquanto ela é digitada** (item
     1); pode abrir esse diálogo várias vezes, um de cada vez (um pedido que chega com outro aberto
     é recusado); e o botão padrão (Return) é o de confirmar, porque o diálogo do sistema usado
     sempre põe o padrão no botão de confirmar. Leia o diálogo antes de apertar Return: se você não
     pediu, clique em "Cancelar";
   - usar o transporte de IA como um canal estreito para **serviços locais**: o endereço do Ollama
     aceita qualquer porta de loopback (`127.0.0.1`, `localhost`, `[::1]`), então um plugin pode
     fazer `POST` de um JSON qualquer em `/api/chat` ou `GET` em `/api/tags` de qualquer serviço
     que escute numa porta local e ler a resposta (só esses dois caminhos, sem cabeçalhos próprios,
     sem redirecionamento);
   - fechar a janela;
   - chamar os comandos de aprovação de plugins. Isso não é uma escalada: ele já roda código
     arbitrário a cada abertura. O armazenamento de aprovações protege contra **código novo ou
     alterado chegando pela sincronização**, porque aprovações nunca viajam com a pasta e ligar um
     plugin nunca aprova um hash que não foi aprovado.
3. Alterar qualquer nota por `api.vault.write` (com as regras de conflito acima) ou diretamente pelo
   IPC (sem regras de conflito).
4. Travar o app (laço infinito) ou degradá-lo (decorações pesadas).
5. **Abrir conexões de rede que a CSP não cobre — fechado no motor do webview (macOS: app medido;
   Windows: motor medido, app NÃO TESTADO).** A CSP não controla WebRTC (um `RTCPeerConnection`
   com um servidor STUN/TURN qualquer manda pacotes para esse host e resolve o nome dele por DNS)
   nem o `<link rel="preconnect">` (uma conexão TCP com qualquer host) e, no WebView2, o
   `dns-prefetch` (uma consulta DNS para qualquer nome). WebRTC e `preconnect` foram confirmados
   no app de release do r2 (macOS) e do r3 (Windows); o `dns-prefetch` foi medido no motor do
   WebView2 154 (r4). Apagar `RTCPeerConnection` em JavaScript não basta, porque não fecha o
   `preconnect` nem o `dns-prefetch`. Por isso a trava é no motor do webview e vale para todo realm,
   inclusive um `iframe` `about:blank` (no WebView2 um script de criação de documento também chega a
   esses realms, mas não é ele a trava):
   - **macOS:** o app cria o WebView com `RTCPeerConnection` e `<link rel="preconnect">`
     desligados (preferências internas do WebKit, conferidas antes de usar); o `dns-prefetch` do
     WebKit já vem desligado. Se uma atualização do macOS remover as preferências, o app abre
     normalmente, avisa numa linha do stderr e o canal volta;
   - **Windows:** o WebView2 roda com `--webrtc-ip-handling-policy=disable_non_proxied_udp`, que
     fecha STUN/UDP em qualquer realm (nenhuma porta UDP é aberta), e com um proxy morto
     (`--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>`), que fecha todo TCP do
     webview: TURN por TCP, `preconnect` e `dns-prefetch`, inclusive a consulta DNS desses
     nomes (com proxy, o nome não é resolvido no computador). Medido no motor do WebView2
     154.0.4258.62 (r4): 0 UDP e 0 TCP em todos os vetores (até 13: STUN em 5 tipos de realm e
     para um nome, TURN por TCP no realm principal, num `iframe` e para um nome, `preconnect` e
     `dns-prefetch`), em 4 rodadas, e nenhuma resolução de nome para os hosts de TURN,
     `preconnect` e `dns-prefetch`. Para o nome de um servidor STUN, a ausência de consulta DNS
     vem do código do Chromium (nenhuma porta STUN é criada), não de medição direta. O app não usa
     a rede pelo webview (a IA fala pelo Rust), então o proxy não tira nada dele. A
     `--force-webrtc-ip-handling-policy` usada no r3 não tinha efeito no WebView2.

   Resíduos no Windows:
   - a trava de UDP depende de o WebView2 continuar lendo `--webrtc-ip-handling-policy`. Se uma
     versão nova deixar de ler, STUN/UDP volta sem aviso (TCP e DNS continuam fechados pelo proxy);
     cada sessão de QA no Windows mede isso de novo;
   - argumentos de fora do app (a variável `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` ou a política
     `AdditionalBrowserArguments` do WebView2) se somam aos do app e podem reabrir os canais.
     Gravá-los exige rodar código como o seu usuário;
   - um programa local que escute em `127.0.0.1:9` recebe os pedidos que o webview manda ao proxy
     (com o nome do host de destino).

   O efeito no app de release é conferido pela sonda AC-6.27 (h); no Windows, o app de release com
   esses argumentos ainda está **NÃO TESTADO** (fica para a sessão no Windows; a medição acima é do
   motor do WebView2).

### O que ele NÃO PODE fazer (cada item é imposto e testado)

- Receber os globais do Tauri: `window.__TAURI__` não existe (`withGlobalTauri: false`).
- Ler uma chave de API salva: nenhum comando IPC devolve uma chave.
- Fazer pedidos HTTP pelo webview: a CSP (`connect-src`, `img-src`, `font-src`, `frame-src`)
  bloqueia `fetch`, XHR, `sendBeacon`, WebSocket, EventSource, imagens, fontes e CSS `url()` remotos,
  `iframe` e `import()` de outra origem; a navegação para fora do app e as janelas novas são
  bloqueadas no lado nativo. Fora do webview, o transporte de IA em Rust só fala com os hosts fixos
  dos provedores e com portas de loopback (item 2 acima). **Isso não impede toda saída de dados:**
  os canais do item 5 dependem do motor do webview e têm os resíduos listados lá.
- Ler ou gravar fora da pasta aberta **sem a sua escolha num diálogo do sistema**: o acesso a
  arquivos passa pelo gateway do vault em Rust, preso à pasta ativa; a pasta anterior fica
  inacessível ao trocar. Os diálogos de abrir e salvar do item 2 são a exceção, e cada um precisa de
  um clique seu.
- Rodar sem o seu consentimento neste dispositivo, ou depois que o `main.js` mudou.

### Consentimento ligado ao código

- A aprovação liga o `id` do plugin ao **sha256 dos bytes do `main.js`**, lidos uma única vez. O
  texto executado é uma transformação determinística, em memória, **desses mesmos bytes** (os 4
  especificadores do host viram URLs internas e uma linha `//# sourceURL=simplemd-plugin://<id>/<main>`
  é acrescentada para atribuir falhas); não há segunda leitura entre conferir e executar. O hash
  mostrado no aviso é o dos bytes do arquivo, o mesmo que `shasum -a 256 main.js` mostra.
- Aprovações ficam **por dispositivo, fora da pasta** (nos dados do app:
  `plugin-approvals.json`), por pasta + id. Uma pasta sincronizada para outro aparelho mostra os
  plugins `Desativado` até você aprová-los lá.
- Se os bytes mudarem, o plugin não roda: fica `Alterado — confirme de novo` e ligar mostra o aviso
  de novo. Desligar e religar um plugin aprovado e inalterado não mostra o aviso.
- **O hash cobre só os bytes do `main.js`.** Código que o plugin carrega em tempo de execução não é
  coberto: um plugin aprovado pode ler texto de uma nota ou do seu `data.json` e executá-lo como
  módulo (`blob:`), e a sincronização pode mudar esse texto sem nova confirmação. Aprovar um plugin é
  confiar também no que ele decide carregar depois.

### CSP

Carregar código de plugin exigiu **uma** fonte nova em `script-src`, `blob:`, em `csp` e `devCsp`:

```
csp:    … script-src 'self' blob:; …   (todas as outras diretivas iguais às de antes)
devCsp: … script-src 'self' 'unsafe-inline' blob:; …
```

Sem `'unsafe-eval'`, sem `'unsafe-inline'` em `script-src` de produção, sem origem remota. Uma URL
`blob:` só é criada por script que já roda na origem do app, então ela não abre um vetor de injeção
de fora. Para código que já roda (um plugin), porém, `blob:` transforma texto em módulo: é por isso
que o hash do consentimento não cobre código carregado em tempo de execução (acima).

A etapa 7 (Mermaid e KaTeX) não acrescentou nenhuma fonte à CSP: as bibliotecas, o CSS e as fontes
do KaTeX são arquivos do próprio app (`font-src 'self'`), e nenhuma fórmula ou diagrama faz pedido
de rede. Isso foi verificado num build de release com a CSP de produção.

### Aviso visual

A decoração do exemplo `hello-world` usa um fundo opaco (`--color-hover`): sobre essas letras a
camada de seleção do CodeMirror fica escondida. É aceito para um exemplo.
