'use client';
// HTIR inspector — renders the canonical Human Twin Intermediate Representation
// of a TwinVersion: domains as key/value cards, per-domain confidence, and
// deficiencies that map to targeted evidence requests (improve loop).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { KeyValue } from '@/components/you/shared/primitives';
import { DomainConfidenceBars, OverallConfidence, SeverityBadge } from './confidence';
import { evidencePresetFor } from './regions';
import { api, uid } from '@/lib/you/client/api';
import type { HtirConfidenceDeficiency, TwinVersionView } from '@/lib/you/contracts';
import {
  Activity, Boxes, Footprints, Mic, Palette, PersonStanding, Scan, Shapes, Sparkles, TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

function Chips({ items, mono = true }: { items: string[]; mono?: boolean }) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span key={item} className={cn('rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground', mono && 'font-mono')}>
          {item}
        </span>
      ))}
    </span>
  );
}

function Measurements({ values }: { values: Record<string, number> }) {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="you-num rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {k}: {Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v}
        </span>
      ))}
    </span>
  );
}

function ColorDot({ color }: { color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      <span className="size-2.5 rounded-full border border-black/10" style={{ backgroundColor: color }} aria-hidden />
      {color}
    </span>
  );
}

type KVItem = { label: string; value: React.ReactNode };

function DomainCard({ title, icon: Icon, items }: { title: string; icon: typeof Scan; items: KVItem[] }) {
  return (
    <section className="rounded-lg border bg-card/60 p-4">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden /> {title}
      </h3>
      <div className="mt-3"><KeyValue items={items} /></div>
    </section>
  );
}

