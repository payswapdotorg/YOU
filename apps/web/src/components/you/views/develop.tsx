'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Develop — API & Tools. Keys (secret shown once), live-ish event feed,
// webhooks, usage meters and the real API reference / playground.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity, BookOpen, ChevronDown, KeyRound, Loader2, Plus, RefreshCcw, Trash2, Webhook, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import type { ApiKeySecret, EventRecordView, WebhookEndpointView } from '@/lib/you/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, IdChip, PageHeader, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { CodeBlock, CopyButton } from '@/components/you/artifact/copy-button';
import { UsagePanel } from '@/components/you/develop/usage-panel';
import { DocsPanel } from '@/components/you/develop/docs-panel';
import { QueryError } from '@/components/you/build/confidence';
import { cn } from '@/lib/utils';

const WEBHOOK_EVENT_TYPES = [
  'twin.created', 'capture.completed', 'twin.compiled', 'render.succeeded',
  'job.failed', 'consent.revoked', 'lab.run_completed',
];

const EVENT_TYPE_STYLES = [
  'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  'border-violet-500/30 bg-violet-500/12 text-violet-700 dark:text-violet-400',
  'border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-400',
];
function eventStyle(type: string): string {
  let h = 0;
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return EVENT_TYPE_STYLES[h % EVENT_TYPE_STYLES.length];
}

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

