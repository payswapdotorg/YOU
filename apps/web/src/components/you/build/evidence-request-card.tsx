'use client';
// Evidence request card — one targeted evidence request (reason, affected
// capability, instructions, expected signal). Fulfilling starts a prefilled
// capture session scoped to the request (docs/SOLUTION_ARTIFACT.md).
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { IdChip, StatusBadge } from '@/components/you/shared/primitives';
import { api, uid } from '@/lib/you/client/api';
import type { CaptureSessionView, EvidenceRequestView } from '@/lib/you/contracts';
import { Camera, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { timeAgo } from './format';

export function EvidenceRequestCard({
  request, twinId, onFulfilled,
}: {
  request: EvidenceRequestView;
  twinId: string;
  onFulfilled: (session: CaptureSessionView) => void;
}) {
  const fulfill = useMutation({
    mutationFn: () => api.artifacts.fulfillEvidenceRequest(request.id, twinId, uid()),
    onSuccess: (res) => {
      toast.success('Capture session started for this request', {
        description: 'The checklist is prefilled — upload evidence there and run analysis.',
      });
      onFulfilled(res.captureSession);
    },
    onError: (err) => {
      toast.error('Could not start fulfillment session', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={request.status} />
        <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {request.capability}
        </span>
        <span className="you-num ml-auto text-[11px] text-muted-foreground" title={request.createdAt}>
          {timeAgo(request.createdAt)}
        </span>
      </div>
      <h3 className="mt-2.5 text-[13px] font-medium leading-snug">{request.reason}</h3>
      <div className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed">
        <p><span className="font-semibold text-muted-foreground">Instructions:</span> {request.instructions}</p>
        <p><span className="font-semibold text-muted-foreground">Expected signal:</span> {request.expectedSignal}</p>
        <p className="text-muted-foreground/80"><span className="font-semibold">Scope:</span> <span className="font-mono text-[11px]">{request.scope}</span></p>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <IdChip id={request.id} label="" />
        {request.status === 'open' ? (
          <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-[11.5px]" onClick={() => fulfill.mutate()} disabled={fulfill.isPending}>
            {fulfill.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Camera className="size-3.5" aria-hidden />}
            Fulfill with capture
          </Button>
        ) : null}
      </div>
    </article>
  );
}