function RequestEvidenceDialog({
  deficiency, twinVersionId, open, onOpenChange, onViewRequests,
}: {
  deficiency: HtirConfidenceDeficiency | null;
  twinVersionId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onViewRequests?: () => void;
}) {
  const qc = useQueryClient();
  const preset = deficiency ? evidencePresetFor(deficiency.capability, deficiency.remediation) : null;
  const [reason, setReason] = useState('');
  const [instructions, setInstructions] = useState('');
  const [expectedSignal, setExpectedSignal] = useState('');

  // Re-seed prefills each time the dialog opens for a deficiency.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (deficiency && preset && seededFor !== `${twinVersionId}:${deficiency.capability}:${deficiency.reason}`) {
    setSeededFor(`${twinVersionId}:${deficiency.capability}:${deficiency.reason}`);
    setReason(deficiency.reason);
    setInstructions(preset.instructions);
    setExpectedSignal(preset.expectedSignal);
  }

  const request = useMutation({
    mutationFn: () => api.artifacts.requestEvidence(
      { twinVersionId, reason: reason.trim(), capability: deficiency?.capability ?? 'custom', instructions: instructions.trim(), expectedSignal: expectedSignal.trim(), scope: 'capture' },
      uid(),
    ),
    onSuccess: (req) => {
      toast.success('Evidence requested', {
        description: `Request targets "${deficiency?.capability}". It appears in this twin's Improve tab.`,
        action: onViewRequests ? { label: 'View requests', onClick: onViewRequests } : undefined,
      });
      void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error('Could not create evidence request', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  if (!deficiency || !preset) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Request targeted evidence</DialogTitle>
          <DialogDescription>
            Prefilled from the deficiency remediation — edit before submitting. One request authorizes
            one capture for one stated deficiency.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid gap-1.5">
            <Label htmlFor="er-reason">Reason</Label>
            <Input id="er-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="er-capability">Affected capability</Label>
            <Input id="er-capability" value={deficiency.capability} readOnly className="font-mono text-[12px] text-muted-foreground" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="er-instructions">Capture instructions</Label>
            <Textarea id="er-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} maxLength={600} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="er-signal">Expected signal</Label>
            <Textarea id="er-signal" value={expectedSignal} onChange={(e) => setExpectedSignal(e.target.value)} rows={2} maxLength={400} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={request.isPending}>Cancel</Button>
          <Button onClick={() => request.mutate()} disabled={request.isPending || !reason.trim() || !instructions.trim()} className="gap-1.5">
            {request.isPending ? <Activity className="size-3.5 animate-spin" aria-hidden /> : null}
            Create request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HtirInspector({ version, onViewRequests }: {
  version: TwinVersionView;
  onViewRequests?: () => void;
}) {
  const htir = version.htir;
  const [requestFor, setRequestFor] = useState<HtirConfidenceDeficiency | null>(null);
  const deficiencies = htir.confidence?.deficiencies ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <OverallConfidence value={htir.confidence?.overall} />
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="you-num text-[11px]">{version.evidenceAssetIds.length} evidence assets</Badge>
          <Badge variant="outline" className="you-num text-[11px]">{deficiencies.length} deficiencies</Badge>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <DomainCard title="Morphology" icon={PersonStanding} items={[          
            { label: 'Build', value: htir.morphology?.build ?? null },
            { label: 'Height est.', value: htir.morphology?.heightEstimateCm ? <span className="you-num">{htir.morphology.heightEstimateCm} cm</span> : null },
            { label: 'Age est.', value: htir.morphology?.ageEstimate ?? null },
            { label: 'Presentation', value: htir.morphology?.presentation ?? null },
            { label: 'Descriptors', value: htir.morphology?.descriptors ? <Chips items={htir.morphology.descriptors} /> : null },
          ]} />

        <DomainCard title="Geometry" icon={Shapes} items={[          
            { label: 'Skeleton', value: htir.geometry?.skeleton ? <span className="font-mono text-[12px]">{htir.geometry.skeleton}</span> : null },
            { label: 'Measurements', value: htir.geometry?.measurements ? <Measurements values={htir.geometry.measurements} /> : null },
            { label: 'Face', value: htir.geometry?.face?.landmarkSummary ?? null },
            { label: 'Face proportions', value: htir.geometry?.face?.proportions ? <Measurements values={htir.geometry.face.proportions} /> : null },
            { label: 'Hand detail', value: htir.geometry?.hands?.detail ?? null },
          ]} />

        <DomainCard title="Appearance" icon={Palette} items={[          
            {
              label: 'Palette',
              value: htir.appearance?.palette
                ? (
                  <span className="flex flex-wrap gap-1">
                    {(['skin', 'hair', 'eyes'] as const)
                      .map((k) => htir.appearance.palette?.[k])
                      .filter((c): c is string => !!c)
                      .map((c) => <ColorDot key={c} color={c} />)}
                    {(htir.appearance.palette?.clothing ?? []).map((c) => <ColorDot key={c} color={c} />)}
                  </span>
                )
                : null,
            },
            { label: 'Hair', value: [htir.appearance?.hair?.style, htir.appearance?.hair?.length, htir.appearance?.hair?.coverage ? `coverage: ${htir.appearance.hair.coverage}` : null].filter(Boolean).join(' · ') || null },
            { label: 'Clothing', value: [htir.appearance?.clothing?.style, ...(htir.appearance?.clothing?.items ?? [])].filter(Boolean).join(' · ') || null },
            { label: 'Distinguishing', value: htir.appearance?.distinguishing?.length ? <Chips items={htir.appearance.distinguishing} mono={false} /> : null },
          ]} />

        <DomainCard title="Articulation" icon={Scan} items={[          
            { label: 'Gaze model', value: htir.articulation?.gazeModel ?? null },
            {
              label: 'Blendshapes',
              value: htir.articulation?.blendshapes?.length
                ? <span className="text-[12px]"><span className="you-num font-medium">{htir.articulation.blendshapes.length}</span> supported <Chips items={htir.articulation.blendshapes.slice(0, 6)} /></span>
                : null,
            },
          ]} />

        {htir.neuralAppearance ? (
          <DomainCard title="Neural appearance" icon={Sparkles} items={[            
              { label: 'Enabled', value: htir.neuralAppearance.enabled ? 'yes' : 'no' },
              { label: 'Adapter', value: htir.neuralAppearance.adapterId ? <span className="font-mono text-[12px]">{htir.neuralAppearance.adapterId}</span> : null },
              { label: 'Notes', value: htir.neuralAppearance.notes ?? null },
            ]} />
        ) : null}

        {htir.motionProfile ? (
          <DomainCard title="Motion profile" icon={Footprints} items={[            
              { label: 'Default pose', value: htir.motionProfile.defaultPose },
              { label: 'Gesture style', value: htir.motionProfile.gestureStyle },
              { label: 'Tempo', value: htir.motionProfile.tempo },
            ]} />
        ) : null}

        {htir.voice ? (
          <DomainCard title="Voice" icon={Mic} items={[            
              { label: 'Pitch', value: htir.voice.pitch },
              { label: 'Pace', value: htir.voice.pace },
              { label: 'Style', value: htir.voice.style },
              { label: 'TTS ready', value: htir.voice.ttsReady ? 'yes' : 'no' },
            ]} />
        ) : null}

        <DomainCard title="Style profiles" icon={Boxes} items={[          
            {
              label: 'Targets',
              value: htir.styleProfiles?.length
                ? <Chips items={htir.styleProfiles.map((p) => p.style)} mono={false} />
                : null,
            },
            {
              label: 'Params',
              value: htir.styleProfiles?.length
                ? <span className="you-num text-[12px]">{htir.styleProfiles.reduce((n, p) => n + Object.keys(p.params ?? {}).length, 0)} keys total</span>
                : null,
            },
          ]} />
      </div>

      <section className="rounded-lg border bg-card/60 p-4">
        <h3 className="text-[13px] font-semibold">Confidence by domain</h3>
        <div className="mt-3">
          <DomainConfidenceBars byDomain={htir.confidence?.byDomain} />
        </div>
      </section>

      <section className="rounded-lg border bg-card/60 p-4">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">
          <TriangleAlert className="size-3.5 text-muted-foreground" aria-hidden /> Deficiencies
          <span className="you-num ml-auto text-[11px] font-normal text-muted-foreground">mapped to targeted evidence</span>
        </h3>
        {deficiencies.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No deficiencies reported for this version.</p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {deficiencies.map((d, i) => (
              <li key={`${d.capability}-${i}`} className="rounded-lg border bg-card px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={d.severity} />
                  <span className="font-mono text-[11.5px] font-medium">{d.capability}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 gap-1 px-2.5 text-[11.5px]"
                    onClick={() => setRequestFor(d)}
                  >
                    Request evidence
                  </Button>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed">{d.reason}</p>
                {d.remediation ? (
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                    <span className="font-medium">Remediation:</span> {d.remediation}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <RequestEvidenceDialog
        deficiency={requestFor}
        twinVersionId={version.id}
        open={!!requestFor}
        onOpenChange={(o) => !o && setRequestFor(null)}
        onViewRequests={onViewRequests}
      />
    </div>
  );
}
