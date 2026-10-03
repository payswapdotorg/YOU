'use client';
// F1 consent gate dialog (P6.B3) — records the six consent statements
// docs/F1_OPERATOR_CAPTURE.md requires for operator capture: what is
// captured, why, which product tests use it, retention, training permission
// (SEPARATE and default-DENIED — the checkbox starts unchecked), and the
// deletion/withdrawal process. Grants created here carry `statements` and
// unlock the guided F1 capture flow (the server gate refuses grants without
// them, listing exactly what is missing).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { IdChip } from '@/components/you/shared/primitives';
import { api } from '@/lib/you/client/api';
import type { ConsentGrantView } from '@/lib/you/contracts';
import { Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

const TTL_OPTIONS = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

export function F1ConsentGateDialog({
  open, onOpenChange, subjectId, twinName, missingHint, missingStatements, onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjectId: string;
  twinName: string;
  missingHint?: string;
  /** machine-readable missing/invalid statement names from the 403 envelope */
  missingStatements?: string[];
  onGranted?: (grant: ConsentGrantView) => void;
}) {
  const qc = useQueryClient();
  const [what, setWhat] = useState('');
  const [why, setWhy] = useState('');
  const [tests, setTests] = useState('');
  const [mayBeRetained, setMayBeRetained] = useState(true);
  const [retainUntil, setRetainUntil] = useState('');
  const [retentionPolicy, setRetentionPolicy] = useState('');
  const [trainingPermitted, setTrainingPermitted] = useState(false); // default DENIED per the F1 law
  const [deletion, setDeletion] = useState('');
  const [ttlHours, setTtlHours] = useState(24);

  // reset to defaults each time the gate opens (render-phase adjust pattern)
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setWhat(''); setWhy(''); setTests('');
      setMayBeRetained(true); setRetainUntil(''); setRetentionPolicy('');
      setTrainingPermitted(false); setDeletion(''); setTtlHours(24);
    }
  }

  const parsedTests = tests.split('\n').map((t) => t.trim()).filter(Boolean);

  const grant = useMutation({
    mutationFn: () =>
      api.consent.grant({
        subjectId,
        purpose: `F1 operator capture — twin “${twinName}” (guided 8-step protocol)`,
        scopes: ['capture', 'reconstruct'],
        ttlHours,
        statements: {
          what: what.trim(),
          why: why.trim(),
          tests: parsedTests,
          retention: {
            mayBeRetained,
            ...(retainUntil ? { retainUntil: new Date(`${retainUntil}T23:59:59Z`).toISOString() } : {}),
            policy: retentionPolicy.trim() || 'retained while the consent grant is active; withdrawn on revocation',
          },
          training: {
            permitted: trainingPermitted,
            note: trainingPermitted ? 'explicitly permitted by this consent' : 'not granted — training is default-denied',
          },
          deletion: deletion.trim(),
        },
      }),
    onSuccess: (g) => {
      toast.success('F1 capture consent recorded', {
        description: `Grant ${g.id.slice(0, 12)}… covers the six required statements. Training: ${trainingPermitted ? 'permitted (explicit)' : 'DENIED (default)'}.`,
      });
      void qc.invalidateQueries({ queryKey: ['consent'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      if (onGranted) { onGranted(g); } else { onOpenChange(false); }
    },
    onError: (err) => {
      toast.error('Could not record F1 consent', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const ready = what.trim() && why.trim() && parsedTests.length > 0 && deletion.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            F1 capture consent
          </DialogTitle>
          <DialogDescription>
            The guided F1 capture flow requires consent that explicitly states all six items below —
            the product owner does not need to be the captured person; use a consenting internal
            tester, contractor, advisor or volunteer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5 text-[13px]">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</div>
            <IdChip id={subjectId} label="subject" />
          </div>

          {missingHint || (missingStatements && missingStatements.length > 0) ? (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {missingHint ?? 'The server refused the flow — consent statements missing or invalid.'}
                {missingStatements && missingStatements.length > 0 ? (
                  <span className="block font-mono mt-1">missing/invalid: {missingStatements.join(', ')}</span>
                ) : null}
              </span>
            </p>
          ) : null}

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="f1-what">What is captured</Label>
              <Textarea id="f1-what" value={what} onChange={(e) => setWhat(e.target.value)} rows={2}
                placeholder="Photos and short clips of the subject following the guided 8-step protocol (face, body, hands, turn-around, walking, optional speech) — raw evidence stays in the immutable evidence store." />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f1-why">Why it is captured</Label>
              <Textarea id="f1-why" value={why} onChange={(e) => setWhy(e.target.value)} rows={2}
                placeholder="To build and improve the subject's digital twin for the product tests listed below." />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f1-tests">Which product tests will use it (one per line)</Label>
              <Textarea id="f1-tests" value={tests} onChange={(e) => setTests(e.target.value)} rows={2}
                placeholder={'F1 operator-capture acceptance run\nTwin reconstruction quality benchmark'} />
            </div>
            <div className="grid gap-1.5">
              <Label>Retention</Label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-card px-3 py-2.5 text-[13px]">
                <Checkbox checked={mayBeRetained} onCheckedChange={(c) => setMayBeRetained(c === true)}
                  aria-label="Sample may be retained" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block font-medium">The sample may be retained</span>
                  <span className="block text-xs text-muted-foreground">Unchecked = no retention right; deletion is available immediately after the session.</span>
                </span>
              </label>
              {mayBeRetained ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="f1-retain-until">Retain until (optional)</Label>
                    <Input id="f1-retain-until" type="date" value={retainUntil} onChange={(e) => setRetainUntil(e.target.value)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="f1-retention-policy">Retention policy</Label>
                    <Input id="f1-retention-policy" value={retentionPolicy} onChange={(e) => setRetentionPolicy(e.target.value)}
                      placeholder="retained while the consent grant is active" />
                  </div>
                </div>
              ) : null}
            </div>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-card px-3 py-2.5 text-[13px]">
              <Checkbox checked={trainingPermitted} onCheckedChange={(c) => setTrainingPermitted(c === true)}
                aria-label="Permit use for training" className="mt-0.5" />
              <span className="min-w-0">
                <span className="block font-medium">Permit use for training — default DENIED</span>
                <span className="block text-xs text-muted-foreground">
                  Training permission is separate. Leave unchecked to keep it denied — biometric data is never used for training without this explicit grant.
                </span>
              </span>
            </label>
            <div className="grid gap-1.5">
              <Label htmlFor="f1-deletion">Deletion / withdrawal process</Label>
              <Textarea id="f1-deletion" value={deletion} onChange={(e) => setDeletion(e.target.value)} rows={2}
                placeholder="The subject may withdraw at any time by revoking this consent grant (Trust → Consent → revoke); the capture evidence is then deleted (historical TwinVersions stay immutable, keeping only content hashes as the record)." />
            </div>
            <div className="grid gap-1.5 sm:max-w-[220px]">
              <Label htmlFor="f1-ttl">Grant expires after</Label>
              <Select value={String(ttlHours)} onValueChange={(v) => setTtlHours(Number(v))}>
                <SelectTrigger id="f1-ttl" className="w-full" aria-label="Consent time-to-live">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_OPTIONS.map((t) => (
                    <SelectItem key={t.hours} value={String(t.hours)}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Grants are explicit, purpose-bound, revocable and enforced server-side on every step of
            the guided flow. The six statements above are recorded with the grant and persisted with
            the capture as its provenance.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={grant.isPending}>Cancel</Button>
          <Button onClick={() => grant.mutate()} disabled={grant.isPending || !ready} className="gap-1.5">
            {grant.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
            Record F1 consent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
