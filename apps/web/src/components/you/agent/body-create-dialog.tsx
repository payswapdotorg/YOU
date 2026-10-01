'use client';
// Create Agent Body dialog — Bodies are reusable role/capability/tool contracts
// (ADR-0002). A Body never references a model vendor; Souls bind at runtime.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

function parseList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function BodyCreateDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [tools, setTools] = useState('');
  const [permissions, setPermissions] = useState('');
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.agents.createBody(
        {
          name: name.trim(),
          role: role.trim(),
          capabilities: parseList(capabilities),
          tools: parseList(tools),
          permissions: parseList(permissions),
        },
        uid(),
      ),
    onSuccess: (body) => {
      toast.success(`Body “${body.name}” created`);
      qc.invalidateQueries({ queryKey: ['agent-bodies'] });
      setOpen(false);
      setName(''); setRole(''); setCapabilities(''); setTools(''); setPermissions('');
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" aria-hidden /> New Agent Body
          </DialogTitle>
          <DialogDescription>
            A Body is reusable capability/role/tool infrastructure. Model bindings (Souls) attach separately and can be
            swapped without changing this contract.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="body-name" className="text-xs">Name</Label>
              <Input id="body-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Recon Reviewer" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="body-role" className="text-xs">Role</Label>
              <Input id="body-role" value={role} onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. evaluator" className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="body-caps" className="text-xs">Capabilities <span className="font-normal text-muted-foreground">(comma separated)</span></Label>
            <Input id="body-caps" value={capabilities} onChange={(e) => setCapabilities(e.target.value)}
              placeholder="face.profile, hair, hands" className="h-9 font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="body-tools" className="text-xs">Tools <span className="font-normal text-muted-foreground">(comma separated)</span></Label>
            <Input id="body-tools" value={tools} onChange={(e) => setTools(e.target.value)}
              placeholder="evidence.read, quality.score" className="h-9 font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="body-perms" className="text-xs">Permissions <span className="font-normal text-muted-foreground">(comma separated)</span></Label>
            <Input id="body-perms" value={permissions} onChange={(e) => setPermissions(e.target.value)}
              placeholder="evidence:read, renders:create" className="h-9 font-mono text-xs" />
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
