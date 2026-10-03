'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Templates — Stage-3 real surface (W3.B, Worker B lane).
// Backed by the wave-2 API: POST/GET /api/v1/templates, GET /templates/:id,
// POST /templates/:id/analyze (durable job, steps polled via useJob).
// A template packages a capture checklist, scene recipes and style presets
// as a versioned record; `analyze` runs the deterministic coverage pass and
// persists the result on the template.
// Honesty rules: validation errors surface VERBATIM from the API 400s, job
// progress shows only real backend signals, no fabricated coverage.
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, BadgeCheck, LayoutTemplate, ListChecks, Loader2, Map, Palette,
  Plus, RefreshCcw, ScanSearch, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { RenderStyle } from '@/lib/you/contracts';
import type { TemplateAnalysis, TemplateView } from '@/lib/you/core/templates';
import { BASE_CHECKLIST } from '@/lib/you/core/checklist';
import { useJob } from '@/hooks/you/use-job';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, IdChip, KeyValue, PageHeader, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { ApiErrorSurface, useApiErrorSurface } from '@/components/you/shared/degraded-state';
import { QueryError } from '@/components/you/build/confidence';
import { JobSteps } from '@/components/you/lab/job-steps';
import { REGION_OPTIONS, regionLabel } from '@/components/you/build/regions';
import { timeAbs, timeAgo } from '@/components/you/build/format';

// Capability families — the coverage baseline the analyze job scores against
// (core/templates.ts CAPABILITY_FAMILIES). Values are frozen contract values.
const CAPABILITY_OPTIONS = ['face', 'hair', 'hands', 'silhouette', 'teeth', 'speech'] as const;

const STYLE_OPTIONS: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly', 'game', 'illustration', 'stylized-portrait',
];

// ─── Editor row types (create dialog local state) ────────────────────────────
interface ChecklistRowState {
  key: string;
  item: string;
  capability: string;
  region: string;
  optional: boolean;
}
interface SceneRowState {
  key: string;
  name: string;
  paramsText: string; // JSON source; parsed + validated on submit
}
interface PresetRowState {
  key: string;
  name: string;
  style: string;
  paramsText: string; // JSON source; parsed + validated on submit
}

