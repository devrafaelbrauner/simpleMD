import { afterEach, expect, it } from 'vitest';
import { mermaidExtension } from '../src/mermaid/decorate';
import { mermaidRenderCounts, mermaidRequested } from '../src/mermaid/render';
import { destroyViews, mountView, tick } from './helpers';

afterEach(destroyViews);

it('AC-7.12: documento sem Mermaid → biblioteca nunca pedida; uma cerca visível → pedida e renderizada 1×', async () => {
  const view = mountView('# Nota\n\n```js\nconst a = 1;\n```\n', mermaidExtension, {
    focus: false,
  });
  await tick(20);
  view.dispatch({ changes: { from: view.state.doc.length, insert: '\nmais texto\n' } });
  await tick(400);
  expect(mermaidRequested()).toBe(false);
  expect(mermaidRenderCounts.mermaid).toBe(0);

  view.dispatch({
    changes: {
      from: view.state.doc.length,
      insert: '\n```mermaid\nflowchart TD\n  A --> B\n```\n',
    },
  });
  await tick(400);
  await expect.poll(() => view.contentDOM.querySelector('.cm-mermaid svg')).not.toBeNull();
  expect(mermaidRequested()).toBe(true);
  expect(mermaidRenderCounts.mermaid).toBe(1);
}, 20_000);
