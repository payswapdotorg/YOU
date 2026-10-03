'use client';
// Capture uploader — per-checklist-item and free-form evidence upload with
// region multi-select. Uploads go straight to the immutable evidence store via
// the signed capture-session endpoint; consent_required errors surface the
// consent gate instead of being swallowed.
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { api, YouApiError } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import type { CaptureChecklistItem, CaptureRegion } from '@/lib/you/contracts';
import { Check, ChevronDown, FileUp, Loader2, RotateCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { REGION_OPTIONS } from './regions';

function acceptFor(regions: CaptureRegion[]): string {
  if (regions.includes('walking') && regions.length === 1) return 'video/*';
  if (regions.includes('speech') && regions.length === 1) return 'audio/*';
  if (regions.length === 0) return 'image/*,video/*,audio/*';
  return 'image/*';
}

/** Region multi-select chips. */
function RegionPicker({
  selected, onToggle, disabled,
}: {
  selected: CaptureRegion[];
  onToggle: (r: CaptureRegion) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Capture regions for this upload">
      {REGION_OPTIONS.map((r) => {
        const on = selected.includes(r.value);
        return (
          <button
            key={r.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onToggle(r.value)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50',
              on
                ? 'border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                : 'border-border bg-muted/40 text-muted-foreground hover:border-foreground/25',
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One upload control: region selection + file attach. `defaultRegions` seeds
 * the selection (the checklist item's region); `free` allows any selection.
 */
export function UploadControl({
  sessionId, twinId, defaultRegions = [], free = false, onConsentRequired,
}: {
  sessionId: string;
  twinId: string;
  defaultRegions?: CaptureRegion[];
  free?: boolean;
  onConsentRequired: (hint: string) => void;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [regions, setRegions] = useState<CaptureRegion[]>(defaultRegions);
  const [file, setFile] = useState<File | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null); // consent_required message

  const upload = useMutation({
    mutationFn: (f: File) => api.captures.upload(sessionId, f, regions.length > 0 ? regions : defaultRegions),
    onSuccess: (asset) => {
      toast.success('Evidence uploaded', {
        description: `${asset.id.slice(0, 16)}… stored — quality analysis pending.`,
      });
      setFile(null);
      setBlocked(null);
      void qc.invalidateQueries({ queryKey: ['capture', sessionId] });
      void qc.invalidateQueries({ queryKey: ['twin', twinId] });
      void qc.invalidateQueries({ queryKey: ['captures'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (err) => {
      if (err instanceof YouApiError && err.code === 'consent_required') {
        setBlocked(err.message || 'A consent grant covering capture is required before uploading evidence.');
        onConsentRequired(err.message || 'Capture scope missing — grant consent to continue.');
      } else {
        toast.error('Upload failed', { description: err instanceof YouApiError ? describeApiError(err) : (err instanceof Error ? err.message : 'Unexpected error') });
      }
    },
  });

  const toggle = (r: CaptureRegion) => {
    setRegions((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  };

  const pick = () => inputRef.current?.click();
  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setBlocked(null); upload.mutate(f); }
    e.target.value = ''; // allow re-picking the same file on retry
  };

  return (
    <div className="space-y-2 rounded-lg border bg-muted/25 p-3">
      {free ? (
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <FileUp className="size-3" aria-hidden /> Free upload — select regions
        </div>
      ) : null}
      <RegionPicker selected={regions} onToggle={toggle} disabled={upload.isPending} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={acceptFor(free ? [] : regions)}
          onChange={onPicked}
          className="hidden"
          aria-label={free ? 'Upload evidence file' : `Upload evidence for ${defaultRegions.join(', ')}`}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11.5px]"
          onClick={pick}
          disabled={upload.isPending || (free && regions.length === 0)}
          title={free && regions.length === 0 ? 'Select at least one region first' : undefined}
        >
          {upload.isPending
            ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
            : <FileUp className="size-3.5" aria-hidden />}
          {upload.isPending ? 'Uploading…' : file ? 'Retry upload' : 'Attach file'}
        </Button>
        {file ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={file.name}>
            {file.name} · {Math.round(file.size / 1024)} KB
          </span>
        ) : null}
        {blocked ? (
          <span role="alert" className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <X className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate" title={blocked}>blocked — consent required</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 shrink-0 gap-1 px-2 text-[10.5px]"
              onClick={() => file && upload.mutate(file)}
              disabled={upload.isPending}
            >
              <RotateCw className="size-3" aria-hidden /> Retry
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Compact per-item attach row used inside the checklist. */
export function ChecklistItemRow({
  item, sessionId, twinId, onConsentRequired, disabled,
}: {
  item: CaptureChecklistItem;
  sessionId: string;
  twinId: string;
  onConsentRequired: (hint: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{item.item}</span>
            <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
              {item.region}
            </span>
            {item.status === 'provided' ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : null}
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground">{item.instructions}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground/75">
            <span className="font-medium">Expected signal:</span> {item.expectedSignal}
          </p>
        </div>
        {!disabled && item.status === 'pending' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1 px-2.5 text-[11.5px]"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <FileUp className="size-3.5" aria-hidden /> Upload
            <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
          </Button>
        ) : (
          <span className="you-num shrink-0 rounded-full border bg-muted/40 px-2 py-0.5 text-[10.5px] text-muted-foreground">
            {item.status}
          </span>
        )}
      </div>
      {open && !disabled && item.status === 'pending' ? (
        <div className="mt-3">
          <UploadControl sessionId={sessionId} twinId={twinId} defaultRegions={[item.region]} onConsentRequired={onConsentRequired} />
        </div>
      ) : null}
    </li>
  );
}
