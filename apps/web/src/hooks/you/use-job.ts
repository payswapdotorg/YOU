'use client';
// TL-owned job polling hook. Polls a durable job until it reaches a terminal
// state. Progress shown is only what the backend reports — never fabricated.
// P6.B8: `dead` (P6.A6-FULL terminal dead-letter state) is TERMINAL — polling
// stops on it. A dead job exhausted its bounded retry budget; polling forever
// would spin dishonestly. Distinction exposed for the UI: `dead` renders the
// dead-letter explanation, `failed` renders the last error honestly.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { api } from '@/lib/you/client/api';
import type { JobView } from '@/lib/you/contracts';

const TERMINAL: JobView['status'][] = ['succeeded', 'failed', 'cancelled', 'unavailable', 'dead'];

export function useJob(jobId: string | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.jobs.get(jobId as string),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const data = q.state.data as JobView | undefined;
      if (!data || TERMINAL.includes(data.status)) return false;
      return 1500;
    },
  });

  const job = query.data ?? null;
  const done = !!job && TERMINAL.includes(job.status);
  const succeeded = job?.status === 'succeeded';
  /** terminal dead-letter state (retry budget exhausted) — not the same as failed */
  const dead = job?.status === 'dead';

  const invalidateOnDone = useCallback(() => {
    if (done) {
      // job reached terminal state — refresh server queries that may have changed
      void qc.invalidateQueries();
    }
  }, [done, qc]);

  useEffect(() => { invalidateOnDone(); }, [invalidateOnDone]);

  return { job, done, succeeded, dead, isPending: query.isPending };
}
