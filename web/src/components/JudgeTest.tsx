import { useMutation } from '@tanstack/react-query';
import { useApi } from '../api/context.js';
import type { JudgeTransport } from '../api/types.js';
import { Button } from './ui.js';

/** "Test connection" button plus its result, shared by Settings and the setup wizard. */
export function JudgeTest({ transport, apiKey }: { transport: JudgeTransport; apiKey: string }) {
  const api = useApi();
  const test = useMutation({
    mutationFn: () =>
      api.testJudge({ transport, ...(transport === 'api' && apiKey ? { apiKey } : {}) }),
  });
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        onClick={() => {
          test.mutate();
        }}
        disabled={test.isPending}
      >
        {test.isPending ? 'Testing…' : 'Test connection'}
      </Button>
      <p role="status" className="m-0 text-sm empty:hidden">
        {test.isError ? (
          <span className="text-fail">Could not reach the server: {test.error.message}</span>
        ) : test.data ? (
          <span className={test.data.ok ? 'text-pass' : 'text-fail'}>
            {test.data.ok ? '✓ ' : '✕ '}
            {test.data.detail}
          </span>
        ) : null}
      </p>
    </div>
  );
}
