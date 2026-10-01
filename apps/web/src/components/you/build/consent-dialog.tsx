'use client';
// Reusable consent grant gate (docs/SECURITY_PRIVACY.md: explicit, scoped,
// revocable, time-bound, server-enforced). Used by the twin-create flow and
// by the capture consent gate on consent_required upload errors.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IdChip } from '@/components/you/shared/primitives';
import { api } from '@/lib/you/client/api';
import type { ConsentGrantView, ConsentScope } from '@/lib/you/contracts';
import { Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

const SCOPES: { value: ConsentScope; label: string; description: string }[] = [
  { value: 'capture', label: 'Capture', description: 'Run capture sessions and upload evidence for this person' },
  { value: 'reconstruct', label: 'Reconstruct', description: 'Reconstruct authorized captures into HTIR TwinVersions' },
  { value: 'render', label: 'Render', description: 'Render derived outputs (images, video, 3D) — derived data only' },
  { value: 'embodiment', label: 'Embodiment', description: 'Allow agent avatars to embody this twin (optional)' },
];

const TTL_OPTIONS = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

export function ConsentGrantDialog({
  open, onOpenChange, subjectId, purpose, defaultScopes, missingScopeHint, onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjectId: string;
  purpose: string;
  defaultScopes?: ConsentScope[];
  missingScopeHint?: string;
  onGranted?: (grant: ConsentGrantView) => void;
}) {
  const qc = useQueryClient();
  const [scopes, setScopes] = useState<ConsentScope[]>(defaultScopes ?? ['capture', 'reconstruct', 'render']);
  const [ttlHours, setTtlHours] = useState(24);

  // Reset to defaults each time the gate opens (render-phase adjust).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setScopes(defaultScopes ?? ['capture', 'reconstruct', 'render']);
      setTtlHours(24);
    }
  }

  const grant = useMutation({
    mutationFn: () => api.consent.grant({ subjectId, purpose, scopes, ttlHours }),
    onSuccess: (g) => {
      toast.success('Consent granted', {
        description: `Grant ${g.id.slice(0, 12)}… active for ${TTL_OPTIONS.find((t) => t.hours === ttlHours)?.label ?? `${ttlHours}h`}.`,
      });
      void qc.invalidateQueries({ queryKey: ['consent'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      // When a caller handles the grant, it owns closing (avoids the dismiss
      // path below also firing for the same close).
      if (onGranted) { onGranted(g); } else { onOpenChange(false); }
    },
    onError: (err) => {
      toast.error('Could not grant consent', {
        description: err instanceof Error ? err.message : 'Unexpected error',
      });
    },
  });

  const toggleScope = (scope: ConsentScope, checked: boolean) => {
    setScopes((prev) => (checked ? Array.from(new Set([...prev, scope])) : prev.filter((s) => s !== scope)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Grant consent
          </DialogTitle>
          <DialogDescription>
            Capture, reconstruction and rendering are blocked until an active, scoped consent grant exists for the subject.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5 text-[13px]">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</div>
            <IdChip id={subjectId} label="subject" />
          </div>

          <div className="space-y-1.5 text-[13px]">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Purpose</div>
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-[13px]">{purpose}</p>
          </div>

          {missingScopeHint ? (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{missingScopeHint}</span>
            </p>
          ) : null}

          <fieldset className="space-y-2.5">
            <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Scopes</legend>
            {SCOPES.map((s) => (
              <label
                key={s.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-card px-3 py-2.5 text-[13px] transition-colors hover:bg-muted/40"
              >
                <Checkbox
                  checked={scopes.includes(s.value)}
                  onCheckedChange={(c) => toggleScope(s.value, c === true)}
                  aria-label={s.label}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{s.label}</span>
                  <span className="block text-xs text-muted-foreground">{s.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="consent-ttl" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Expires after</Label>
            <Select value={String(ttlHours)} onValueChange={(v) => setTtlHours(Number(v))}>
              <SelectTrigger id="consent-ttl" className="w-full" aria-label="Consent time-to-live">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TTL_OPTIONS.map((t) => (
                  <SelectItem key={t.hours} value={String(t.hours)}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Grants are explicit, purpose-bound, revocable and enforced server-side. Applications receive derived
            outputs only — raw biometric evidence is never exposed. You may revoke at any time from
            Trust → Consent; historical TwinVersions remain immutable.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={grant.isPending}>Cancel</Button>
          <Button
            onClick={() => grant.mutate()}
            disabled={grant.isPending || scopes.length === 0}
            className="gap-1.5"
          >
            {grant.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
            Grant consent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
