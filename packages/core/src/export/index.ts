// Exportação (etapa 10; I-10): subcaminho `@simplemd/core/export`, importado só pelos pedaços sob
// demanda da exportação do app. Fora do barril principal, o serializador não entra na entrada
// (NFR-54); os tipos continuam no barril principal (`import type`).
export { escapeHtml, safeUrl } from './escape';
export { collectExportImages, exportDocument, frontMatterLang, renderExportBody } from './html';
export { stripFrontMatter } from './markdown';
