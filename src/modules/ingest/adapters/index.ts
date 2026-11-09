import type { Agent, SourceAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';

const adapters: Record<Agent, SourceAdapter> = {
  claude_code: claudeCodeAdapter,
  codex: codexAdapter,
};

export const adapterFor = (agent: Agent): SourceAdapter => adapters[agent];
