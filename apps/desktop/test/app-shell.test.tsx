// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

afterEach(cleanup);

test('a11y F-2 / EC F-9: o h1 da casca fica dentro do marco <main>', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' });
  render(<App app={h.app} />);
  await act(async () => {});
  const heading = screen.getByRole('heading', { level: 1, name: 'simpleMD' });
  expect(heading.closest('main')).not.toBeNull();
});

test('a11y F-1: o editor da casca é uma parada de Tab (tabindex 0 no conteúdo)', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' });
  const { container } = render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  const content = container.querySelector('.cm-content');
  expect(content?.getAttribute('tabindex')).toBe('0');
  expect(content?.getAttribute('aria-label')).toBe('Editor: nota.md');
});
