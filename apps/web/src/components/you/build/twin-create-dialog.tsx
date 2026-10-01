'use client';
// Twin create dialog — step 1 of the canonical flow. On success the parent
// immediately opens the consent gate (capture cannot proceed without consent,
// docs/SECURITY_PRIVACY.md control #3).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, uid } from '@/lib/you/client/api';
import type { TwinView } from '@/lib/you/contracts';
import { Loader2, UserRound } from 'lucide-react';
import { toast } from 'sonner';

export function TwinCreateDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** called with the created twin; the parent then runs the consent gate */
  onCreated: (twin: TwinView) => void;
}) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [personName, setPersonName] = useState('');

  // Reset to empty fields each time the dialog opens (render-phase adjust).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setDisplayName(''); setPersonName(''); }
  }

  const create = useMutation({
    mutationFn: () => api.twins.create(
      { displayName: displayName.trim(), personName: personName.trim() || undefined },
      uid(), // idempotency: a retried submit must not create duplicate twins
    ),
    onSuccess: (twin) => {
      toast.success('Twin created', { description: `${twin.displayName} is a draft until evidence is captured.` });
      void qc.invalidateQueries({ queryKey: ['twins'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onCreated(twin);
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error('Could not create twin', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Create twin
          </DialogTitle>
          <DialogDescription>
            A twin is the persistent human object. You will be asked to grant scoped consent next —
            capture cannot proceed without it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="twin-display-name">Display name</Label>
            <Input
              id="twin-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Studio actor A"
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="twin-person-name">Person name <span className="font-normal text-muted-foreground">(the human being captured — optional)</span></Label>
            <Input
              id="twin-person-name"
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
              placeholder="e.g. Jordan Reyes"
              maxLength={80}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Ownership/verification confidence is tracked separately from reconstruction fidelity —
            naming the person does not by itself authorize anything.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || !displayName.trim()} className="gap-1.5">
              {create.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              Create twin
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
