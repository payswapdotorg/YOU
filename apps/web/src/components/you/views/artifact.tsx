'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Solution Artifact runtime — the first-class review application over
// canonical YOU data (ADR-0004). Never the source of truth.
// Tabs: Overview | Compare | Evidence | Improve | Feedback | Performance |
// Provenance | API (P6.B6 adds the Feedback tab + the manifest v2 section
// surface — every P5 section filled or honestly null-with-reason).
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, Camera, CircleCheck, CircleDashed, FileBox, FileWarning,
  GitCompareArrows, Layers, ListChecks, Loader2, Lock, MessageSquare, MessageSquarePlus,
  Send, ShieldCheck, Sparkles, Workflow, ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type {
  ArtifactManifestSections, EvidenceRequestView, FeedbackRequestView, HtirConfidenceDeficiency,
  ManifestImproveSection, ManifestResultSection, SolutionArtifactView,
  TwinVersionView,
} from '@/lib/you/contracts';
import { ARTIFACT_SECTION_KEYS, sectionCompleteness } from '@/lib/you/core/artifact-sections';
import { useYouStore } from '@/hooks/you/use-you-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState, IdChip, KeyValue, PageHeader, SectionCard } from '@/components/you/shared/primitives';
import { TrackTimeline } from '@/components/you/artifact/track-timeline';
import { VersionCompare } from '@/components/you/artifact/version-compare';
import { ProvenanceChain } from '@/components/you/artifact/provenance-chain';
import { ApiSnippets } from '@/components/you/artifact/api-snippets';
import { QueryError, RowSkeletons } from '@/components/you/build/confidence';
import { cn } from '@/lib/utils';

const FALLBACK_VERDICTS = [
  'correct', 'incorrect', 'uncertain', 'missing-detail',
  'wrong-motion', 'wrong-identity', 'wrong-style',
];
const FALLBACK_REGIONS = [
  'face.front', 'face.profile', 'face.hairline', 'teeth',
  'hands', 'hair.back', 'silhouette.front', 'silhouette.side', 'walking', 'speech', 'custom',
];
const FREE_TEXT_REGION = '__free__';

const TYPE_BADGES: Record<string, string> = {
  'twin-review': 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  'render-review': 'border-violet-500/30 bg-violet-500/12 text-violet-700 dark:text-violet-400',
  'benchmark-report': 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  'avatar-session': 'border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-400',
  'performance-review': 'border-teal-500/30 bg-teal-500/12 text-teal-700 dark:text-teal-400',
};

// ─── P6.B6 — manifest v2 section surface ────────────────────────────────────

const SECTION_LABELS: Record<string, string> = {
  result: 'Result', compare: 'Compare', evidence: 'Evidence', improve: 'Improve',
  performance: 'Performance', provenance: 'Provenance', consent: 'Consent',
  apiCode: 'API / code', feedback: 'Feedback', evidenceRequests: 'Targeted evidence requests',
};

