// Importação `?raw` do Vite/Vitest: o conteúdo do arquivo como string, byte a byte.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
