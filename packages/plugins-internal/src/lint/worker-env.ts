/**
 * Ambiente do worker do lint (D-R7-S5-04), importado ANTES do markdownlint em `worker.ts`: o
 * `lib/resolve-module.cjs` do markdownlint 0.41.1 lê a variável livre `require` ao carregar (só a
 * usa para `customRules`/`extends`, que o simpleMD nunca passa). No pedaço principal o Rolldown a
 * troca pelo próprio `__require`; no build IIFE do worker ela fica solta e o worker morria com
 * `ReferenceError: require is not defined` (observado no harness de produção). Só dentro de um
 * worker: define um `require` que recusa — nunca chamado — para o módulo carregar.
 */
// Os tipos do Node declaram `require` global; aqui ele é só um slot do escopo do worker.
const scope = globalThis as unknown as {
  require?: unknown;
  WorkerGlobalScope?: abstract new () => unknown;
};
if (
  typeof scope.WorkerGlobalScope === 'function' &&
  scope instanceof scope.WorkerGlobalScope &&
  scope.require === undefined
) {
  scope.require = (name: string) => {
    throw new Error(`lint: require("${name}") indisponível no worker`);
  };
}