/** Every P5 section with an honest filled / null-with-reason badge. */
function SectionsCard({ sections }: { sections: ArtifactManifestSections }) {
  const completeness = sectionCompleteness(sections);
  return (
    <SectionCard
      title="Section completeness"
      description={`${completeness.filled} of ${completeness.total} P5 sections filled — the rest are honestly absent with documented reasons`}
      icon={ListChecks}
    >
      <div className="space-y-2.5">
        {ARTIFACT_SECTION_KEYS.map((key) => {
          const slot = sections[key];
          const isFilled = slot?.data != null;
          return (
            <div key={key} className="rounded-lg border bg-card px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                {isFilled ? (
                  <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                ) : (
                  <CircleDashed className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                )}
                <span className="text-xs font-semibold">{SECTION_LABELS[key] ?? key}</span>
                <Badge variant="outline" className={cn('text-[9px]', isFilled ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400' : 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400')}>
                  {isFilled ? 'filled' : 'absent'}
                </Badge>
              </div>
              {!isFilled && slot?.reason ? (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{slot.reason}</p>
              ) : null}
              {!isFilled && slot?.fillHint ? (
                <p className="mt-1 text-[11px] italic leading-relaxed text-muted-foreground/80">
                  What would fill this: {slot.fillHint}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

/** The honest result banner — verbatim numbers from the creating job. */
function ResultBanner({ result }: { result: ManifestResultSection }) {
  return (
    <SectionCard title="Result" description="What this workflow produced — numbers quoted verbatim from the job output" icon={FileBox}>
      <p className="text-sm font-medium leading-relaxed">{result.summary}</p>
      {result.refs.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {result.refs.map((r) => (
            <span key={`${r.kind}-${r.ref}`} className="flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5">
              <span className="text-xs">{r.label}</span>
              <Badge variant="outline" className="font-mono text-[9px]">{r.kind}</Badge>
              <IdChip id={r.ref} label="" />
            </span>
          ))}
        </div>
      ) : null}
      {result.metrics && Object.keys(result.metrics).length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Object.entries(result.metrics).map(([k, v]) => (
            <Badge key={k} variant="outline" className="you-num gap-1 font-mono text-[10px]">
              <span className="text-muted-foreground">{k}</span>
              <span>{String(v)}</span>
            </Badge>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}

// ─── Media preview with honest fallback ─────────────────────────────────────
function ArtifactPreview({ kind, url, label }: { kind: string; url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (kind === 'video') {
    return <video controls src={url} className="max-h-72 w-full rounded-lg border bg-black" />;
  }
  if ((kind === 'image' || kind === 'svg') && !failed) {
    return (
       
      <img
        src={url}
        alt={label}
        className="max-h-72 w-full rounded-lg border object-contain"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
    >
      <ExternalLink className="size-4" aria-hidden />
      {failed ? `${label} — preview unavailable (signed URL may have expired). Open the signed URL.` : `Open ${label} (${kind}) via signed URL`}
    </a>
  );
}

function EvidenceThumb({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-dashed bg-muted/30 text-muted-foreground">
        <FileWarning className="size-5" aria-hidden />
      </div>
    );
  }
  return (
     
    <img
      src={url}
      alt={`Evidence ${label}`}
      className="h-24 w-full rounded-lg border object-cover"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// ─── Overview tab ────────────────────────────────────────────────────────────
function OverviewTab({ artifact, twinVersion }: { artifact: SolutionArtifactView; twinVersion: TwinVersionView | null }) {
  const m = artifact.manifest;
  const sections = m.sections ?? null;
  return (
    <div className="space-y-4">
      {sections?.result?.data ? <ResultBanner result={sections.result.data} /> : null}
      {!sections ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
          <FileWarning className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Legacy manifest (v1) — created before P6.B6, it carries no first-class section slots. The tabs below derive what they can from the legacy fields; nothing is invented.
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <SectionCard title="Artifacts" description="Primary outputs — signed, expiring URLs" icon={FileBox}>
          {m.artifacts.length ? (
            <div className="space-y-4">
              {m.artifacts.map((a) => (
                <div key={a.artifactId} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{a.label}</span>
                    <Badge variant="outline" className="font-mono text-[9px]">{a.kind}</Badge>
                    <IdChip id={a.artifactId} label="artifact" />
                  </div>
                  {a.kind === 'htir' ? (
                    <div className="rounded-lg border bg-muted/30 p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium">Canonical HTIR document</span>
                        {twinVersion?.confidenceSummary ? (
                          <span className="you-num font-mono text-xs">
                            confidence{' '}
                            <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                              {Math.round(twinVersion.confidenceSummary.overall * 100)}%
                            </span>
                          </span>
                        ) : null}
                      </div>
                      <a
                        href={a.url} target="_blank" rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                      >
                        <ExternalLink className="size-3" aria-hidden /> Open signed JSON
                      </a>
                    </div>
                  ) : (
                    <ArtifactPreview kind={a.kind} url={a.url} label={a.label} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No artifact files referenced — this manifest is metadata-only.</p>
          )}
        </SectionCard>

        <SectionCard title="Inputs" description="What this artifact was produced from" icon={Layers}>
          {m.inputs.length ? (
            <div className="space-y-2">
              {m.inputs.map((i) => (
                <div key={`${i.label}-${i.ref}`} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
                  <span className="text-sm">{i.label}</span>
                  <Badge variant="outline" className="font-mono text-[9px]">{i.kind}</Badge>
                  <IdChip id={i.ref} label="ref" />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No inputs recorded.</p>
          )}
        </SectionCard>
      </div>

      <div className="space-y-4">
        <SectionCard title="Consent state" description="Explicit, scoped, server-enforced" icon={ShieldCheck}>
          {m.consent ? (
            <KeyValue
              items={[
                { label: 'Subject', value: <span className="font-mono text-xs">{m.consent.subjectId}</span> },
                { label: 'Grants', value: m.consent.grantIds.length ? <div className="flex flex-wrap gap-1">{m.consent.grantIds.map((g) => <IdChip key={g} id={g} label="grant" />)}</div> : <span className="text-muted-foreground">none recorded</span> },
                { label: 'Scopes', value: m.consent.scopes.length ? <div className="flex flex-wrap gap-1">{m.consent.scopes.map((s) => <Badge key={s} variant="outline" className="font-mono text-[9px]">{s}</Badge>)}</div> : <span className="text-muted-foreground">none</span> },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No consent grant applies — {sections?.consent?.reason ?? 'this artifact records no subject evidence (e.g. a text-origin performance carries no biometrics).'}
            </p>
          )}
        </SectionCard>

        <SectionCard title="Export targets" description="Where this artifact can travel" icon={ExternalLink}>
          {m.export_targets.length ? (
            <div className="flex flex-wrap gap-1.5">
              {m.export_targets.map((t) => (
                <Badge key={t} variant="outline" className="font-mono text-[10px]">{t}</Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No export targets declared.</p>
          )}
        </SectionCard>

        <SectionCard title="Summary" description="Manifest facts">
          <KeyValue
            items={[
              { label: 'Type', value: <Badge variant="outline" className={TYPE_BADGES[m.type] ?? ''}>{m.type}</Badge> },
              { label: 'Manifest version', value: <span className="you-num font-mono">{m.version}</span> },
              { label: 'Solution id', value: <IdChip id={m.solutionId} label="solution" /> },
              { label: 'Created', value: <span className="text-xs text-muted-foreground">{new Date(artifact.createdAt).toLocaleString()}</span> },
            ]}
          />
        </SectionCard>
      </div>
      </div>
      {sections ? <SectionsCard sections={sections} /> : null}
    </div>
  );
}

// ─── Evidence tab ────────────────────────────────────────────────────────────
function EvidenceTab({ artifact }: { artifact: SolutionArtifactView }) {
  const evidence = artifact.manifest.evidence;
  return (
    <SectionCard
      title="Evidence"
      description="Raw captures referenced by this artifact — immutable"
      icon={Camera}
    >
      {evidence.length ? (
        <>
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-800 dark:text-emerald-300">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Raw evidence is immutable. Feedback and review never rewrite captures — canonical data changes only
            through new versions compiled from new evidence.
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {evidence.map((e) => (
              <div key={e.assetId} className="space-y-2 rounded-lg border bg-card p-3">
                <EvidenceThumb url={e.url} label={e.label} />
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium" title={e.label}>{e.label}</span>
                  <a
                    href={e.url} target="_blank" rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Open evidence ${e.label}`}
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                </div>
                <IdChip id={e.contentHash} label="sha256" />
                <div><IdChip id={e.assetId} label="asset" /></div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          icon={Camera}
          title="No evidence referenced"
          hint="This artifact type doesn’t reference raw captures directly."
        />
      )}
    </SectionCard>
  );
}

// ─── Improve tab ─────────────────────────────────────────────────────────────
function DeficiencyFeedbackRow({
  d, verdicts, regions, twinVersionId, solutionArtifactId, onSubmitted,
}: {
  d: HtirConfidenceDeficiency;
  verdicts: string[];
  regions: string[];
  twinVersionId: string;
  solutionArtifactId: string;
  onSubmitted: (capability: string, request: FeedbackRequestView) => void;
}) {
  const [verdict, setVerdict] = useState('');
  const [region, setRegion] = useState('');
  const [freeRegion, setFreeRegion] = useState('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState<FeedbackRequestView | null>(null);

  const send = useMutation({
    mutationFn: () =>
      api.artifacts.feedback(
        {
          solutionArtifactId,
          twinVersionId,
          verdict,
          ...(region && region !== FREE_TEXT_REGION ? { region } : {}),
          ...(region === FREE_TEXT_REGION && freeRegion.trim() ? { region: freeRegion.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        uid(),
      ),
    onSuccess: (request) => {
      setSubmitted(request);
      toast.success(`Review request created for ${d.capability}`);
      onSubmitted(d.capability, request);
    },
    onError: (err) => toast.error(`Feedback failed — ${err instanceof YouApiError ? err.message : 'request failed'}`),
  });

  if (submitted) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
        <span className="font-mono text-xs font-medium">{d.capability}</span>
        <Badge variant="outline" className="text-[9px] text-emerald-700 dark:text-emerald-400">review request created</Badge>
        <IdChip id={submitted.id} label="feedback" />
        <span className="ml-auto text-[11px] text-muted-foreground">verdict: {submitted.verdict}</span>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-lg border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold">{d.capability}</span>
        <Badge
          variant="outline"
          className={cn(
            'text-[9px]',
            d.severity === 'high' ? 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400'
              : d.severity === 'medium' ? 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400'
                : 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
          )}
        >
          {d.severity}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{d.reason}</p>
      {d.remediation ? (
        <p className="text-[11px] text-muted-foreground/80">Remediation hint: {d.remediation}</p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Verdict</Label>
          <Select value={verdict || undefined} onValueChange={setVerdict}>
            <SelectTrigger className="h-8 text-xs" aria-label={`Verdict for ${d.capability}`}><SelectValue placeholder="select verdict" /></SelectTrigger>
            <SelectContent>
              {verdicts.map((v) => <SelectItem key={v} value={v} className="font-mono text-xs">{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Region (optional)</Label>
          <Select value={region || undefined} onValueChange={setRegion}>
            <SelectTrigger className="h-8 text-xs" aria-label={`Region for ${d.capability}`}><SelectValue placeholder="select region" /></SelectTrigger>
            <SelectContent>
              {regions.map((r) => (
                <SelectItem key={r} value={r === 'custom' ? FREE_TEXT_REGION : r} className="font-mono text-xs">{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {region === FREE_TEXT_REGION ? (
            <Input
              value={freeRegion} onChange={(e) => setFreeRegion(e.target.value)}
              placeholder="describe the region" className="h-8 font-mono text-xs"
              aria-label="Custom region"
            />
          ) : null}
        </div>
      </div>
      <Textarea
        value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional) — what exactly is off?"
        className="min-h-16 text-xs"
      />
      <Button size="sm" className="gap-1.5" disabled={!verdict || send.isPending} onClick={() => send.mutate()}>
        {send.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <MessageSquarePlus className="size-3.5" aria-hidden />}
        Submit review request
      </Button>
    </div>
  );
}

// ─── Feedback tab (P6.B6) ───────────────────────────────────────────────────

const VERDICT_STYLES: Record<string, string> = {
  correct: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  incorrect: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
  'missing-detail': 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  uncertain: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  'wrong-motion': 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
  'wrong-identity': 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
  'wrong-style': 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
};

function FeedbackTab({
  artifact, twinVersion, twinVersionPending, onChanged,
}: {
  artifact: SolutionArtifactView;
  twinVersion: TwinVersionView | null;
  twinVersionPending: boolean;
  onChanged: () => void;
}) {
  const m = artifact.manifest;
  const verdicts = m.feedback_schema?.verdicts?.length ? m.feedback_schema.verdicts : FALLBACK_VERDICTS;
  const regions = m.feedback_schema?.regions?.length ? m.feedback_schema.regions : FALLBACK_REGIONS;
  const liveRequests = m.sections?.feedback?.data?.requests ?? null;
  const feedbackReason = m.sections?.feedback?.reason ?? null;
  const feedbackFillHint = m.sections?.feedback?.fillHint ?? null;
  const deficiencies = twinVersion?.confidenceSummary?.deficiencies ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-teal-500/25 bg-teal-500/10 px-3.5 py-2.5 text-xs text-teal-800 dark:text-teal-300">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Every verdict creates a canonical FeedbackRequest — immutable evidence is never rewritten. Live requests below
        are merged at read time; the stored manifest stays a creation snapshot.
      </div>

      <SectionCard
        title="Review requests"
        description={liveRequests ? `${liveRequests.length} linked to this artifact (newest first)` : 'Linked FeedbackRequests surface here live'}
        icon={MessageSquare}
      >
        {liveRequests && liveRequests.length ? (
          <div className="space-y-2.5">
            {liveRequests.map((r) => (
              <div key={r.id} className="space-y-1.5 rounded-lg border bg-card px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn('font-mono text-[10px]', VERDICT_STYLES[r.verdict] ?? '')}>{r.verdict}</Badge>
                  {r.region ? <Badge variant="outline" className="font-mono text-[9px]">{r.region}</Badge> : null}
                  <Badge variant="outline" className={cn('text-[9px]', r.status === 'open' ? 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400' : 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400')}>{r.status}</Badge>
                  <IdChip id={r.id} label="feedback" />
                  <span className="ml-auto text-[11px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                {r.note ? <p className="text-xs leading-relaxed text-muted-foreground">{r.note}</p> : null}
              </div>
            ))}
          </div>
        ) : m.sections ? (
          <EmptyState
            icon={MessageSquare}
            title="No review requests yet"
            hint={feedbackReason ?? 'No FeedbackRequests reference this artifact yet — submit a verdict below.'}
            action={feedbackFillHint ? (
              <p className="max-w-md text-[11px] italic text-muted-foreground">What would fill this: {feedbackFillHint}</p>
            ) : undefined}
          />
        ) : (
          <EmptyState
            icon={MessageSquare}
            title="Live request surface requires a manifest v2 section slot"
            hint="This is a legacy (v1) artifact — submitted verdicts still create canonical FeedbackRequests; the live list appears on artifacts created after P6.B6."
          />
        )}
      </SectionCard>

      <SectionCard
        title="Deficiency-driven feedback"
        description={twinVersion ? `Current deficiencies on v${twinVersion.version}` : 'Verdicts against the artifact’s TwinVersion'}
        icon={MessageSquarePlus}
      >
        {!m.twinVersion ? (
          <EmptyState
            icon={MessageSquarePlus}
            title="No TwinVersion reference"
            hint={m.sections?.feedback?.reason
              ?? 'Feedback references an artifact/TwinVersion (SOLUTION_ARTIFACT.md). This artifact type doesn’t carry one, so verdict-based feedback isn’t applicable.'}
          />
        ) : twinVersionPending ? (
          <RowSkeletons rows={2} />
        ) : !twinVersion ? (
          <p className="text-sm text-muted-foreground">
            The referenced version could not be loaded for feedback — it may belong to a deleted twin.
          </p>
        ) : !deficiencies.length ? (
          <EmptyState
            icon={MessageSquarePlus}
            title="No deficiencies reported"
            hint={`The confidence summary for v${twinVersion.version} lists no deficiencies. Feedback on this surface is deficiency-driven — nothing to review.`}
          />
        ) : (
          <div className="space-y-3">
            {deficiencies.map((d) => (
              <DeficiencyFeedbackRow
                key={d.capability}
                d={d}
                verdicts={verdicts}
                regions={regions}
                twinVersionId={m.twinVersion?.id ?? twinVersion.id}
                solutionArtifactId={artifact.id}
                onSubmitted={() => { onChanged(); /* row shows its own created state */ }}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function ImproveTab({
  artifact, twinVersion, twinVersionPending, onChanged,
}: {
  artifact: SolutionArtifactView;
  twinVersion: TwinVersionView | null;
  twinVersionPending: boolean;
  onChanged: () => void;
}) {
  const navigate = useYouStore((s) => s.navigate);
  const m = artifact.manifest;
  const capabilities = m.evidence_request_schema?.capabilities ?? [];
  const improve: ManifestImproveSection | null = m.sections?.improve?.data ?? null;
  const improveReason = m.sections?.improve?.reason ?? null;
  const improveFillHint = m.sections?.improve?.fillHint ?? null;
  // legacy manifests (v1) carry no section slots — the chain surface simply
  // degrades to the request form below (nothing invented).

  const [capability, setCapability] = useState('');
  const [reason, setReason] = useState('');
  const [instructions, setInstructions] = useState('');
  const [expectedSignal, setExpectedSignal] = useState('');
  const [requested, setRequested] = useState<EvidenceRequestView | null>(null);

  const requestEvidence = useMutation({
    mutationFn: () =>
      api.artifacts.requestEvidence(
        {
          ...(m.twinVersion ? { twinVersionId: m.twinVersion.id } : {}),
          reason: reason.trim(),
          capability,
          instructions: instructions.trim(),
          expectedSignal: expectedSignal.trim(),
        },
        uid(),
      ),
    onSuccess: (request) => {
      setRequested(request);
      toast.success('Evidence request created');
      onChanged(); // refresh the live improve chain
    },
    onError: (err) => toast.error(`Request failed — ${err instanceof YouApiError ? err.message : 'request failed'}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3.5 py-2.5 text-xs text-violet-800 dark:text-violet-300">
        <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        The improve loop: request targeted evidence → fulfill it with a capture → compile a new TwinVersion →
        compare artifacts. Canonical data changes only through new versions — nothing on this tab mutates evidence.
      </div>

      <SectionCard
        title="Improve chain"
        description={improve
          ? 'Live causal links — requests, their fulfillment captures, and versions compiled from that evidence'
          : 'Evidence requests → captures → new versions'}
        icon={Workflow}
      >
        {improve ? (
          <div className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">{improve.note}</p>
            {improve.requests.length ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold">Targeted requests ({improve.requests.length})</div>
                {improve.requests.map((r) => (
                  <div key={r.requestId} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
                    <Badge variant="outline" className="font-mono text-[10px]">{r.capability}</Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[9px]',
                        r.status === 'fulfilled' ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                          : r.status === 'expired' ? 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400'
                            : 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
                      )}
                    >
                      {r.status}
                    </Badge>
                    <IdChip id={r.requestId} label="request" />
                    {r.captureSessionId ? (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <ArrowRight className="size-3" aria-hidden /> fulfilled by capture
                        <IdChip id={r.captureSessionId} label="session" />
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">not yet fulfilled</span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            {improve.followUpVersions.length ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold">Follow-up versions ({improve.followUpVersions.length})</div>
                {improve.followUpVersions.map((v) => (
                  <div key={v.twinVersionId} className="space-y-1.5 rounded-lg border bg-card px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="you-num text-xs font-semibold">v{v.version}</span>
                      <IdChip id={v.twinVersionId} label="version" />
                      {v.causedBySessionIds.length ? (
                        <Badge variant="outline" className="text-[9px] border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400">
                          causally linked to {v.causedBySessionIds.length} fulfillment capture{v.causedBySessionIds.length > 1 ? 's' : ''}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px]">no request-causality established</Badge>
                      )}
                      {v.artifactId ? (
                        <Button
                          size="sm" variant="outline" className="ml-auto h-7 gap-1.5 px-2.5 text-[11px]"
                          onClick={() => navigate('artifact', { artifactId: v.artifactId as string })}
                        >
                          <FileBox className="size-3" aria-hidden /> Open v{v.version} artifact
                        </Button>
                      ) : null}
                    </div>
                    {v.causedBySessionIds.length ? (
                      <div className="flex flex-wrap gap-1">
                        {v.causedBySessionIds.map((sid) => <IdChip key={sid} id={sid} label="capture" />)}
                      </div>
                    ) : null}
                  </div>
                ))}
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Causality is real evidence overlap (the version’s evidenceAssetIds ∩ the fulfillment session’s
                  assets) — never timestamps alone. Open a follow-up version’s artifact to compare it against its baseline.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No follow-up versions yet — compiling a new version from fulfilled evidence extends the chain.
              </p>
            )}
          </div>
        ) : m.sections ? (
          <EmptyState
            icon={Workflow}
            title="No improve chain yet"
            hint={improveReason ?? 'No targeted evidence requests reference this artifact’s TwinVersion yet.'}
            action={improveFillHint ? (
              <p className="max-w-md text-[11px] italic text-muted-foreground">What would fill this: {improveFillHint}</p>
            ) : undefined}
          />
        ) : (
          <EmptyState
            icon={Workflow}
            title="Improve chain requires a manifest v2 section surface"
            hint="This is a legacy (v1) artifact — the request form below still works; the live chain surface appears on artifacts created after P6.B6."
          />
        )}
      </SectionCard>

      <SectionCard
        title="Request targeted evidence"
        description="Ask for exactly the missing capture — the Lab’s capture-scientist pattern"
        icon={Camera}
      >
        {requested ? (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
              <ShieldCheck className="size-4" aria-hidden /> Evidence request created
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-[10px]">{requested.capability}</Badge>
              <IdChip id={requested.id} label="request" />
              <Badge variant="outline" className="text-[9px]">{requested.status}</Badge>
            </div>
            <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80">
              Next step: fulfill the request via Captures — start a capture session linked to this request and upload
              the asked-for evidence. A new TwinVersion compiled from it is how canonical data changes.
            </p>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigate('captures')}>
              <Camera className="size-3.5" aria-hidden /> Go to Captures
            </Button>
          </div>
        ) : (
          <div className="space-y-3.5">
            {capabilities.length ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Capability</Label>
                <Select value={capability || undefined} onValueChange={setCapability}>
                  <SelectTrigger className="h-9" aria-label="Capability"><SelectValue placeholder="Select capability" /></SelectTrigger>
                  <SelectContent>
                    {capabilities.map((c) => <SelectItem key={c} value={c} className="font-mono text-xs">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No capability catalog on this artifact’s schema — the request API still accepts a capability string.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="evreq-reason" className="text-xs">Reason</Label>
                <Input id="evreq-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. profile is unclear" className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="evreq-signal" className="text-xs">Expected signal</Label>
                <Input id="evreq-signal" value={expectedSignal} onChange={(e) => setExpectedSignal(e.target.value)} placeholder="e.g. ear silhouette + jawline" className="h-9" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="evreq-instructions" className="text-xs">Capture instructions</Label>
              <Textarea
                id="evreq-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)}
                placeholder="What exactly should be captured — angle, lighting, motion…"
                className="min-h-16 text-xs"
              />
            </div>
            <Button
              className="gap-1.5"
              disabled={!reason.trim() || !instructions.trim() || !expectedSignal.trim() || (!capabilities.length && !capability) || (capabilities.length > 0 && !capability) || requestEvidence.isPending}
              onClick={() => requestEvidence.mutate()}
            >
              {requestEvidence.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              Request evidence
            </Button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─── Performance tab ─────────────────────────────────────────────────────────
function PerformanceTab({ performanceId, name }: { performanceId: string; name: string }) {
  const performance = useQuery({
    queryKey: ['performance', performanceId],
    queryFn: () => api.performances.get(performanceId),
  });

  return (
    <SectionCard title={`Performance — ${name}`} description="Track visualizer for the performance baked into this artifact" icon={GitCompareArrows}>
      {performance.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-5/6" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ) : performance.isError ? (
        <QueryError
          error={performance.error}
          compact
          onRetry={() => void performance.refetch()}
          title="Could not load the performance"
        />
      ) : (
        <div className="space-y-4">
          <TrackTimeline tracks={performance.data.tracks} durationMs={performance.data.durationMs} />
          {performance.data.script ? (
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Script</div>
              <pre className="you-scroll max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {performance.data.script}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────
export function ArtifactView() {
  const params = useYouStore((s) => s.params);
  const navigate = useYouStore((s) => s.navigate);
  const artifactId = typeof params?.artifactId === 'string' ? params.artifactId : null;

  const artifact = useQuery({
    queryKey: ['artifact', artifactId],
    queryFn: () => api.artifacts.get(artifactId as string),
    enabled: !!artifactId,
    retry: (count, err) => !(err instanceof YouApiError && (err.status === 404 || err.code === 'not_found')) && count < 1,
  });

  const m = artifact.data?.manifest;

  // derive twinId from manifest inputs (kind or label referencing the twin)
  // or from a v2 result-section ref (kind 'twin' — e.g. twin-linked
  // performance artifacts carry it there, not in inputs).
  const twinId = useMemo(() => {
    if (!m) return null;
    const input = m.inputs.find((i) => /twin/i.test(i.kind) || /twin/i.test(i.label));
    if (input?.ref) return input.ref;
    const ref = m.sections?.result?.data?.refs.find((r) => r.kind === 'twin');
    return ref?.ref ?? null;
  }, [m]);

  const versions = useQuery({
    queryKey: ['twin-versions', twinId],
    queryFn: () => api.twins.versions(twinId as string),
    enabled: !!twinId && !!m?.twinVersion,
  });

  const twinVersion = useMemo(() => {
    const target = m?.twinVersion;
    if (!versions.data || !target) return null;
    return versions.data.find((v: TwinVersionView) => v.id === target.id)
      ?? versions.data.find((v: TwinVersionView) => v.version === target.version)
      ?? null;
  }, [versions.data, m]);

  // Mirrors the versions query's enable condition — a disabled query stays
  // isPending forever in React Query v5, so the enable conjuncts keep a
  // disabled query from wedging the ImproveTab skeleton.
  const twinVersionPending = !!twinId && !!m?.twinVersion && versions.isPending;

  if (!artifactId) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Solution Artifact" title="No artifact selected" />
        <EmptyState
          icon={FileBox}
          title="Open an artifact to review it"
          hint="Solution Artifacts are emitted by renders, twin reviews, benchmark reports and avatar sessions — open one from its originating surface."
          action={<Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigate('renders')}><ArrowLeft className="size-3.5" aria-hidden /> Back to Renders</Button>}
        />
      </div>
    );
  }

  if (artifact.isPending) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-2/3" />
        </div>
        <Skeleton className="h-9 w-full max-w-xl" />
        <div className="space-y-4">
          <Skeleton className="h-64 w-full rounded-xl" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (artifact.isError) {
    const notFound = artifact.error instanceof YouApiError && (artifact.error.status === 404 || artifact.error.code === 'not_found');
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Solution Artifact" title={notFound ? 'Artifact not found' : 'Couldn’t load artifact'} />
        <EmptyState
          icon={FileBox}
          title={notFound ? 'This artifact doesn’t exist (or is no longer accessible)' : 'The artifact request failed'}
          hint={notFound
            ? 'Artifact ids are opaque and never recycled — check the id you followed, or open the artifact again from its originating surface.'
            : (artifact.error instanceof YouApiError ? artifact.error.message : 'request failed')}
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigate('renders')}>
                <ArrowLeft className="size-3.5" aria-hidden /> Back to Renders
              </Button>
              <Button size="sm" className="gap-1.5" onClick={() => artifact.refetch()}>
                <Loader2 className="size-3.5" aria-hidden /> Retry
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const data = artifact.data;
  const tabs = [
    { value: 'overview', label: 'Overview' },
    ...(data.manifest.twinVersion ? [{ value: 'compare', label: 'Compare' }] : []),
    { value: 'evidence', label: 'Evidence' },
    { value: 'improve', label: 'Improve' },
    { value: 'feedback', label: 'Feedback' },
    ...(data.manifest.performance ? [{ value: 'performance', label: 'Performance' }] : []),
    { value: 'provenance', label: 'Provenance' },
    { value: 'api', label: 'API' },
  ];
  const refreshArtifact = () => { void artifact.refetch(); };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Solution Artifact"
        title={data.title}
        description="An interactive review surface over canonical backend state — this artifact is a presentation, never the source of truth (ADR-0004)."
        actions={
          <>
            <Badge variant="outline" className={TYPE_BADGES[data.type] ?? ''}>{data.type}</Badge>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigate('renders')}>
              <ArrowLeft className="size-3.5" aria-hidden /> Back
            </Button>
          </>
        }
      />

      <Tabs defaultValue="overview">
        <TabsList className="you-scroll h-auto w-full max-w-full overflow-x-auto">
          {tabs.map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab artifact={data} twinVersion={twinVersion} />
        </TabsContent>
        {data.manifest.twinVersion ? (
          <TabsContent value="compare" className="mt-4">
            <SectionCard title="Version compare" description="This version vs the previous compile" icon={GitCompareArrows}>
              <VersionCompare twinVersion={data.manifest.twinVersion} twinId={twinId} />
            </SectionCard>
          </TabsContent>
        ) : null}
        <TabsContent value="evidence" className="mt-4"><EvidenceTab artifact={data} /></TabsContent>
        <TabsContent value="improve" className="mt-4">
          <ImproveTab artifact={data} twinVersion={twinVersion} twinVersionPending={twinVersionPending} onChanged={refreshArtifact} />
        </TabsContent>
        <TabsContent value="feedback" className="mt-4">
          <FeedbackTab artifact={data} twinVersion={twinVersion} twinVersionPending={twinVersionPending} onChanged={refreshArtifact} />
        </TabsContent>
        {data.manifest.performance ? (
          <TabsContent value="performance" className="mt-4">
            <PerformanceTab performanceId={data.manifest.performance.id} name={data.manifest.performance.name} />
          </TabsContent>
        ) : null}
        <TabsContent value="provenance" className="mt-4">
          <SectionCard title="Provenance chain" description="Chain of custody — inputs, pipeline, evidence, consent, outputs" icon={ShieldCheck}>
            <ProvenanceChain manifest={data.manifest} createdAt={data.createdAt} />
          </SectionCard>
        </TabsContent>
        <TabsContent value="api" className="mt-4">
          <ApiSnippets artifactId={data.id} manifest={data.manifest} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
export default ArtifactView;
