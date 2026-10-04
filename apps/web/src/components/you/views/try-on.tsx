'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Try-on — the virtual try-on surface (P6.C8 — Worker C lane, e-commerce).
//
// What is REAL here:
//  - /api/v1/try-on exists: garment/product asset upload (validation laws +
//    content-addressed storage + merchant provenance), try-on job creation
//    (consent-enforced — rendering a twin requires the render scope), job
//    list/detail through the durable jobs seam;
//  - the comparison display (when a job succeeds): side-by-side baseline |
//    try-on output + the garment identity reference, the diff manifest and
//    the identity-preservation report — verified/unverified/failed are shown
//    EXACTLY as the report says (unknown is unknown, never a guessed score);
//  - the VISUAL-ONLY DISCLAIMER is prominent at the top of the view, on every
//    job row and on every comparison — it is a contract field, not decoration.
//
// Honest limits kept visible ("What's real vs gated" below): the hosted
// try-on PROVIDER is fail-closed behind YOU_TRYON_PROVIDER — without it,
// try-on jobs FAIL with the verbatim reason (shown below verbatim); no stub
// image, no fabricated identity score, ever. Physical fit is OUT OF SCOPE
// for visual try-on by contract.
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle, BadgeCheck, Eye, ImageIcon, Loader2, Plus, RefreshCcw, Shirt,
  ShieldAlert, Upload, UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { GarmentAssetView, TryOnComparisonView, TryOnJobSummaryView } from '@/lib/you/tryon/views';
import type { TwinVersionView } from '@/lib/you/contracts';
import { useJob } from '@/hooks/you/use-job';
import { useYouStore } from '@/hooks/you/use-you-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState, IdChip, KeyValue, PageHeader, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { ApiErrorSurface, useApiErrorSurface } from '@/components/you/shared/degraded-state';
import { QueryError } from '@/components/you/build/confidence';
import { JobSteps } from '@/components/you/lab/job-steps';
import { cn } from '@/lib/utils';

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function isConsentError(err: unknown): boolean {
  return err instanceof YouApiError && (err.code === 'consent_required' || err.status === 403);
}

const STYLES = ['photorealistic', 'stylized-portrait', 'anime', 'illustration'] as const;
type TryOnStyle = (typeof STYLES)[number];

// ─── The contract disclaimer banner (always visible, top of the view) ───────

function VisualOnlyBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-you-tryon-disclaimer
      role="note"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-800 dark:text-amber-300',
        compact ? 'text-xs' : 'text-sm',
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">Visual try-on ≠ physical fit</p>
        <p className={cn('mt-0.5 leading-relaxed', compact ? 'text-[11px]' : 'text-xs')}>
          This surface simulates how a garment <em>appears</em> on your digital twin for visual comparison only.
          Size, measurements, drape, comfort and fabric behavior are not evaluated — confirm with the product&apos;s
          size guide before purchase. This disclaimer is part of the try-on contract, not optional UI text.
        </p>
      </div>
    </div>
  );
}

// ─── Garment upload + library ────────────────────────────────────────────────

