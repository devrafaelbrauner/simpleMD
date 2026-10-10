/**
 * Imagens do vault FX-R7 (r7 S0; product r7 §6, AC-I1.6…AC-I1.10). As quatro raster são o mesmo
 * desenho 24×16 (faixas azul, amarela e verde com borda), geradas de um PNG por `sips` (JPEG, GIF) e
 * `cwebp -lossless` (WebP); bytes em base64 para o harness e o Vitest carregarem sem rede nem
 * carregador de arquivos binários.
 */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAKElEQVR42mNQohJgAGLtnA2Y6NNBP6zIam4sJho1aNSgUYOGpkFUAQCQJ/He5lm71gAAAABJRU5ErkJggg==';
export const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAGKADAAQAAAABAAAAEAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAEAAYAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAv/aAAwDAQACEQMRAD8A+RfDPhnw5P4c0qefSrSSSS0gZmaCMszGMEkkrkknqa/Xb/hSHwW/6EDw/wD+Cq0/+NV+RPhnxN4cg8OaVBPqtpHJHaQKytPGGVhGAQQWyCD1Ffrt/wALv+C3/Q/+H/8Awa2n/wAdr5H6UftPY5V9QvtU5uT0pWvy/O1/Mfgx/Fx31rvC3N6z2v8AI/NLxp4L8HWvg7Xbq10KwhmhsLp0dLWJWVliYhlIXIIPIIr8+K/Qfxp408HXXg7XbW112wmmmsLpERLqJmZmiYBVAbJJPAAr8+K68Jz8utz8U4f+texfPzXv1v2R/9k=';
export const GIF_BASE64 =
  'R0lGODdhGAAQAKIAAAAAACIiIitssDqdXfLBTv///wAAAAAAACH5BAQAAAAALAAAAAAYABAAAAM+GLrcziJKQaqtI+uhprzXpnUeBWIiF5TmmarsiYqkJxNvPd35WvIp3UfWixGDPtuRltwtN8IIkGl0IR9YbAIAOw==';
export const WEBP_BASE64 =
  'UklGRkoAAABXRUJQVlA4TD0AAAAvF8ADAB8gECBejEsyIEwgQLyokW/FgVAAjSHk0M6m+Q+wZdGDYkiSmOU5n5U8xhyeBxDR/wnAaUmqfIMTAA==';

/** SVG comum (exibido por `<img>`). */
export const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16"><rect width="24" height="16" fill="#2b6cb0"/><circle cx="12" cy="8" r="5" fill="#f2c14e"/></svg>\n';

/**
 * SVG hostil (AC-I1.10): `<script>`, `onload`, `<image href>` externo, `<foreignObject>` com
 * `onerror` e link `javascript:`. Por `<img>` nada disso roda nem faz requisição; cada tentativa
 * marcaria uma bandeira `window.__svg*`.
 */
export const HOSTILE_SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24" height="16" onload="window.__svgOnload = 1">\n  <script>window.__svgScript = 1;</script>\n  <rect width="24" height="16" fill="#3a9d5d"/>\n  <image href="https://exemplo.org/rastreio.png" width="24" height="16"/>\n  <image xlink:href="https://exemplo.org/rastreio-xlink.png" width="24" height="16"/>\n  <foreignObject width="24" height="16"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__svgForeign = 1"/></div></foreignObject>\n  <a href="javascript:window.__svgLink = 1"><text y="12">x</text></a>\n</svg>\n';
