import type { InternalPluginDescriptor } from '../src/plugins/internal/index';

/**
 * Ganchos de QA do r7 ST (arch-ux §12.1; arch-frontend §13 DA-R7-25). Só existem no bundle do
 * harness.
 *
 * H21 (estendido): grava os textos que aparecem na região polida do editor (`.cm-announced`) e na
 * região da barra de status (`[data-testid="status-live"]`), na ordem, UMA entrada por anúncio
 * (CR-ST-05): um anúncio do CM esvazia a região e acrescenta um `div` com o texto, então conta só
 * cada `div` acrescentado; na região de status conta o texto final de cada lote de mutações quando
 * não vazio e diferente do anterior.
 */
export function createAnnouncementRecorder() {
  const log: { region: 'editor' | 'status'; text: string }[] = [];
  const lastStatus = new WeakMap<Element, string>();
  const observer = new MutationObserver((records) => {
    const touched = new Set<Element>();
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (record.type === 'childList' && target?.matches('.cm-announced')) {
        for (const node of record.addedNodes) {
          const text = node instanceof Element ? (node.textContent?.trim() ?? '') : '';
          if (text) log.push({ region: 'editor', text });
        }
        continue;
      }
      const status = target?.closest('[data-testid="status-live"]');
      if (status) touched.add(status);
    }
    for (const status of touched) {
      const text = status.textContent?.trim() ?? '';
      if (text && text !== lastStatus.get(status)) log.push({ region: 'status', text });
      lastStatus.set(status, text);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  return {
    /** Anúncios gravados desde o início ou o último `clear()`. */
    list: () => [...log],
    clear: () => {
      log.length = 0;
    },
  };
}

/**
 * H27: atraso e falha do `import()` de um plugin interno, por id. O app recebe os descritores com o
 * `load` embrulhado (nunca vê o embrulho).
 */
export function createInternalLoadControl(descriptors: readonly InternalPluginDescriptor[]) {
  const delays = new Map<string, number>();
  const failures = new Map<string, string>();
  const wrapped = descriptors.map((descriptor): InternalPluginDescriptor => ({
    ...descriptor,
    load: async (ctx) => {
      const ms = delays.get(descriptor.id) ?? 0;
      if (ms > 0) {
        const wait = Promise.withResolvers<void>();
        setTimeout(wait.resolve, ms);
        await wait.promise;
      }
      const message = failures.get(descriptor.id);
      if (message !== undefined) throw new Error(message);
      return descriptor.load(ctx);
    },
  }));
  return {
    descriptors: wrapped,
    control: {
      delay: (id: string, ms: number) => void delays.set(id, ms),
      fail: (id: string, message: string) => void failures.set(id, message),
      reset: () => {
        delays.clear();
        failures.clear();
      },
    },
  };
}