function GarmentUploadCard() {
  const qc = useQueryClient();
  const uploadErrors = useApiErrorSurface('Garment upload');
  const [displayName, setDisplayName] = useState('');
  const [productRef, setProductRef] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Choose a garment product image first (png/jpeg/webp, ≤10MB)');
      if (!displayName.trim()) throw new Error('A display name is required');
      return api.tryOn.uploadGarment(file, {
        displayName: displayName.trim(),
        ...(productRef.trim() ? { productRef: productRef.trim() } : {}),
        ...(productUrl.trim() ? { productUrl: productUrl.trim() } : {}),
      });
    },
    onSuccess: (garment) => {
      uploadErrors.clear();
      setDisplayName('');
      setProductRef('');
      setProductUrl('');
      setFile(null);
      toast.success(`Garment "${garment.displayName}" stored (content-addressed, ${garment.bytes} bytes)`);
      qc.invalidateQueries({ queryKey: ['tryon-garments'] });
    },
    onError: (err) => {
      uploadErrors.clear();
      if (uploadErrors.capture(err)) return;
      toast.error(err instanceof Error ? err.message : 'Garment upload failed');
    },
  });

  return (
    <SectionCard
      title="Upload a garment"
      description="Product images follow the evidence upload laws: png/jpeg/webp, ≤10MB, content-addressed storage with merchant provenance (product reference + page URL)."
      icon={Shirt}
    >
      <div className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="garment-name" className="text-xs text-muted-foreground">Display name</Label>
          <Input
            id="garment-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder='e.g. "Aurora Wool Coat"'
            maxLength={120}
            className="h-9"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="garment-ref" className="text-xs text-muted-foreground">Product reference (merchant id)</Label>
            <Input
              id="garment-ref"
              value={productRef}
              onChange={(e) => setProductRef(e.target.value)}
              placeholder="SKU-4821 (optional)"
              maxLength={128}
              className="h-9"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="garment-url" className="text-xs text-muted-foreground">Product page URL</Label>
            <Input
              id="garment-url"
              value={productUrl}
              onChange={(e) => setProductUrl(e.target.value)}
              placeholder="https://shop.example.com/… (optional)"
              maxLength={512}
              className="h-9"
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="garment-file" className="text-xs text-muted-foreground">Garment product image</Label>
          <Input
            id="garment-file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="h-9 text-xs"
          />
        </div>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={upload.isPending || !file || !displayName.trim()}
          onClick={() => upload.mutate()}
        >
          {upload.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
          Upload garment
        </Button>
        <ApiErrorSurface surface={uploadErrors} onRetry={() => upload.mutate()} retrying={upload.isPending} />
      </div>
    </SectionCard>
  );
}

