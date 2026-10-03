'use client';
// Create Agent Soul dialog (P6.C6 production runtime) — a Soul is
// personality/behavior configuration BOUND TO A TWIN, with an honest
// capability manifest, behavior params and a deterministic seed. Created as
// DRAFT; activate from the list.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ghost, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
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

export function SoulCreateDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [twinId, setTwinId] = useState('');
  const [tagline, setTagline] = useState('');
  const [traits, setTraits] = useState('');
  const [speakingStyle, setSpeakingStyle] = useState('');
  const [model, setModel] = useState('glm-fast');
  const [thinking, setThinking] = useState(false);
  const [temperature, setTemperature] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>(['conversation']);
  const qc = useQueryClient();

  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list() });

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
      setModel('glm-fast'); setThinking(false); setTemperature(''); setCapabilities(['conversation']);
    },
    onError: (err) => {
      const msg = err instanceof YouApiError ? err.message : 'request failed';
      toast.error(`Create soul failed — ${msg}`);
    },
  });

  const canSubmit = name.trim().length > 0 && !!twinId && !create.isPending;

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
                <SelectTrigger className="h-9"><SelectValue placeholder={twins.data?.length ? 'Select twin' : 'No twins yet'} /></SelectTrigger>
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Model <span className="font-normal text-muted-foreground">(declared provenance)</span></Label>
              <Select value={model} onValueChange={(v) => { setModel(v); setThinking(v === 'glm-thinking'); }}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="glm-fast">glm-fast · zai seam</SelectItem>
                  <SelectItem value="glm-thinking">glm-thinking · zai seam</SelectItem>
                </SelectContent>
              </Select>
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
