// Importação `?raw` do Vite/Vitest: o conteúdo do arquivo como string, byte a byte.
declare module '*.md?raw' {
  const content: string;
  export default content;
}

// `import.meta.glob` do Vite/Vitest (fixtures `FX-R7` lidas byte a byte nos testes de consultas).
interface ImportMeta {
  glob<T>(
    pattern: string | readonly string[],
    options: { eager: true; query?: string; import?: string },
  ): Record<string, T>;
}