function GarmentLibrary({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  const garments = useQuery({ queryKey: ['tryon-garments'], queryFn: () => api.tryOn.garments() });

  return (
    <SectionCard
      title="Garment library"
      description="Content-addressed product assets. The product reference is preserved verbatim through every try-on artifact."
      icon={ImageIcon}
    >
      {garments.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : garments.isError ? (
        <QueryError
          error={garments.error}
          compact
          onRetry={() => void garments.refetch()}
          title="Could not load garments"
        />
      ) : (garments.data ?? []).length === 0 ? (
        <EmptyState
          icon={Shirt}
          title="No garments yet"
          hint="Upload a garment product image to start trying garments on your twins."
        />
      ) : (
        <div className="grid max-h-96 grid-cols-2 gap-3 overflow-y-auto you-scroll pr-1 sm:grid-cols-3">
          {(garments.data ?? []).map((g: GarmentAssetView) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onSelect(g.id)}
              aria-pressed={selectedId === g.id}
              className={cn(
                'group overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-foreground/25',
                selectedId === g.id && 'border-primary ring-1 ring-primary/40',
              )}
            >
              <img
                src={g.imageUrl}
                alt={`Garment product image: ${g.displayName}`}
                loading="lazy"
                className="h-24 w-full bg-muted object-contain p-1"
              />
              <div className="space-y-0.5 border-t px-2 py-1.5">
                <p className="truncate text-xs font-medium">{g.displayName}</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {g.productRef ?? 'no product ref'}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Create try-on (twin + version + garment + style) ───────────────────────

function CreateTryOnCard({ garmentId }: { garmentId: string }) {
  const qc = useQueryClient();
  const navigate = useYouStore((s) => s.navigate);
  const createErrors = useApiErrorSurface('Try-on creation');
  const [twinId, setTwinId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [style, setStyle] = useState<TryOnStyle>('photorealistic');

  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list() });
  const versions = useQuery({
    queryKey: ['twin-versions', twinId],
    queryFn: () => api.twins.versions(twinId),
    enabled: !!twinId,
  });
  const sortedVersions = versions.data ? [...versions.data].sort((a, b) => b.version - a.version) : [];
  const effectiveVersionId = sortedVersions.some((v: TwinVersionView) => v.id === versionId)
    ? versionId
    : (sortedVersions[0]?.id ?? '');

  const create = useMutation({
    mutationFn: () => {
      if (!twinId) throw new Error('Pick a twin first');
      if (!effectiveVersionId) throw new Error('This twin has no versions yet — compile it first');
      if (!garmentId) throw new Error('Pick a garment first');
      return api.tryOn.create({ twinId, twinVersionId: effectiveVersionId, garmentAssetId: garmentId, style }, uid());
    },
    onSuccess: (res) => {
      createErrors.clear();
      toast.success(`Try-on job started (${res.jobId.slice(0, 8)}) — the provider gate runs first`);
      qc.invalidateQueries({ queryKey: ['tryon-jobs'] });
    },
    onError: (err) => {
      createErrors.clear();
      if (createErrors.capture(err)) return;
      if (isConsentError(err)) {
        toast.error(
          err instanceof YouApiError
            ? err.message
            : 'consent_required — a grant covering rendering is required to try garments on this twin',
        );
      } else {
        toast.error(err instanceof Error ? err.message : 'Try-on creation failed');
      }
    },
  });

  return (
    <SectionCard
      title="Run a virtual try-on"
      description="Consent-enforced: rendering the twin (garment on body) requires an active render-scope grant for the twin's subject."
      icon={Eye}
    >
      {twins.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ) : twins.isError ? (
        <QueryError error={twins.error} compact onRetry={() => void twins.refetch()} title="Could not load twins" />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Twin</Label>
            <Select value={twinId || undefined} onValueChange={(v) => { setTwinId(v); setVersionId(''); }}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={(twins.data ?? []).length ? 'Pick the twin to dress' : 'No twins yet'} />
              </SelectTrigger>
              <SelectContent>
                {(twins.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {twinId ? (
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Twin version</Label>
              <Select value={effectiveVersionId || undefined} onValueChange={(v) => setVersionId(v)}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={sortedVersions.length ? `v${sortedVersions[0].version}` : 'No versions yet'} />
                </SelectTrigger>
                <SelectContent>
                  {sortedVersions.map((v: TwinVersionView) => (
                    <SelectItem key={v.id} value={v.id}>v{v.version}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Baseline style</Label>
            <Select value={style} onValueChange={(v) => setStyle(v as TryOnStyle)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STYLES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              The baseline (garment-off) render derives from the twin&apos;s consented body representation.
            </p>
          </div>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={create.isPending || !twinId || !effectiveVersionId || !garmentId}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
            Run try-on
          </Button>
          {!garmentId ? (
            <p className="text-[11px] text-muted-foreground">Pick a garment from the library to enable this.</p>
          ) : null}
          {twins.data && (twins.data ?? []).length === 0 ? (
            <button
              type="button"
              onClick={() => navigate('twins', { action: 'create' })}
              className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <UserRound className="size-3.5" aria-hidden /> Create a twin first
            </button>
          ) : null}
          <ApiErrorSurface surface={createErrors} onRetry={() => create.mutate()} retrying={create.isPending} />
        </div>
      )}
    </SectionCard>
  );
}

// ─── Identity report rendering (statuses EXACTLY as reported) ───────────────

function IdentityCheckChip({ label, check }: { label: string; check: TryOnComparisonView['identityReport']['garmentIdentity'] }) {
  const tone =
    check.status === 'verified'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : check.status === 'failed'
        ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400'
        : 'border-muted bg-muted/40 text-muted-foreground';
  return (
    <div className={cn('rounded-lg border px-3 py-2', tone)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{label}</span>
        <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider">
          {check.status === 'verified' ? <BadgeCheck className="size-3" aria-hidden /> : null}
          {check.status === 'unverified' ? <ShieldAlert className="size-3" aria-hidden /> : null}
          {check.status}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed opacity-90">{check.reason}</p>
      <p className="mt-1 font-mono text-[10px] opacity-75">
        score: {check.score === null ? 'null (unknown — never guessed)' : check.score.toFixed(3)} · method: {check.method}
      </p>
    </div>
  );
}

// ─── The comparison display (side-by-side + manifest + identity report) ─────

function ComparisonDisplay({ comparison }: { comparison: TryOnComparisonView }) {
  const { sideBySide, diffManifest, identityReport, provider } = comparison;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { img: sideBySide.baseline, title: 'Baseline', sub: 'twin, no garment' },
          { img: sideBySide.tryOn, title: 'Try-on output', sub: 'garment transferred' },
          { img: sideBySide.garment, title: 'Garment reference', sub: sideBySide.garment.displayName },
        ].map(({ img, title, sub }) => (
          <figure key={title} className="overflow-hidden rounded-lg border bg-card">
            <img
              src={img.url}
              alt={`${title}: ${img.label}`}
              loading="lazy"
              className="h-44 w-full bg-muted object-contain p-1"
            />
            <figcaption className="border-t px-2.5 py-1.5">
              <p className="text-xs font-semibold">{title}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {sub}
                {img.contentHash ? ` · ${img.contentHash.slice(0, 10)}` : ''}
              </p>
            </figcaption>
          </figure>
        ))}
      </div>

      <VisualOnlyBanner compact />

      <div className="grid gap-2 sm:grid-cols-2">
        <IdentityCheckChip label="Garment identity" check={identityReport.garmentIdentity} />
        <IdentityCheckChip label="Twin identity" check={identityReport.twinIdentity} />
      </div>
      <KeyValue
        items={[
          { label: 'Product reference', value: identityReport.productRef ?? 'none on the garment' },
          {
            label: 'Product ref preserved',
            value: identityReport.productRefPreserved ? 'yes (structural check)' : 'NO — contract violation',
          },
          {
            label: 'Overall identity checks',
            value: identityReport.checksPassed ? 'all executed checks passed' : 'not all checks passed (see above)',
          },
          { label: 'Provider', value: `${provider.id}${provider.model ? ` · ${provider.model}` : ''}` },
          { label: 'Provider latency', value: provider.realLatency ? `${provider.latencyMs}ms (real)` : `${provider.latencyMs}ms` },
        ]}
      />

      <div className="rounded-lg border bg-card/50 p-3">
        <p className="text-xs font-semibold">Diff manifest — what actually changed</p>
        {diffManifest.providerReportedNothing ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            The provider returned an image but no structured change report — what changed is unknown (honest limit,
            not fabricated).
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {diffManifest.changes.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px]">
                <Badge variant="outline" className="shrink-0 font-mono text-[9px]">{c.region}</Badge>
                <span className="text-muted-foreground">{c.description}</span>
                <span className="ml-auto shrink-0 font-mono text-[9px] uppercase text-muted-foreground/70">{c.source}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Job list + detail ───────────────────────────────────────────────────────

function TryOnJobDetail({ job, onClose }: { job: TryOnJobSummaryView & { comparison: TryOnComparisonView | null }; onClose: () => void }) {
  const durable = useJob(job.jobId);

  return (
    <SectionCard
      title={`Try-on · ${job.twinDisplayName ?? job.twinId} × ${job.garmentDisplayName ?? 'garment'}`}
      description={`Created ${rel(job.createdAt)}${job.productRef ? ` · product ref ${job.productRef}` : ''}`}
      icon={Eye}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={job.status} />
          <Badge variant="outline" className="font-mono">{job.style}</Badge>
          {job.identityChecksPassed === null ? (
            <Badge variant="outline" className="text-muted-foreground">identity: no artifact yet</Badge>
          ) : (
            <Badge variant="outline" className={job.identityChecksPassed ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
              identity checks {job.identityChecksPassed ? 'passed' : 'not all passed'}
            </Badge>
          )}
          <IdChip id={job.id} label="try-on" />
          <Button size="sm" variant="ghost" className="ml-auto gap-1.5" onClick={onClose}>
            Close
          </Button>
        </div>

        {job.error ? (
          <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
            <p className="font-semibold">Failed — the verbatim reason:</p>
            <p className="mt-1 font-mono leading-relaxed">{job.error}</p>
            {/YOU_TRYON_PROVIDER/.test(job.error) ? (
              <p className="mt-2 leading-relaxed">
                This is the fail-closed provider gate: no try-on provider is configured in this environment, so the
                job refuses honestly instead of fabricating a try-on image. An operator must configure
                <span className="font-mono"> YOU_TRYON_PROVIDER</span> (a characterized provider) to enable the hosted path.
              </p>
            ) : null}
          </div>
        ) : null}

        {durable.job ? <JobSteps job={durable.job} compact /> : null}

        {job.comparison ? <ComparisonDisplay comparison={job.comparison} /> : job.status === 'succeeded' ? (
          <p className="text-xs text-muted-foreground">Job succeeded but no comparison artifact was found on the row.</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The comparison (side-by-side, diff manifest, identity report) appears here when the job succeeds.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function TryOnJobList({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  const jobs = useQuery({
    queryKey: ['tryon-jobs'],
    queryFn: () => api.tryOn.jobs(),
    refetchInterval: (q) => {
      const data = q.state.data as TryOnJobSummaryView[] | undefined;
      return data && data.some((j) => j.status === 'queued' || j.status === 'running') ? 2000 : false;
    },
  });

  return (
    <SectionCard
      title="Try-on jobs"
      description="Durable tryon.render jobs — the provider gate runs before any provider spend; failures carry the verbatim reason."
      icon={RefreshCcw}
    >
      {jobs.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : jobs.isError ? (
        <QueryError error={jobs.error} compact onRetry={() => void jobs.refetch()} title="Could not load try-on jobs" />
      ) : (jobs.data ?? []).length === 0 ? (
        <EmptyState
          icon={Shirt}
          title="No try-ons yet"
          hint="Run a try-on: pick a twin, a compiled version and a garment. Without a configured provider the job will fail honestly with the exact reason."
        />
      ) : (
        <ul className="max-h-96 space-y-2 overflow-y-auto you-scroll pr-1">
          {(jobs.data ?? []).map((j) => (
            <li key={j.id}>
              <button
                type="button"
                onClick={() => onSelect(j.id)}
                aria-pressed={selectedId === j.id}
                className={cn(
                  'w-full rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/25',
                  selectedId === j.id && 'border-primary ring-1 ring-primary/40',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={j.status} />
                  <span className="text-xs font-medium">
                    {j.twinDisplayName ?? j.twinId.slice(0, 8)} × {j.garmentDisplayName ?? 'garment'}
                  </span>
                  {j.productRef ? (
                    <Badge variant="outline" className="font-mono text-[10px]">{j.productRef}</Badge>
                  ) : null}
                  <span className="ml-auto text-[10px] text-muted-foreground">{rel(j.createdAt)}</span>
                </div>
                {j.error ? (
                  <p className="mt-1 truncate font-mono text-[10px] text-red-600 dark:text-red-400">{j.error}</p>
                ) : null}
                {j.status === 'succeeded' && j.identityChecksPassed !== null ? (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    identity checks {j.identityChecksPassed ? 'passed' : 'not all passed'} · visual-only (see disclaimer)
                  </p>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ─── The view ────────────────────────────────────────────────────────────────

export function TryOnView() {
  const [garmentId, setGarmentId] = useState('');
  const [jobId, setJobId] = useState('');
  const detail = useQuery({
    queryKey: ['tryon-job', jobId],
    queryFn: () => api.tryOn.getJob(jobId),
    enabled: !!jobId,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Virtual Try-on"
        description="E-commerce garment try-on over twin body representations — honest by contract: visual simulation only, never a physical-fit claim."
      />

      <VisualOnlyBanner />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <CreateTryOnCard garmentId={garmentId} />
          <GarmentUploadCard />
        </div>
        <div className="space-y-6">
          <TryOnJobList selectedId={jobId} onSelect={(id) => setJobId(id === jobId ? '' : id)} />
          <GarmentLibrary selectedId={garmentId} onSelect={(id) => setGarmentId(id === garmentId ? '' : id)} />
        </div>
      </div>

      {jobId ? (
        detail.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : detail.isError ? (
          <QueryError error={detail.error} compact onRetry={() => void detail.refetch()} title="Could not load the try-on job" />
        ) : detail.data ? (
          <TryOnJobDetail job={detail.data} onClose={() => setJobId('')} />
        ) : null
      ) : null}

      <SectionCard title="What's real vs gated" description="The honesty ledger for this surface." icon={ShieldAlert}>
        <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Real:</span> garment upload with validation laws + content-addressed
            storage + merchant provenance; consent-enforced try-on creation (render scope, server-side); durable
            tryon.render jobs with honest step trails; the signed webhook fan-out on
            <span className="font-mono"> tryon.completed</span> (product reference + disclaimer in the payload).
          </li>
          <li>
            <span className="font-medium text-foreground">Gated (fail-closed):</span> the hosted try-on provider runs only
            behind <span className="font-mono">YOU_TRYON_PROVIDER</span> (a characterized provider + its credentials).
            Without it, jobs fail at the provider step with the verbatim reason — never a stub image, never a
            fabricated identity score. The identity report shows <span className="font-mono">unverified / score: null</span>{' '}
            whenever no vision comparison actually ran.
          </li>
          <li>
            <span className="font-medium text-foreground">Out of scope by contract:</span> physical fit — size,
            measurements, drape, comfort and fabric behavior are NEVER claimed by a visual try-on (the disclaimer is a
            contract field on every surface, the merchant callback included).
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}
