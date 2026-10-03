'use client';
// Create Agent Body dialog (P6.C6 production runtime) — a Body is visual/
// physical avatar assets bound to a TwinVersion plus the ADR-0002 role/tool
// contract, with an honest capability manifest. Created as DRAFT; activate
// from the list (lifecycle is explicit).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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

const TOOLS = [
  { key: 'twins.list', label: 'twins.list', capability: 'tool-use' },
  { key: 'knowledge_search', label: 'knowledge_search', capability: 'tool-use' },
  { key: 'evidence.request', label: 'evidence.request', capability: 'evidence-request' },
] as const;

export function BodyCreateDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [twinId, setTwinId] = useState('none');
  const [capabilities, setCapabilities] = useState<string[]>(['conversation']);
  const [tools, setTools] = useState<string[]>([]);
  const qc = useQueryClient();

  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list() });

  const toggle = (list: string[], key: string, set: (v: string[]) => void) => {
    set(list.includes(key) ? list.filter((c) => c !== key) : [...list, key]);
  };

  const create = useMutation({
    mutationFn: () =>
      api.agentRuntime.createBody(
        {
          name: name.trim(),
          role: role.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(twinId !== 'none' ? { twinId } : {}),
          capabilities,
          tools,
        },
        uid(),
      ),
    onSuccess: (body) => {
      toast.success(`Body “${body.name}” created (v1, draft) — activate it to start sessions`);
      qc.invalidateQueries({ queryKey: ['agent-runtime-bodies'] });
      setOpen(false);
      setName(''); setRole(''); setDescription(''); setTwinId('none');
      setCapabilities(['conversation']); setTools([]);
    },
    onError: (err) => {
      const msg = err instanceof YouApiError ? err.message : 'request failed';
      toast.error(`Create body failed — ${msg}`);
    },
  });

  const canSubmit = name.trim().length > 0 && role.trim().length > 0 && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Plus className="size-3.5" aria-hidden /> New Body
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" aria-hidden /> New Agent Body
          </DialogTitle>
          <DialogDescription>
            A Body binds visual/physical avatar assets to a TwinVersion and carries an honest capability
            manifest — what it CAN and CANNOT do, enforced server-side. Created as <span className="font-mono">draft</span>;
            activate it from the list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="body-name" className="text-xs">Name</Label>
              <Input id="body-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Twin Concierge" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="body-role" className="text-xs">Role</Label>
              <Input id="body-role" value={role} onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. host" className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="body-desc" className="text-xs">Description <span className="font-normal text-muted-foreground">(honest — no overclaiming)</span></Label>
            <Textarea id="body-desc" value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="What this Body actually does in this runtime…" className="min-h-16 text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Twin visual binding <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Select value={twinId} onValueChange={setTwinId}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None — abstract Body</SelectItem>
                {twins.data?.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.displayName}
                    {t.currentVersion > 0 ? ` · v${t.currentVersion}` : ' · no version'}
                  </SelectItem>
                )) ?? null}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Binds the twin’s latest TwinVersion — the visual/physical avatar assets. A twin with no version
              cannot be bound (compile or reconstruct it first).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Capability manifest</Label>
            <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              {CAPABILITIES.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    checked={capabilities.includes(c.key)}
                    onCheckedChange={() => toggle(capabilities, c.key, setCapabilities)}
                    className="mt-0.5"
                    aria-label={`capability ${c.label}`}
                  />
                  <span className="text-xs leading-tight">
                    <span className="font-mono">{c.label}</span>
                    <span className="text-muted-foreground"> — {c.hint}</span>
                  </span>
                </label>
              ))}
              <p className="border-t pt-2 text-[11px] text-muted-foreground">
                Undeclared capabilities are disclosed as CANNOT — the manifest never overclaims.
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Tools <span className="font-normal text-muted-foreground">(each requires its capability)</span></Label>
            <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              {TOOLS.map((t) => (
                <label key={t.key} className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={tools.includes(t.key)}
                    onCheckedChange={() => {
                      const nextTools = tools.includes(t.key) ? tools.filter((x) => x !== t.key) : [...tools, t.key];
                      setTools(nextTools);
                      if (!nextTools.includes(t.key)) return;
                      if (!capabilities.includes(t.capability)) {
                        setCapabilities([...capabilities, t.capability]);
                      }
                    }}
                    className="mt-0"
                    aria-label={`tool ${t.label}`}
                  />
                  <span className="text-xs font-mono">{t.label}</span>
                  <span className="text-[10px] text-muted-foreground">needs {t.capability}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button className="gap-1.5" disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            Create Body
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
