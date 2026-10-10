import { describe, expect, it } from 'vitest';
import {
  classifyHref,
  linkAccessibleName,
  resolveVaultPath,
  targetLabel,
  validateUrl,
} from '../src/links';
import cases from './fixtures/open-url-cases.json';

interface UrlCase {
  readonly input: string;
  readonly expect: string;
  readonly normalized?: string;
}

describe('espelho TS do `open_url` (paridade com open-url-cases.json, lida também pelo Rust)', () => {
  it.each(cases as UrlCase[])('$input → $expect', (row) => {
    const check = validateUrl(row.input);
    if (row.expect === 'ok') {
      expect(check.ok).toBe(true);
      if (check.ok && row.normalized !== undefined) expect(check.url.href).toBe(row.normalized);
    } else {
      expect(check).toEqual({ ok: false, code: row.expect });
    }
  });
});

describe('AC-I1.4 — matriz de esquemas do editor (classifyHref)', () => {
  it('http, https, HTTPS (normalizado) e mailto: viram destino externo', () => {
    expect(classifyHref('http://exemplo.org/http', 'n.md')).toEqual({
      kind: 'external',
      url: 'http://exemplo.org/http',
    });
    expect(classifyHref('https://exemplo.org/a?b=1#c', 'n.md')).toEqual({
      kind: 'external',
      url: 'https://exemplo.org/a?b=1#c',
    });
    expect(classifyHref('HTTPS://EXEMPLO.ORG/Maiusculo', 'n.md')).toEqual({
      kind: 'external',
      url: 'https://exemplo.org/Maiusculo',
    });
    expect(classifyHref('mailto:ana@exemplo.org?subject=Oi', 'n.md')).toEqual({
      kind: 'external',
      url: 'mailto:ana@exemplo.org?subject=Oi',
    });
  });

  it.each([
    ['javascript:alert(1)', 'javascript:'],
    ['JaVaScRiPt:alert(1)', 'javascript:'],
    ['file:///etc/passwd', 'file:'],
    ['data:text/html,oi', 'data:'],
    ['vbscript:msgbox(1)', 'vbscript:'],
    ['ftp://exemplo.org/x', 'ftp:'],
    ['smb://servidor/pasta', 'smb:'],
    ['x-foo:bar', 'x-foo:'],
    ['https://usuario:senha@exemplo.org/', 'endereço com usuário e senha'],
    ['https://exemplo.org/a\nb', 'caracteres de controle'],
    [
      `https://exemplo.org/${'a'.repeat(2049 - 'https://exemplo.org/'.length)}`,
      'endereço longo demais',
    ],
    ['relatorio.pdf', '.pdf'],
  ])('%j → não suportado (%s)', (href, label) => {
    expect(classifyHref(href, 'n.md')).toEqual({ kind: 'unsupported', label });
  });

  it('a URL de exatamente 2.048 caracteres ainda passa', () => {
    const url = `https://exemplo.org/${'a'.repeat(2048 - 'https://exemplo.org/'.length)}`;
    expect(classifyHref(url, 'n.md').kind).toBe('external');
  });
});

describe('AC-I2.5 — `.md` relativo (resolução dentro do vault)', () => {
  it('`../b.md#t` resolve relativo à pasta da nota, com o título decodificado', () => {
    expect(classifyHref('../b.md#t', 'a/n.md')).toEqual({
      kind: 'note',
      path: 'b.md',
      heading: 't',
    });
    expect(classifyHref('sub/c.md#Um%20T%C3%ADtulo', 'a/n.md')).toEqual({
      kind: 'note',
      path: 'a/sub/c.md',
      heading: 'Um Título',
    });
    expect(classifyHref('/raiz.md', 'a/b/n.md')).toEqual({
      kind: 'note',
      path: 'raiz.md',
      heading: null,
    });
    expect(classifyHref('#so-titulo', 'a/n.md')).toEqual({
      kind: 'note',
      path: 'a/n.md',
      heading: 'so-titulo',
    });
  });

  it('fora do vault ou segmento oculto → fora da pasta, sem leitura', () => {
    expect(classifyHref('../fora.md', 'n.md')).toEqual({
      kind: 'outside-vault',
      raw: '../fora.md',
    });
    expect(classifyHref('../../x.md', 'a/n.md')).toEqual({
      kind: 'outside-vault',
      raw: '../../x.md',
    });
    expect(classifyHref('..\\..\\x.md', 'a/n.md').kind).toBe('outside-vault');
    expect(classifyHref('.git/config.md', 'n.md').kind).toBe('outside-vault');
    expect(resolveVaultPath('a/../../b.png', 'n.md')).toEqual({ ok: false, reason: 'outside' });
    expect(resolveVaultPath('%E0%A4%A', 'n.md')).toEqual({ ok: false, reason: 'invalid' });
    expect(resolveVaultPath('com%20espa%C3%A7os.png', 'img/n.md')).toEqual({
      ok: true,
      path: 'img/com espaços.png',
    });
  });
});

describe('rótulos e casos de borda do destino (dica W1, nome acessível STR-134)', () => {
  it('título com escape inválido fica como escrito; `#` sozinho ou sem nota = endereço inválido', () => {
    expect(classifyHref('b.md#%E0', 'n.md')).toEqual({
      kind: 'note',
      path: 'b.md',
      heading: '%E0',
    });
    expect(classifyHref('#', 'n.md')).toEqual({ kind: 'unsupported', label: 'endereço inválido' });
    expect(classifyHref('#t', null)).toEqual({ kind: 'unsupported', label: 'endereço inválido' });
    expect(classifyHref('pasta/', 'n.md')).toEqual({
      kind: 'unsupported',
      label: 'endereço inválido',
    });
    expect(classifyHref('LEIAME', 'n.md')).toEqual({
      kind: 'unsupported',
      label: 'endereço inválido',
    });
    expect(classifyHref('%E0.md', 'n.md')).toEqual({
      kind: 'unsupported',
      label: 'endereço inválido',
    });
    expect(classifyHref('https://a.b/\u200b', 'n.md')).toEqual({
      kind: 'unsupported',
      label: 'caracteres de controle',
    });
  });

  it('nomes: link, nota (com título) e e-mail (sem esquema e sem consulta, decodificado)', () => {
    const web = classifyHref('https://exemplo.org/a', 'n.md');
    expect(linkAccessibleName('site', web, 'https://exemplo.org/a')).toBe(
      'site (link: https://exemplo.org/a)',
    );
    const note = classifyHref('b.md#Intro', 'a/n.md');
    expect(targetLabel(note, 'b.md#Intro')).toBe('a/b.md#Intro');
    expect(linkAccessibleName('b', note, 'b.md#Intro')).toBe('b (nota: a/b.md#Intro)');
    expect(linkAccessibleName('b', classifyHref('b.md', ''), 'b.md')).toBe('b (nota: b.md)');
    const mail = classifyHref('mailto:ana%40x.org?subject=Oi', 'n.md');
    expect(linkAccessibleName('Ana', mail, 'mailto:ana%40x.org?subject=Oi')).toBe(
      'Ana (e-mail: ana@x.org)',
    );
    expect(targetLabel(classifyHref('mailto:a@b.c', 'n.md'), 'mailto:a@b.c')).toBe('a@b.c');
    const refused = classifyHref('ftp://x', 'n.md');
    expect(targetLabel(refused, 'ftp://x')).toBe('ftp://x');
  });
});
