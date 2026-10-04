'use client';
// Evidence request card — one targeted evidence request (reason, affected
// capability, instructions, expected signal). Fulfilling starts a GUIDED F1
// capture scoped to the request (P6.B5): the consent gate is enforced
// server-side (a consent_required refusal opens the F1 statements dialog via
// the parent), the request is LINKED but only reads fulfilled when the
// capture completes — the closed loop.
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { IdChip, StatusBadge } from '@/components/you/shared/primitives';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { CaptureSessionView, EvidenceRequestView } from '@/lib/you/contracts';
import { Camera, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { timeAgo } from './format';

export function EvidenceRequestCard({
  request, twinId, onFulfilled, onConsentRequired,
}: {
  request: EvidenceRequestView;
  twinId: string;
  onFulfilled: (session: CaptureSessionView) => void;
  /** opens the F1 consent-gate dialog (server refused: consent_required) */
  onConsentRequired: (hint: string, missingStatements?: string[]) => void;
}) {
  const fulfill = useMutation({
    mutationFn: () => api.artifacts.fulfillEvidenceRequest(request.id, twinId, { idem: uid(), guided: true }),
    onSuccess: (res) => {
      toast.success('Guided fulfillment capture started', {
        description: 'The request is linked and stays open until this capture completes — the focused protocol steps carry the request instructions.',
      });
      onFulfilled(res.captureSession);
    },
    onError: (err) => {
      if (err instanceof YouApiError && err.code === 'consent_required') {
        const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
        const missing = Array.isArray(rec?.missingStatements)
          ? (rec?.missingStatements as string[])
          : Array.isArray(rec?.invalidStatements) ? (rec?.invalidStatements as string[]) : [];
        onConsentRequired(err.message, missing.length > 0 ? missing : undefined);
        return;
      }
      if (err instanceof YouApiError && err.code === 'conflict') {
        const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
        if (rec && typeof rec.captureSessionId === 'string') {
          toast.info('A fulfillment capture is already in progress for this request', {
            description: 'Finish the linked session — the request reads fulfilled when it completes.',
          });
          return;
        }
      }
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
        {request.status === 'open' && request.captureSessionId ? (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
            fulfillment in progress
          </span>
        ) : null}
        <span className="you-num ml-auto text-[11px] text-muted-foreground" title={request.createdAt}>
          {timeAgo(request.createdAt)}
        </span>
      </div>
      <h3 className="mt-2.5 text-[13px] font-medium leading-snug">{request.reason}</h3>
      <div className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed">
        <p><span className="font-semibold text-muted-foreground">Instructions:</span> {request.instructions}</p>
        <p><span className="font-semibold text-muted-foreground">Expected signal:</span> {request.expectedSignal}</p>
        <p className="text-muted-foreground"><span className="font-semibold">Scope:</span> <span className="font-mono text-[11px]">{request.scope}</span></p>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <IdChip id={request.id} label="" />
        {request.status === 'open' ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={() => fulfill.mutate()}
            disabled={fulfill.isPending}
            title={request.captureSessionId ? 'Resume the linked guided capture below' : 'Start the consent-gated guided F1 capture focused on this request'}
          >
            {fulfill.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Camera className="size-3.5" aria-hidden />}
            {request.captureSessionId ? 'Fulfillment in progress' : 'Fulfill with guided capture'}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
