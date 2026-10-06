import { useEffect, useState } from 'react';

/**
 * `true` só depois de `active` ficar verdadeiro por `ms` (UX-D19: indicadores de carregamento
 * aparecem após 150 ms; a segunda linha do explorador, após 15 s).
 */
export function useDelayed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, ms]);
  return active && elapsed;
}
