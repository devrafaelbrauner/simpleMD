import { readdirSync, readFileSync } from 'node:fs';
import type { Message, ProviderId } from '../src';
import type { AiFixture } from '../src/testing/replay';

/** Mensagens do plano de gravação (as mesmas de todas as fixtures de chat). */
export const PLAN_MESSAGES: Message[] = [
  { role: 'system', content: 'Responda em português, em uma frase curta.' },
  { role: 'user', content: 'Diga olá e conte de um até cinco.' },
];

export const FIXTURES = new URL('./fixtures/', import.meta.url);

export interface FixtureMeta {
  provider: ProviderId;
  model: string;
  apiVersion: string;
  date: string;
  origem: 'gravado' | 'sintético';
}

export function readFixtures(provider: ProviderId): {
  meta: FixtureMeta;
  cases: Record<string, AiFixture>;
} {
  const dir = new URL(`${provider}/`, FIXTURES);
  const cases: Record<string, AiFixture> = {};
  let meta: FixtureMeta | null = null;
  for (const name of readdirSync(dir)) {
    const value: unknown = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    if (name === 'meta.json') meta = value as FixtureMeta;
    else cases[name.replace(/\.json$/, '')] = value as AiFixture;
  }
  if (!meta) throw new Error(`fixtures de ${provider} sem meta.json`);
  return { meta, cases };
}
