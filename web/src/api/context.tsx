import { createContext, use } from 'react';
import type { Api } from './types.js';

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = use(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiContext>');
  return api;
}
