// `import x from './arquivo.css?raw'` devolve o texto do arquivo (Vite e Vitest).
declare module '*.css?raw' {
  const text: string;
  export default text;
}