const rowKey = () => `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function errMessage(err: unknown): string {
  return err instanceof YouApiError ? err.message
    : err instanceof Error ? err.message
    : 'request failed';
}

/** Parse a JSON object from editor text — honest client-side pre-validation. */
function parseJsonObject(text: string, field: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const t = text.trim() || '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, error: `${field} is not valid JSON` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${field} must be a JSON object` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ─── Create dialog ───────────────────────────────────────────────────────────
function TemplateCreateDialog({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  // Checklist starts as the canonical BASE_CHECKLIST (the server's default when
  // a manifest omits captureChecklist) — what you see is exactly what is posted.
  const [checklist, setChecklist] = useState<ChecklistRowState[]>(() =>
    BASE_CHECKLIST.map((c) => ({ key: rowKey(), item: c.item, capability: c.capability, region: c.region, optional: c.optional })),
  );
  const [scenes, setScenes] = useState<SceneRowState[]>([]);
  const [presets, setPresets] = useState<PresetRowState[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset to a fresh manifest each time the dialog opens (render-phase adjust).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(''); setDescription(''); setNotes(''); setStatus('draft');
      setChecklist(BASE_CHECKLIST.map((c) => ({
        key: rowKey(), item: c.item, capability: c.capability, region: c.region, optional: c.optional,
      })));
      setScenes([]); setPresets([]); setLocalError(null);
    }
  }

  // mutationFn receives the fully-validated body + the idempotency key minted
  // at click time — one uuid per submission attempt (retries of the same
  // attempt reuse it).
  const create = useMutation({
    mutationFn: (vars: {
      body: Parameters<typeof api.templates.create>[0];
      idem: string;
    }) => api.templates.create(vars.body, vars.idem),
    onSuccess: (template) => {
      toast.success('Template created', {
        description: `${template.name} v${template.version} · ${template.manifest.captureChecklist.length} checklist items · ${template.scenes.length} scene(s)`,
      });
      void qc.invalidateQueries({ queryKey: ['templates'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onOpenChange(false);
    },
    onError: (err) => {
      // Surface the API's honest 400 message verbatim in the dialog + toast.
      setLocalError(errMessage(err));
      toast.error('Could not create template', { description: errMessage(err) });
    },
  });

  const submit = () => {
    setLocalError(null);
    if (!name.trim()) { setLocalError('field "name" is required (non-empty string)'); return; }
    const emptyItem = checklist.find((c) => !c.item.trim());
    if (emptyItem) { setLocalError('every checklist item needs a non-empty item label'); return; }
    const emptyScene = scenes.find((s) => !s.name.trim());
    if (emptyScene) { setLocalError('every scene recipe needs a non-empty name'); return; }
    const emptyPreset = presets.find((p) => !p.name.trim());
    if (emptyPreset) { setLocalError('every style preset needs a non-empty name'); return; }

    const scenesOut: { name: string; parameters: Record<string, unknown> }[] = [];
    for (const s of scenes) {
      const p = parseJsonObject(s.paramsText, `Scene "${s.name.trim()}" parameters`);
      if (!p.ok) { setLocalError(p.error); return; }
      scenesOut.push({ name: s.name.trim(), parameters: p.value });
    }
    const presetsOut: { name: string; style: RenderStyle; params: Record<string, unknown> }[] = [];
    for (const p of presets) {
      const pp = parseJsonObject(p.paramsText, `Preset "${p.name.trim()}" params`);
      if (!pp.ok) { setLocalError(pp.error); return; }
      presetsOut.push({ name: p.name.trim(), style: p.style as RenderStyle, params: pp.value });
    }

    create.mutate({
      idem: uid(),
      body: {
        name: name.trim(),
        description: description.trim() || undefined,
        notes: notes.trim() || undefined,
        status,
        captureChecklist: checklist.map((c) => ({
          item: c.item.trim(),
          capability: c.capability,
          region: c.region as (typeof REGION_OPTIONS)[number]['value'],
          optional: c.optional,
        })),
        scenes: scenesOut,
        stylePresets: presetsOut,
      },
    });
  };

  const setChecklistRow = (key: string, patch: Partial<ChecklistRowState>) =>
    setChecklist((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="you-scroll max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate className="size-4 text-muted-foreground" aria-hidden /> New template
          </DialogTitle>
          <DialogDescription>
            Register a versioned template manifest — capture checklist, scene recipes and style presets. Coverage is analyzed after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="tpl-name">Name</Label>
              <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Studio portrait — full coverage" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as 'draft' | 'published')}>
                <SelectTrigger className="h-9" aria-label="Status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">draft</SelectItem>
                  <SelectItem value="published">published</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="tpl-desc">Description (optional)</Label>
            <Input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this template is for" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="tpl-notes">Manifest notes (optional)</Label>
            <Input id="tpl-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Derived from the canonical base checklist" className="h-9" />
          </div>

          {/* ── Capture checklist ── */}
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5 text-xs">
                <ListChecks className="size-3.5 text-muted-foreground" aria-hidden /> Capture checklist
                <span className="you-num text-muted-foreground">({checklist.length}/24)</span>
              </Label>
              <Button
                type="button" variant="outline" size="sm" className="h-7 gap-1"
                disabled={checklist.length >= 24}
                onClick={() => setChecklist((rows) => [...rows, { key: rowKey(), item: '', capability: 'face', region: 'face.front', optional: false }])}
              >
                <Plus className="size-3" aria-hidden /> Add item
              </Button>
            </div>
            <div className="space-y-2">
              {checklist.map((row) => (
                <div key={row.key} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto_auto] sm:items-center">
                  <Input
                    value={row.item}
                    onChange={(e) => setChecklistRow(row.key, { item: e.target.value })}
                    placeholder="Item — e.g. Front-facing photo"
                    aria-label="Checklist item label"
                    className="h-8 text-xs"
                  />
                  <Select value={row.capability} onValueChange={(v) => setChecklistRow(row.key, { capability: v })}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Capability"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CAPABILITY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={row.region} onValueChange={(v) => setChecklistRow(row.key, { region: v })}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Capture region"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {REGION_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <label className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground" title="Optional items are waived in targeted capture">
                    <Checkbox checked={row.optional} onCheckedChange={(v) => setChecklistRow(row.key, { optional: v === true })} aria-label="Optional" />
                    opt
                  </label>
                  <Button
                    type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-red-600"
                    disabled={checklist.length <= 1}
                    onClick={() => setChecklist((rows) => rows.filter((r) => r.key !== row.key))}
                    aria-label="Remove checklist item"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Prefilled with the canonical base checklist (core/checklist.ts) — the same default the API applies when a manifest omits <span className="font-mono">captureChecklist</span>.
            </p>
          </div>

          {/* ── Scene recipes ── */}
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5 text-xs">
                <Map className="size-3.5 text-muted-foreground" aria-hidden /> Scene recipes
                <span className="you-num text-muted-foreground">({scenes.length}/16)</span>
              </Label>
              <Button
                type="button" variant="outline" size="sm" className="h-7 gap-1"
                disabled={scenes.length >= 16}
                onClick={() => setScenes((rows) => [...rows, { key: rowKey(), name: '', paramsText: '{}' }])}
              >
                <Plus className="size-3" aria-hidden /> Add scene
              </Button>
            </div>
            {scenes.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No scene recipes — scene composition is left to the renderer at render time.
              </p>
            ) : (
              <div className="space-y-2">
                {scenes.map((row) => (
                  <div key={row.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-start">
                    <Input
                      value={row.name}
                      onChange={(e) => setScenes((rows) => rows.map((r) => (r.key === row.key ? { ...r, name: e.target.value } : r)))}
                      placeholder="Scene name — e.g. studio-a"
                      aria-label="Scene name"
                      className="h-8 text-xs"
                    />
                    <Textarea
                      value={row.paramsText}
                      onChange={(e) => setScenes((rows) => rows.map((r) => (r.key === row.key ? { ...r, paramsText: e.target.value } : r)))}
                      placeholder='{"lighting":"softbox"}'
                      aria-label="Scene parameters (JSON object)"
                      className="min-h-8 resize-y font-mono text-[11px]"
                      rows={2}
                    />
                    <Button
                      type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-red-600"
                      onClick={() => setScenes((rows) => rows.filter((r) => r.key !== row.key))}
                      aria-label="Remove scene"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Style presets ── */}
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5 text-xs">
                <Palette className="size-3.5 text-muted-foreground" aria-hidden /> Style presets
                <span className="you-num text-muted-foreground">({presets.length}/16)</span>
              </Label>
              <Button
                type="button" variant="outline" size="sm" className="h-7 gap-1"
                disabled={presets.length >= 16}
                onClick={() => setPresets((rows) => [...rows, { key: rowKey(), name: '', style: 'photorealistic', paramsText: '{}' }])}
              >
                <Plus className="size-3" aria-hidden /> Add preset
              </Button>
            </div>
            {presets.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No style presets — the render style is chosen at render time.
              </p>
            ) : (
              <div className="space-y-2">
                {presets.map((row) => (
                  <div key={row.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-start">
                    <Input
                      value={row.name}
                      onChange={(e) => setPresets((rows) => rows.map((r) => (r.key === row.key ? { ...r, name: e.target.value } : r)))}
                      placeholder="Preset name — e.g. natural"
                      aria-label="Style preset name"
                      className="h-8 text-xs"
                    />
                    <Select value={row.style} onValueChange={(v) => setPresets((rows) => rows.map((r) => (r.key === row.key ? { ...r, style: v } : r)))}>
                      <SelectTrigger className="h-8 text-xs" aria-label="Render style"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {STYLE_OPTIONS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Textarea
                      value={row.paramsText}
                      onChange={(e) => setPresets((rows) => rows.map((r) => (r.key === row.key ? { ...r, paramsText: e.target.value } : r)))}
                      placeholder='{"quality":"high"}'
                      aria-label="Preset params (JSON object)"
                      className="min-h-8 resize-y font-mono text-[11px]"
                      rows={2}
                    />
                    <Button
                      type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-red-600"
                      onClick={() => setPresets((rows) => rows.filter((r) => r.key !== row.key))}
                      aria-label="Remove style preset"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {localError ? (
            <div role="alert" className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
              {localError}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="gap-1.5" disabled={!name.trim() || create.isPending} onClick={submit}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            Create template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Coverage analysis display (deterministic, persisted on the template) ────
function AnalysisPanel({ analysis }: { analysis: TemplateAnalysis }) {
  const invalidBits: string[] = [];
  if (analysis.checklist.invalidRegions.length) invalidBits.push(`invalid regions: ${analysis.checklist.invalidRegions.join(', ')}`);
  if (analysis.scenes.invalid.length) invalidBits.push(`${analysis.scenes.invalid.length} invalid scene recipe(s)`);
  if (analysis.stylePresets.invalid.length) invalidBits.push(`unknown render styles: ${analysis.stylePresets.invalid.join(', ')}`);

  return (
    <div className="space-y-4">
      <KeyValue
        items={[
          { label: 'Analyzed at', value: <span title={analysis.analyzedAt}>{timeAbs(analysis.analyzedAt)}</span> },
          { label: 'Checklist', value: <span className="you-num">{analysis.checklist.items} items · {analysis.checklist.required} required · {analysis.checklist.optional} optional</span> },
          { label: 'Scene recipes', value: <span className="you-num">{analysis.scenes.count}</span> },
          { label: 'Style presets', value: <span className="you-num">{analysis.stylePresets.count}</span> },
        ]}
      />

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Capability coverage</div>
        <div className="flex flex-wrap gap-1.5">
          {analysis.capabilities.covered.map((c) => (
            <Badge key={c} variant="outline" className="gap-1 border-emerald-500/25 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400">
              <BadgeCheck className="size-3" aria-hidden /> {c}
            </Badge>
          ))}
          {analysis.capabilities.uncovered.map((c) => (
            <Badge key={c} variant="outline" className="border-zinc-500/25 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400">
              {c} · uncovered
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Evidence gaps — left to targeted evidence</div>
        {analysis.evidenceGaps.length ? (
          <div className="flex flex-wrap gap-1.5">
            {analysis.evidenceGaps.map((r) => (
              <Badge key={r} variant="outline" className="border-amber-500/25 bg-amber-500/12 text-amber-700 dark:text-amber-400">
                {regionLabel(r)}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">None — the checklist exercises every important region.</p>
        )}
      </div>

      {invalidBits.length ? (
        <div role="alert" className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          {invalidBits.join(' · ')}
        </div>
      ) : null}

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes (reported by the analyzer)</div>
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          {analysis.notes.map((n, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />{n}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── Detail (inline panel — manifest inspector, scenes, analysis + analyze) ──
function TemplateDetail({
  templateId, initial, onBack,
}: {
  templateId: string;
  initial: TemplateView;
  onBack: () => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, done, succeeded } = useJob(jobId);

  const q = useQuery({
    queryKey: ['template', templateId],
    queryFn: () => api.templates.get(templateId),
    initialData: initial,
  });
  const t = q.data;

  // P6.B8: typed error surface for the analyze route's honest refusals (503
  // provider/service unavailable, 429 rate-limited) — inline retry guidance
  // derived from the backend's retryAfterMs, not a bare toast. Declared BEFORE
  // the q.isError early return below so the hook order is stable in both modes.
  const analyzeErrors = useApiErrorSurface('Template analysis');
  const analyze = useMutation({
    // idem key is minted per submission attempt by the caller
    mutationFn: (idem: string) => api.templates.analyze(templateId, idem),
    onSuccess: (res) => {
      analyzeErrors.clear();
      setJobId(res.jobId);
      toast.success(`Analyze job ${res.jobId.slice(0, 8)} started`);
    },
    onError: (err) => {
      // honest degraded/rate-limited surfaces with retry guidance — not toasts
      if (analyzeErrors.capture(err)) return;
      toast.error(`Analyze failed — ${errMessage(err)}`);
    },
  });

  const runAnalyze = () => analyze.mutate(uid());

  if (q.isError) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="size-3.5" aria-hidden /> Back to templates
        </Button>
        <QueryError error={q.error} title="Could not load template" onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const checklist = t.manifest.captureChecklist;
  const presets = t.manifest.stylePresets;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <Button variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={onBack}>
            <ArrowLeft className="size-3.5" aria-hidden /> Back to templates
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{t.name}</h1>
          {t.description ? <p className="max-w-2xl text-sm text-muted-foreground">{t.description}</p> : null}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <StatusBadge status={t.status} />
            <Badge variant="outline" className="you-num font-mono">v{t.version}</Badge>
            <IdChip id={t.id} label="template" />
          </div>
        </div>
        <Button className="gap-1.5" onClick={runAnalyze} disabled={analyze.isPending}>
          {analyze.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ScanSearch className="size-4" aria-hidden />}
          {t.analysis ? 'Re-run analyze' : 'Run analyze'}
        </Button>
      </div>

      {/* P6.B8 — honest error surface: the analyze route refused with a typed
          503 (provider unavailable) or 429 (rate-limited). Retry guidance
          derives from the backend's retryAfterMs; the retry mints a fresh
          idem key, exactly like the header button's click path. */}
      <ApiErrorSurface
        surface={analyzeErrors}
        onRetry={runAnalyze}
        retrying={analyze.isPending}
      />

      {jobId ? (
        <SectionCard title="Coverage analysis job" description={done ? undefined : 'Polling the durable job — steps are real backend signals only.'}>
          <JobSteps job={job} compact />
          {done && succeeded ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Analysis persisted on the template — the coverage panel below reflects the latest result.
            </p>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title="Coverage analysis" icon={ScanSearch} description={t.analysis ? `Deterministic pass over the declared manifest (v${t.analysis.templateVersion})` : undefined}>
        {t.analysis ? (
          <AnalysisPanel analysis={t.analysis} />
        ) : (
          <EmptyState
            icon={ScanSearch}
            title="Not analyzed yet"
            hint="Run the deterministic coverage pass to see which capabilities this template exercises and which it leaves to targeted evidence."
            action={
              <Button size="sm" variant="outline" className="gap-1.5" onClick={runAnalyze} disabled={analyze.isPending}>
                {analyze.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ScanSearch className="size-3.5" aria-hidden />} Run analyze
              </Button>
            }
          />
        )}
      </SectionCard>

      <SectionCard title="Capture checklist" icon={ListChecks} description={`${checklist.length} item(s) — ${checklist.filter((c) => !c.optional).length} required · ${checklist.filter((c) => c.optional).length} optional`}>
        <div className="max-h-72 you-scroll overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Capability</TableHead>
                <TableHead>Region</TableHead>
                <TableHead className="text-right">Optional</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {checklist.map((c, i) => (
                <TableRow key={`${c.item}-${i}`}>
                  <TableCell className="max-w-64">
                    <div className="truncate font-medium" title={c.instructions}>{c.item}</div>
                    <div className="truncate text-[11px] text-muted-foreground" title={c.expectedSignal}>{c.expectedSignal}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.capability}</TableCell>
                  <TableCell className="text-xs">{regionLabel(c.region)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{c.optional ? 'yes' : 'no'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {t.manifest.notes ? (
          <p className="mt-3 text-xs text-muted-foreground"><span className="font-medium text-foreground/80">Notes:</span> {t.manifest.notes}</p>
        ) : null}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Scene recipes" icon={Map} description={`${t.scenes.length} attached`}>
          {t.scenes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No scene recipes attached — scene composition is left to the renderer at render time.</p>
          ) : (
            <ul className="space-y-3">
              {t.scenes.map((s) => (
                <li key={s.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{s.name}</span>
                    <IdChip id={s.id} label="scene" />
                  </div>
                  <pre className="max-h-40 you-scroll overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(s.parameters, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Style presets" icon={Palette} description={`${presets.length} declared`}>
          {presets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No style presets declared — the render style is chosen at render time.</p>
          ) : (
            <ul className="space-y-3">
              {presets.map((p, i) => (
                <li key={`${p.name}-${i}`} className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">{p.style}</Badge>
                  </div>
                  <pre className="max-h-40 you-scroll overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(p.params, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Record" icon={LayoutTemplate}>
        <KeyValue
          items={[
            { label: 'Version', value: <span className="you-num font-mono">v{t.version}</span> },
            { label: 'Status', value: <StatusBadge status={t.status} /> },
            { label: 'Created', value: <span title={t.createdAt}>{timeAbs(t.createdAt)}</span> },
            { label: 'Updated', value: <span title={t.updatedAt}>{timeAbs(t.updatedAt)}</span> },
            { label: 'Analyzed', value: t.analyzedAt ? <span title={t.analyzedAt}>{timeAgo(t.analyzedAt)}</span> : <span className="text-muted-foreground">never</span> },
            { label: 'Scenes', value: <span className="you-num">{t.scenes.length}</span> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

// ─── View (list mode) ────────────────────────────────────────────────────────
export function TemplatesView() {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.templates.list() });

  // ── Detail mode ────────────────────────────────────────────────────────────
  const selected = selectedId ? templates.data?.find((t) => t.id === selectedId) : undefined;
  if (selectedId && selected) {
    return <TemplateDetail key={selected.id} templateId={selected.id} initial={selected} onBack={() => setSelectedId(null)} />;
  }

  // ── List mode ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Templates"
        description="Reusable capture templates and scene recipes — versioned manifests that package a capture checklist, scene composition and style presets, with deterministic coverage analysis."
        actions={
          <>
            <Button
              variant="outline" size="sm" className="gap-1.5"
              onClick={() => templates.refetch()} disabled={templates.isRefetching}
            >
              <RefreshCcw className={templates.isRefetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden /> Refresh
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" aria-hidden /> New template
            </Button>
          </>
        }
      />

      <SectionCard title="Templates" description={`${templates.data?.length ?? 0} recorded`} icon={LayoutTemplate}>
        {templates.isPending ? (
          <div className="space-y-2.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : templates.isError ? (
          <QueryError
            error={templates.error}
            title="Could not load templates"
            onRetry={() => void templates.refetch()}
          />
        ) : !templates.data?.length ? (
          <EmptyState
            icon={LayoutTemplate}
            title="No templates yet"
            hint="A template packages a capture checklist, scene recipes and style presets as a versioned record — a proven capture-and-render flow made reusable. Register one, then run the coverage analysis."
            action={<Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" aria-hidden /> New template</Button>}
          />
        ) : (
          <div className="max-h-[560px] you-scroll overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Checklist</TableHead>
                  <TableHead className="text-right">Scenes</TableHead>
                  <TableHead className="text-right">Presets</TableHead>
                  <TableHead>Analyzed</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.data.map((t) => (
                  <TableRow
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open template ${t.name}`}
                    className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => setSelectedId(t.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(t.id); } }}
                  >
                    <TableCell className="max-w-48">
                      <div className="truncate font-medium">{t.name}</div>
                      {t.description ? <div className="truncate text-[11px] text-muted-foreground">{t.description}</div> : null}
                    </TableCell>
                    <TableCell><span className="you-num font-mono text-xs">v{t.version}</span></TableCell>
                    <TableCell><StatusBadge status={t.status} /></TableCell>
                    <TableCell className="you-num text-right font-mono text-xs">{t.manifest.captureChecklist.length}</TableCell>
                    <TableCell className="you-num text-right font-mono text-xs">{t.scenes.length}</TableCell>
                    <TableCell className="you-num text-right font-mono text-xs">{t.manifest.stylePresets.length}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.analyzedAt ? <span title={t.analyzedAt}>{timeAgo(t.analyzedAt)}</span> : <span title="Run analyze from the detail panel">not yet</span>}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(t.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <TemplateCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
export default TemplatesView;