// ─── API keys tab ────────────────────────────────────────────────────────────
function ApiKeysTab() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.develop.apiKeys() });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [secret, setSecret] = useState<ApiKeySecret | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.develop.createKey({ name: name.trim(), scopes }, uid()),
    onSuccess: (result) => {
      setSecret(result);
      setCreateOpen(false);
      setName(''); setScopes(['read']);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => toast.error(`Create failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.develop.revokeKey(id),
    onSuccess: () => {
      toast.success('Key revoked');
      setRevokeId(null);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => toast.error(`Revoke failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });

  const keyToRevoke = keys.data?.find((k) => k.id === revokeId) ?? null;

  return (
    <SectionCard
      title="API keys"
      description="Authenticate programmatic access. Scopes are read and/or write."
      icon={KeyRound}
      actions={
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" aria-hidden /> Create key
        </Button>
      }
    >
      {keys.isPending ? (
        <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : keys.isError ? (
        <QueryError error={keys.error} compact onRetry={() => void keys.refetch()} title="Couldn’t load API keys" />
      ) : !keys.data?.length ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          hint="Create a key to call the API from scripts, SDKs or MCP clients. The secret is shown exactly once."
          action={<Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" aria-hidden /> Create key</Button>}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead aria-label="actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.map((k) => (
                <TableRow key={k.id} className={k.revokedAt ? 'opacity-55' : undefined}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell><span className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">{k.prefix}…</span></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {k.scopes.map((s) => <Badge key={s} variant="outline" className="font-mono text-[9px]">{s}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{k.lastUsedAt ? rel(k.lastUsedAt) : 'never'}</TableCell>
                  <TableCell>
                    <StatusBadge status={k.revokedAt ? 'revoked' : 'live'} />
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{rel(k.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {!k.revokedAt ? (
                      <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400" onClick={() => setRevokeId(k.id)}>
                        <Trash2 className="size-3" aria-hidden /> Revoke
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>The secret is displayed once at creation. Store it immediately.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label htmlFor="key-name" className="text-xs">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CI pipeline" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Scopes</Label>
              <div className="flex gap-2">
                {['read', 'write'].map((scope) => {
                  const on = scopes.includes(scope);
                  return (
                    <button
                      key={scope}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setScopes((prev) => (on ? prev.filter((s) => s !== scope) : [...prev, scope]))}
                      className={cn(
                        'you-focus rounded-md border px-3 py-1.5 font-mono text-xs transition-colors',
                        on ? 'border-primary/50 bg-primary/12 text-foreground' : 'text-muted-foreground hover:border-foreground/25',
                      )}
                    >
                      {scope}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button className="gap-1.5" disabled={!name.trim() || !scopes.length || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* secret shown once */}
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save your secret key</DialogTitle>
            <DialogDescription>
              This is the only time the full secret is shown. It cannot be retrieved again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3">
              <code className="you-scroll min-w-0 flex-1 overflow-x-auto font-mono text-xs">{secret?.secret}</code>
              <CopyButton value={secret?.secret ?? ''} label="Copy secret" />
            </div>
            <p className="text-xs text-amber-800 dark:text-amber-300">
              Treat it like a password — it carries the key’s scopes against your tenant.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-medium">{secret?.key.name}</span>
              <span className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono">{secret?.key.prefix}…</span>
              {secret?.key.scopes.map((s) => <Badge key={s} variant="outline" className="font-mono text-[9px]">{s}</Badge>)}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>I’ve stored it safely</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* revoke confirm */}
      <AlertDialog open={!!revokeId} onOpenChange={(o) => !o && setRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{keyToRevoke?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Requests using this key stop working immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(e) => { e.preventDefault(); if (revokeId) revoke.mutate(revokeId); }}
            >
              {revoke.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Revoke key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

// ─── Events tab ──────────────────────────────────────────────────────────────
function EventsTab() {
  const [typeFilter, setTypeFilter] = useState('all');
  const [auto, setAuto] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const events = useQuery({
    queryKey: ['develop-events', 'feed'],
    queryFn: () => api.develop.events({ limit: 100 }),
    refetchInterval: auto ? 5_000 : false,
  });

  const types = useMemo(
    () => [...new Set((events.data ?? []).map((e: EventRecordView) => e.type))].sort(),
    [events.data],
  );
  const filtered = useMemo(
    () => (events.data ?? []).filter((e: EventRecordView) => typeFilter === 'all' || e.type === typeFilter),
    [events.data, typeFilter],
  );

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <SectionCard
      title="Events"
      description="Tenant event log — every canonical entity change emits an event"
      icon={Activity}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <Switch checked={auto} onCheckedChange={setAuto} aria-label="Auto-refresh every 5 seconds" />
            {auto ? (
              <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <span className="you-pulse inline-block size-1.5 rounded-full bg-current" aria-hidden /> live 5s
              </span>
            ) : 'auto'}
          </label>
          <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => events.refetch()} disabled={events.isRefetching}>
            <RefreshCcw className={events.isRefetching ? 'size-3 animate-spin' : 'size-3'} aria-hidden /> Refresh
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-8 w-full max-w-56" aria-label="Filter by event type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all types ({events.data?.length ?? 0})</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {events.isPending ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : events.isError ? (
        <QueryError error={events.error} compact onRetry={() => void events.refetch()} title="Couldn’t load events" />
      ) : !filtered.length ? (
        <EmptyState
          icon={Activity}
          title={typeFilter === 'all' ? 'No events yet' : `No “${typeFilter}” events`}
          hint="Events are emitted as you create twins, run captures, compile versions, render artifacts and run lab jobs."
        />
      ) : (
        <div className="you-scroll max-h-96 space-y-1 overflow-y-auto rounded-lg border p-2">
          {filtered.map((e: EventRecordView) => {
            const open = expanded.has(e.id);
            return (
              <div key={e.id} className="rounded-md border bg-card/60">
                {/* Row head split into wrapper + dedicated toggle: the IdChip is
                    itself a <button> (copy-to-clipboard), so it must be a SIBLING
                    of the toggle — a button inside a button is invalid HTML and
                    made one click both copy the id and expand the row. */}
                <div className="flex w-full flex-wrap items-center gap-2 px-2.5 py-2">
                  <button
                    type="button"
                    className="you-focus flex flex-wrap items-center gap-2 text-left"
                    onClick={() => toggle(e.id)}
                    aria-expanded={open}
                  >
                    <ChevronDown className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
                    <Badge variant="outline" className={cn('font-mono text-[10px]', eventStyle(e.type))}>{e.type}</Badge>
                    <span className="font-mono text-[11px] text-muted-foreground">{e.entityType}</span>
                  </button>
                  {e.entityId ? <IdChip id={e.entityId} /> : null}
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{rel(e.createdAt)}</span>
                </div>
                {open ? (
                  <pre className="you-scroll mx-2.5 mb-2.5 max-h-56 overflow-auto rounded-md border bg-muted/30 p-2.5 font-mono text-[10px] leading-relaxed">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Webhooks tab ────────────────────────────────────────────────────────────
function WebhooksTab() {
  const qc = useQueryClient();
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.develop.webhooks() });
  const [createOpen, setCreateOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.develop.createWebhook({ url: url.trim(), events }, uid()),
    onSuccess: () => {
      toast.success('Webhook endpoint created');
      setCreateOpen(false); setUrl(''); setEvents([]);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (err) => toast.error(`Create failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.develop.deleteWebhook(id),
    onSuccess: () => {
      toast.success('Webhook deleted');
      setDeleteId(null);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (err) => toast.error(`Delete failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });

  const toDelete = webhooks.data?.find((w: WebhookEndpointView) => w.id === deleteId) ?? null;

  return (
    <SectionCard
      title="Webhook endpoints"
      description="HTTP callbacks for selected event types. Payloads reference canonical entities."
      icon={Webhook}
      actions={
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" aria-hidden /> Add endpoint
        </Button>
      }
    >
      {webhooks.isPending ? (
        <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : webhooks.isError ? (
        <QueryError error={webhooks.error} compact onRetry={() => void webhooks.refetch()} title="Couldn’t load webhooks" />
      ) : !webhooks.data?.length ? (
        <EmptyState
          icon={Webhook}
          title="No webhook endpoints"
          hint="Register an HTTPS endpoint to receive events like twin.compiled, render.succeeded or job.failed."
          action={<Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" aria-hidden /> Add endpoint</Button>}
        />
      ) : (
        <div className="space-y-2.5">
          {webhooks.data.map((w: WebhookEndpointView) => (
            <div key={w.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
              <div className="min-w-0 flex-1">
                <div className="you-scroll overflow-x-auto whitespace-nowrap font-mono text-xs" title={w.url}>{w.url}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {w.events.map((ev) => (
                    <Badge key={ev} variant="outline" className={cn('font-mono text-[9px]', eventStyle(ev))}>{ev}</Badge>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={w.active} disabled aria-readonly title="Read-only — API v1 has no endpoint update; delete and re-create to change" />
                <span className="text-[10px] text-muted-foreground">{w.active ? 'active' : 'inactive'}</span>
                <Button
                  size="sm" variant="ghost" className="h-7 gap-1 text-xs text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400"
                  onClick={() => setDeleteId(w.id)}
                >
                  <Trash2 className="size-3" aria-hidden /> Delete
                </Button>
              </div>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Delivery attempts surface in the Events feed; per-endpoint delivery history is not part of API v1.
          </p>
        </div>
      )}

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add webhook endpoint</DialogTitle>
            <DialogDescription>Choose the event types this endpoint should receive.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label htmlFor="wh-url" className="text-xs">Endpoint URL</Label>
              <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-service.local/you/hooks" className="h-9 font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Events</Label>
              <div className="flex flex-wrap gap-1.5">
                {WEBHOOK_EVENT_TYPES.map((t) => {
                  const on = events.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setEvents((prev) => (on ? prev.filter((e) => e !== t) : [...prev, t]))}
                      className={cn(
                        'you-focus rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors',
                        on ? 'border-primary/50 bg-primary/12 text-foreground' : 'text-muted-foreground hover:border-foreground/25',
                      )}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button className="gap-1.5" disabled={!/^https?:\/\/.+/.test(url.trim()) || !events.length || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Webhook className="size-4" aria-hidden />}
              Add endpoint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this endpoint?</AlertDialogTitle>
            <AlertDialogDescription className="break-all font-mono text-xs">{toDelete?.url}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(e) => { e.preventDefault(); if (deleteId) remove.mutate(deleteId); }}
            >
              {remove.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────
export function DevelopView() {
  const [tab, setTab] = useState('keys');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Develop"
        title="API & Tools"
        description="Keys, events, webhooks and usage for the developer platform — HTTP, SDK and MCP all call the same application services behind this Studio."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="you-scroll h-auto w-full max-w-full overflow-x-auto">
          <TabsTrigger value="keys" className="gap-1.5"><KeyRound className="size-3.5" aria-hidden /> API Keys</TabsTrigger>
          <TabsTrigger value="events" className="gap-1.5"><Activity className="size-3.5" aria-hidden /> Events</TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-1.5"><Webhook className="size-3.5" aria-hidden /> Webhooks</TabsTrigger>
          <TabsTrigger value="usage" className="gap-1.5"><Zap className="size-3.5" aria-hidden /> Usage</TabsTrigger>
          <TabsTrigger value="docs" className="gap-1.5"><BookOpen className="size-3.5" aria-hidden /> Docs</TabsTrigger>
        </TabsList>
        <TabsContent value="keys" className="mt-4"><ApiKeysTab /></TabsContent>
        <TabsContent value="events" className="mt-4"><EventsTab /></TabsContent>
        <TabsContent value="webhooks" className="mt-4"><WebhooksTab /></TabsContent>
        <TabsContent value="usage" className="mt-4"><UsagePanel /></TabsContent>
        <TabsContent value="docs" className="mt-4"><DocsPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
export default DevelopView;
