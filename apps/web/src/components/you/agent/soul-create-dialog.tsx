'use client';
// Create Agent Soul dialog (P6.C6 production runtime) — a Soul is
// personality/behavior configuration BOUND TO A TWIN, with an honest
// capability manifest, behavior params and a deterministic seed. Created as
// DRAFT; activate from the list.
//
// P6.B7 — provider wiring: the provider is chosen from the C5 AI model
// registry surface (GET /api/v1/agent/providers — env-credential health,
// fail-closed) and validated server-side on create (wave-1 chat-adapter
// allow-list). Providers without a chat adapter are shown WITH their honest
// reason and are not selectable — the UI mirrors the server truth instead of
// letting a doomed submit happen. Credentials are NEVER entered here: the
// registry reads env keys server-side only.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ghost, Loader2, Plus, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { SoulProviderStatusRow } from '@/lib/you/agent/soul-providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const CAPABILITIES = [
  { key: 'conversation', label: 'conversation', hint: 'run chat turns (required for sessions)' },
  { key: 'tool-use', label: 'tool-use', hint: 'invoke read/list agent tools' },
  { key: 'evidence-request', label: 'evidence-request', hint: 'create additional-evidence requests' },
] as const;

function parseList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function SoulCreateDialog({
  providers,
  providersPending,
  providersError,
  onRetryProviders,
}: {
  /** resolved C5 registry provider rows (the view owns the query). */
  providers: SoulProviderStatusRow[];
  providersPending: boolean;
  providersError: boolean;
  onRetryProviders: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [twinId, setTwinId] = useState('');
  const [tagline, setTagline] = useState('');
  const [traits, setTraits] = useState('');
  const [speakingStyle, setSpeakingStyle] = useState('');
  const [providerId, setProviderId] = useState('zai');
  const [model, setModel] = useState('glm-fast');
  const [thinking, setThinking] = useState(false);
  const [temperature, setTemperature] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>(['conversation']);
  const qc = useQueryClient();

  const twins = useQuery({
    queryKey: ['twins'],
    queryFn: () => api.twins.list(),
    // only fetch when the dialog is actually open (registry context loads on demand)
    enabled: open,
  });

  const selectedProvider = providers.find((p) => p.id === providerId) ?? null;

  const create = useMutation({
    mutationFn: () =>
      api.agentRuntime.createSoul(
        {
          name: name.trim(),
          twinId,
          ...(description.trim() ? { description: description.trim() } : {}),
          persona: {
            ...(tagline.trim() ? { tagline: tagline.trim() } : {}),
            ...(parseList(traits).length ? { traits: parseList(traits) } : {}),
            ...(speakingStyle.trim() ? { speakingStyle: speakingStyle.trim() } : {}),
          },
          provider: providerId,
          model,
          params: {
            thinking,
            ...(temperature.trim() && Number.isFinite(Number(temperature))
              ? { temperature: Number(temperature) }
              : {}),
          },
          capabilities,
        },
        uid(),
      ),
    onSuccess: (soul) => {
      toast.success(`Soul “${soul.name}” created (v1, draft, seed ${soul.seed}) — activate it to start sessions`);
      qc.invalidateQueries({ queryKey: ['agent-runtime-souls'] });
      setOpen(false);
      setName(''); setDescription(''); setTwinId(''); setTagline(''); setTraits(''); setSpeakingStyle('');
      setProviderId('zai'); setModel('glm-fast'); setThinking(false); setTemperature(''); setCapabilities(['conversation']);
    },
    onError: (err) => {
      const msg = err instanceof YouApiError ? err.message : 'request failed';
      toast.error(`Create soul failed — ${msg}`);
    },
  });

  // fail-closed provider wiring: without the registry status the provider
  // cannot be honestly configured — Create stays disabled with the reason
  const providersKnown = !providersPending && !providersError;
  const providerSelectable = providers.some((p) => p.available);
  const canSubmit = providersKnown && providerSelectable
    && name.trim().length > 0 && !!twinId && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Plus className="size-3.5" aria-hidden /> New Soul
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ghost className="size-4 text-muted-foreground" aria-hidden /> New Agent Soul
          </DialogTitle>
          <DialogDescription>
            A Soul is personality/behavior configuration bound to a Twin. Behavior is versioned and reproducible:
            the seed is recorded on every turn. Created as <span className="font-mono">draft</span>; activate it from the list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="soul-name" className="text-xs">Name</Label>
              <Input id="soul-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Warm Host" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Twin <span className="font-normal text-muted-foreground">(required)</span></Label>
              <Select value={twinId || undefined} onValueChange={setTwinId}>
                <SelectTrigger className="h-9" aria-label="Twin"><SelectValue placeholder={twins.isPending ? 'Loading twins…' : (twins.data?.length ? 'Select twin' : 'No twins yet')} /></SelectTrigger>
                <SelectContent>
                  {twins.data?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>
                  )) ?? null}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="soul-desc" className="text-xs">Description <span className="font-normal text-muted-foreground">(honest)</span></Label>
            <Textarea id="soul-desc" value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Who this Soul is for the twin…" className="min-h-14 text-sm" />
          </div>
          <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
            <div className="text-xs font-medium">Persona</div>
            <Input value={tagline} onChange={(e) => setTagline(e.target.value)}
              placeholder="Tagline — e.g. Warm, unhurried, precise" className="h-9 text-sm" aria-label="Persona tagline" />
            <Input value={traits} onChange={(e) => setTraits(e.target.value)}
              placeholder="Traits — comma separated (e.g. warm, precise)" className="h-9 font-mono text-xs" aria-label="Persona traits" />
            <Textarea value={speakingStyle} onChange={(e) => setSpeakingStyle(e.target.value)}
              placeholder="Speaking style — how this Soul talks…" className="min-h-14 text-sm" aria-label="Persona speaking style" />
          </div>

          {/* ── P6.B7 provider wiring (C5 registry, fail-closed) ── */}
          <div className="space-y-1.5 rounded-lg border border-violet-500/25 bg-violet-500/5 p-3">
            <Label className="text-xs">Provider <span className="font-normal text-muted-foreground">(C5 model registry — fail-closed)</span></Label>
            <Select value={providerId} onValueChange={setProviderId} disabled={!providersKnown}>
              <SelectTrigger className="h-9" aria-label="Soul provider (C5 model registry)">
                <SelectValue placeholder={providersPending ? 'Loading providers…' : 'Select provider'} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={!p.available} title={p.reason}>
                    {p.id} — {p.available ? 'available' : 'unavailable'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {providersPending ? (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden /> Resolving provider health from the registry…
              </p>
            ) : providersError ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-red-700 dark:text-red-400">
                <span>Provider status unavailable — provider wiring is fail-closed until the registry resolves.</span>
                <Button size="sm" variant="outline" className="h-7" onClick={onRetryProviders}>Retry</Button>
              </div>
            ) : selectedProvider ? (
              <>
                <p className={`text-[11px] leading-snug ${selectedProvider.available ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`}>
                  {selectedProvider.reason}
                </p>
                {selectedProvider.models.length ? (
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    <span className="font-medium">C5 registry models (reference, not chat-capable yet):</span>{' '}
                    {selectedProvider.models.map((m) => `${m.modelId} (${[
                      m.capabilities.vision ? 'vision' : null,
                      m.capabilities.imageGen ? 'image-gen' : null,
                      m.capabilities.videoGen ? 'video-gen' : null,
                    ].filter(Boolean).join('/') || 'no capability'})${m.enabled ? '' : ' [disabled] '}`).join(', ')}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">Select a provider to see its registry health.</p>
            )}
            <p className="flex items-start gap-1.5 border-t pt-2 text-[10px] leading-snug text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
              Credentials are never entered here — the registry reads env keys server-side only (placeholders in
              apps/web/.env.example); a missing key is honestly reported, never guessed.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Model <span className="font-normal text-muted-foreground">(declared provenance)</span></Label>
              <Select value={model} onValueChange={(v) => { setModel(v); setThinking(v === 'glm-thinking'); }}>
                <SelectTrigger className="h-9" aria-label="Model"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="glm-fast">glm-fast · chat seam</SelectItem>
                  <SelectItem value="glm-thinking">glm-thinking · chat seam</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-snug text-muted-foreground">
                Wave-1: chat routes through the in-sandbox seam; the C5 registry registers no chat-capable
                model yet, so the model is declared provenance the seam records per turn.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="soul-temp" className="text-xs">Temperature <span className="font-normal text-muted-foreground">(optional, 0–2)</span></Label>
              <Input id="soul-temp" value={temperature} onChange={(e) => setTemperature(e.target.value)}
                placeholder="seeded per turn when unset" className="h-9 font-mono text-xs" inputMode="decimal" />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
            <div className="text-xs leading-tight">
              <span className="font-mono">thinking</span>
              <span className="text-muted-foreground"> — deliberative routing profile</span>
            </div>
            <Switch checked={thinking} onCheckedChange={setThinking} aria-label="thinking enabled" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Capability manifest</Label>
            <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              {CAPABILITIES.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    checked={capabilities.includes(c.key)}
                    onCheckedChange={() =>
                      setCapabilities(
                        capabilities.includes(c.key)
                          ? capabilities.filter((x) => x !== c.key)
                          : [...capabilities, c.key],
                      )
                    }
                    className="mt-0.5"
                    aria-label={`capability ${c.label}`}
                  />
                  <span className="text-xs leading-tight">
                    <span className="font-mono">{c.label}</span>
                    <span className="text-muted-foreground"> — {c.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button className="gap-1.5" disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            Create Soul
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
