import type { CompletionSource as CMCompletionSource } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { describe, expectTypeOf, test } from 'vitest';
import type {
  CMExtension,
  CompletionSource,
  MilkdownPlugin,
  NotifyLevel,
  PluginActivate,
  PluginAPI,
  PluginEventMap,
  PluginEventName,
  PluginManifest,
  Unsubscribe,
} from '../src/types';

// AC-6.1: a API v1 é exatamente PLANO §4.1 (lacunas preenchidas por D-7; `on` tipado, C-R2-2).
describe('API v1 (AC-6.1)', () => {
  test('PluginManifest: os 6 campos com a mesma opcionalidade', () => {
    expectTypeOf<PluginManifest>().toEqualTypeOf<{
      id: string;
      name: string;
      version: string;
      minAppVersion: string;
      main: string;
      description?: string;
    }>();
  });

  test('keyof PluginAPI = os 8 membros', () => {
    expectTypeOf<keyof PluginAPI>().toEqualTypeOf<
      | 'registerCommand'
      | 'registerEditorExtension'
      | 'registerPanel'
      | 'registerCompletionSource'
      | 'on'
      | 'vault'
      | 'settings'
      | 'ui'
    >();
  });

  test('assinaturas de §4.1', () => {
    expectTypeOf<PluginAPI['registerCommand']>().toEqualTypeOf<
      (id: string, cmd: { name: string; hotkey?: string; run(): void }) => void
    >();
    expectTypeOf<PluginAPI['registerEditorExtension']>().toEqualTypeOf<
      (ext: { source?: CMExtension; wysiwyg?: MilkdownPlugin }) => void
    >();
    expectTypeOf<PluginAPI['registerPanel']>().toEqualTypeOf<
      (id: string, panel: { title: string; render(el: HTMLElement): void }) => void
    >();
    expectTypeOf<PluginAPI['registerCompletionSource']>().toEqualTypeOf<
      (src: CompletionSource) => void
    >();
    expectTypeOf<PluginAPI['vault']>().toEqualTypeOf<{
      read(path: string): Promise<string>;
      write(path: string, text: string): Promise<void>;
      list(): Promise<string[]>;
    }>();
    expectTypeOf<PluginAPI['settings']['get']>().toEqualTypeOf<<T>(key: string) => T | undefined>();
    expectTypeOf<PluginAPI['settings']['set']>().toEqualTypeOf<
      <T>(key: string, value: T) => Promise<void>
    >();
    expectTypeOf<PluginAPI['ui']>().toEqualTypeOf<{
      notify(msg: string, level?: NotifyLevel): void;
    }>();
    expectTypeOf<Parameters<PluginAPI['on']>[0]>().toEqualTypeOf<PluginEventName>();
    expectTypeOf<ReturnType<PluginAPI['on']>>().toEqualTypeOf<Unsubscribe>();
  });

  test('eventos, níveis, cargas e tipos D-7', () => {
    expectTypeOf<PluginEventName>().toEqualTypeOf<'file:open' | 'file:save' | 'vault:change'>();
    expectTypeOf<NotifyLevel>().toEqualTypeOf<'info' | 'warn' | 'error'>();
    expectTypeOf<PluginEventMap['file:save']>().toEqualTypeOf<{
      readonly path: string;
      readonly mtime: number;
    }>();
    expectTypeOf<PluginEventMap['vault:change']>().toEqualTypeOf<{
      readonly paths: readonly string[];
    }>();
    expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>();
    expectTypeOf<CMExtension>().toEqualTypeOf<Extension>();
    expectTypeOf<CompletionSource>().toEqualTypeOf<CMCompletionSource>();
    expectTypeOf<PluginActivate>().toEqualTypeOf<(api: PluginAPI) => void | (() => void)>();
  });
});
