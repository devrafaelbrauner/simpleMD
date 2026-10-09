# Segurança

## Versões cobertas

| Versão                                | Situação                                       |
| ------------------------------------- | ---------------------------------------------- |
| 0.1.x (pré-lançamento sem assinatura) | recebe correções de segurança numa versão nova |
| anteriores                            | sem suporte                                    |

Os instaladores oficiais saem só da página de releases deste repositório: <https://github.com/devrafaelbrauner/simpleMD/releases>. Cada arquivo tem a soma SHA-256 no `SHA256SUMS` do release e uma atestação de proveniência do GitHub (veja "Instalar" no [`README.md`](README.md)).

## Como relatar

Relate **de forma privada**, nunca numa issue ou discussão pública:

- pela página de relato privado do GitHub: <https://github.com/devrafaelbrauner/simpleMD/security/advisories/new>.

Se essa página não estiver disponível, abra uma issue **sem detalhes** pedindo um canal privado; os detalhes vão só pelo canal privado.

Relate também, do mesmo jeito:

- um instalador cuja soma SHA-256 não bate com o `SHA256SUMS` do release, ou cuja atestação de proveniência falha;
- um aviso do sistema dizendo que o app está "danificado";
- uma cópia do simpleMD distribuída fora da página de releases.

Nesses casos, não abra o arquivo e apague-o.

Inclua, se puder: a versão, o sistema (macOS ou Windows e a versão), o nome do arquivo e a soma SHA-256 que você obteve, e os passos para reproduzir o problema. Não inclua chaves de API, senhas nem o conteúdo das suas notas.

## O que esperar

O projeto tem um mantenedor. Os relatos são lidos e respondidos pelo canal privado, e a correção sai numa versão nova (os números de versão e as tags não são reaproveitados).
