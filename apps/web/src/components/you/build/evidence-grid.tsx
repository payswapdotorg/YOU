'use client';
// Evidence asset grid with lazily signed thumbnails.
// Raw evidence is immutable; access is via short-lived signed URLs only.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { IdChip } from '@/components/you/shared/primitives';
import { api } from '@/lib/you/client/api';
import type { EvidenceAssetView, EvidenceQuality } from '@/lib/you/contracts';
import { FileAudio, FileVideo, ImageIcon, ImageOff, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes, timeAgo } from './format';
import { regionLabel } from './regions';

/** Lazily fetches a signed URL and renders the evidence thumbnail. */
function SignedImage({ assetId, alt, className }: { assetId: string; alt: string; className?: string }) {
  const q = useQuery({
    queryKey: ['evidence-url', assetId],
    queryFn: () => api.captures.signEvidence(assetId),
    staleTime: 60_000,
    retry: 1,
  });
  if (q.isPending) return <Skeleton className={cn('h-full w-full', className)} />;
  if (q.isError) {
    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center gap-1 bg-muted/60 text-muted-foreground', className)} role="img" aria-label={`${alt} (preview unavailable)`}>
        <ImageOff className="size-4" aria-hidden />
        <span className="px-2 text-center text-[10px] leading-tight">preview unavailable</span>
      </div>
    );
  }
  return (
    // signed, short-lived object-storage URLs — not part of the Next image pipeline
    <img src={q.data.url} alt={alt} loading="lazy" className={cn('h-full w-full object-cover', className)} />
  );
}

function KindTile({ kind, className }: { kind: EvidenceAssetView['kind']; className?: string }) {
  const Icon = kind === 'video' ? FileVideo : kind === 'audio' ? FileAudio : ImageIcon;
  return (
    <div className={cn('flex h-full w-full items-center justify-center bg-muted/60', className)}>
      <Icon className="size-5 text-muted-foreground" aria-hidden />
    </div>
  );
}

/** Per-asset quality chips (only after analysis — never guessed). */
export function QualityChips({ quality }: { quality: EvidenceQuality | null }) {
  if (!quality) {
    return <Badge variant="outline" className="text-[10.5px] text-muted-foreground">awaiting analysis</Badge>;
  }
  const tone = (bad: boolean, mid: boolean) =>
    bad ? 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400'
      : mid ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant="outline" className={cn('you-num text-[10.5px]', quality.usable
        ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
        : 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400')}>
        {quality.usable ? `usable ${Math.round(quality.score * 100)}%` : 'not usable'}
      </Badge>
      <Badge variant="outline" className={cn('you-num text-[10.5px]', tone(quality.blur === 'heavy', quality.blur === 'light'))}>
        blur: {quality.blur}
      </Badge>
      <Badge variant="outline" className={cn('you-num text-[10.5px]', tone(quality.lighting === 'poor', quality.lighting === 'uneven'))}>
        light: {quality.lighting}
      </Badge>
      {quality.coverage.length > 0 ? (
        <Badge variant="outline" className="text-[10.5px] text-muted-foreground">
          {quality.coverage.map(regionLabel).join(' · ')}
        </Badge>
      ) : null}
    </div>
  );
}

/** Grid of evidence assets with signed thumbnails + honest quality chips. */
export function EvidenceGrid({ assets, emptyHint }: { assets: EvidenceAssetView[]; emptyHint?: string }) {
  const [preview, setPreview] = useState<EvidenceAssetView | null>(null);
  if (assets.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-card/40 px-4 py-6 text-center text-xs text-muted-foreground">
        {emptyHint ?? 'No evidence assets uploaded to this session yet.'}
      </p>
    );
  }
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((asset) => (
          <li key={asset.id}>
            <button
              type="button"
              onClick={() => asset.kind === 'image' && setPreview(asset)}
              className={cn(
                'group w-full overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring',
                asset.kind !== 'image' && 'cursor-default',
              )}
              aria-label={`Evidence asset ${asset.id}, ${asset.kind}, ${formatBytes(asset.bytes)}`}
            >
              <div className="aspect-[4/3] w-full overflow-hidden">
                {asset.kind === 'image'
                  ? <SignedImage assetId={asset.id} alt={`Evidence ${asset.id}`} />
                  : <KindTile kind={asset.kind} />}
              </div>
              <div className="space-y-1.5 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="you-num text-[10.5px] text-muted-foreground">{formatBytes(asset.bytes)}</span>
                  <span className="text-[10.5px] text-muted-foreground">{timeAgo(asset.createdAt)}</span>
                </div>
                {asset.quality?.issues && asset.quality.issues.length > 0 ? (
                  <p className="flex items-start gap-1 text-[10.5px] leading-tight text-amber-700 dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span className="line-clamp-2">{asset.quality.issues.join('; ')}</span>
                  </p>
                ) : (
                  <QualityChips quality={asset.quality} />
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              Evidence asset {preview ? <IdChip id={preview.id} label="" /> : null}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {preview ? `${preview.kind} · ${preview.regions.map(regionLabel).join(', ') || 'no region'} · ${formatBytes(preview.bytes)} · ${preview.mime}` : ''}
            </DialogDescription>
          </DialogHeader>
          {preview ? (
            <>
              <div className="overflow-hidden rounded-lg border bg-muted/40">
                {preview.kind === 'image'
                  ? <SignedImage assetId={preview.id} alt={`Evidence ${preview.id}`} className="max-h-[60vh] w-full object-contain" />
                  : <KindTile kind={preview.kind} className="h-40" />}
              </div>
              <div className="space-y-2">
                <QualityChips quality={preview.quality} />
                <p className="break-all font-mono text-[11px] text-muted-foreground">sha256: {preview.contentHash}</p>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
