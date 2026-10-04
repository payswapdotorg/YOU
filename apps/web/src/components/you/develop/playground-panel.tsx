'use client';
// ═══════════════════════════════════════════════════════════════════════════
// API playground panel (P6.B9) — an executable playground against the
// frozen v1 surface. Operation picker grouped by tag (derived from the
// frozen inventory — it declares no tags), request builder (path/query/body
// per operation), EXECUTE calling the REAL API with the session auth, and
// an honest response viewer (status, headers, timing, body).
//
// Honesty laws:
// - read-only operations execute live; mutations require the explicit
//   "I understand this mutates" confirmation PER CALL (the server enforces
//   it too — mutationAcknowledged);
// - the sandbox surface is the server's honest resolution (fail-closed
//   default off; unavailable states are shown, never faked);
// - multipart operations are refused with their reason, not guessed;
// - the response viewer renders exactly what came back (set-cookie dropped
//   server-side), including real errors from the real API.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ChevronDown, ChevronsUpDown, CircleAlert, Loader2, Play, Plus, ShieldAlert, Trash2,
} from 'lucide-react';
import { api, YouApiError } from '@/lib/you/client/api';
import type { PlaygroundExecuteResult } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import {
  PLAYGROUND_OPERATIONS, QUERY_HINTS, findOperation, isMutationMethod, operationExecutable,
  operationKey, tagLabel, tagOf, type PlaygroundMethod,
} from '@/lib/you/develop/playground-ops';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EmptyState, SectionCard } from '@/components/you/shared/primitives';
import { QueryError } from '@/components/you/build/confidence';
import { cn } from '@/lib/utils';

const METHOD_STYLES: Record<string, string> = {
  GET: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  POST: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  PUT: 'border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-400',
  PATCH: 'border-violet-500/30 bg-violet-500/12 text-violet-700 dark:text-violet-400',
  DELETE: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
};

function statusStyle(status: number): string {
  if (status >= 500) return 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400';
  if (status >= 400) return 'border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-400';
  if (status >= 300) return 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400';
  return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400';
}

function prettyBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

interface QueryRow {
  key: string;
  value: string;
}

export function PlaygroundPanel() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pathParams, setPathParams] = useState<Record<string, string>>({});
  const [queryRows, setQueryRows] = useState<QueryRow[]>([]);
  const [bodyText, setBodyText] = useState('');
  const [sandboxRequested, setSandboxRequested] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<PlaygroundExecuteResult | null>(null);
  const [openHeaders, setOpenHeaders] = useState(false);

  const op = useMemo(() => {
    if (!selectedKey) return null;
    const [method, ...rest] = selectedKey.split(' ');
    return findOperation(method as PlaygroundMethod, rest.join(' '));
  }, [selectedKey]);

  const pathParamNames = useMemo(
    () => (op ? [...new Set([...op.path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))] : []),
    [op],
  );

  // Reset the builder whenever the picked operation changes (no stale params
  // ever ride along into an execute) — the render-phase adjustment pattern
  // (the captures-view precedent; no setState-in-effect cascades).
  const [prevOpKey, setPrevOpKey] = useState<string | null>(null);
  if (selectedKey !== prevOpKey) {
    setPrevOpKey(selectedKey);
    setPathParams({});
    setQueryRows(
      op ? (QUERY_HINTS[operationKey(op.method, op.path)] ?? []).map((k) => ({ key: k, value: '' })) : [],
    );
    setBodyText('');
    setResult(null);
    setOpenHeaders(false);
  }

  const status = useQuery({
    queryKey: ['playground-status'],
    queryFn: () => api.develop.playgroundStatus(),
  });

  const exec = useMutation({
    mutationFn: (mutationAcknowledged: boolean) =>
      api.develop.playgroundExecute({
        method: (op?.method ?? 'get') as 'get' | 'post' | 'put' | 'patch' | 'delete',
        path: op?.path ?? '',
        pathParams,
        query: Object.fromEntries(queryRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])),
        body: bodyText.trim() ? bodyText : undefined,
        mutationAcknowledged,
        sandbox: sandboxOn || undefined,
      }),
    onSuccess: (res) => setResult(res),
  });

  const mutation = op ? isMutationMethod(op.method) : false;
  const executable = op ? operationExecutable(op) : null;
  const sandboxAvailable = status.data?.sandbox.available === true;
  // The toggle reflects reality: ON only while the server says the sandbox
  // is actually available — a derived value, so an availability change can
  // never strand a stale ON (fail-closed everywhere else).
  const sandboxOn = sandboxRequested && sandboxAvailable;
  const inventoryMismatch = status.data && status.data.inventoryCount !== PLAYGROUND_OPERATIONS.length;

  const triggerExecute = () => {
    if (mutation) setConfirmOpen(true); // per-call confirmation for every mutation
    else exec.mutate(false);
  };

  const byTag = useMemo(() => {
    const groups = new Map<string, typeof PLAYGROUND_OPERATIONS[number][]>();
    for (const o of PLAYGROUND_OPERATIONS) {
      const tag = tagOf(o.path);
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push(o);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, []);

  return (
    <SectionCard
      title="API playground"
      description={`Execute the frozen v1 surface (${PLAYGROUND_OPERATIONS.length} operations) with your session — read-only runs live; mutations ask first, every time.`}
      icon={Play}
      actions={
        status.data ? (
          <span className="text-[11px] text-muted-foreground" title={status.data.sandbox.reason}>
            {sandboxAvailable ? 'sandbox ready' : 'live mode'}
          </span>
        ) : null
      }
    >
      {/* Sandbox surface — the server's honest resolution, never a client guess */}
      <div className="mb-4 rounded-lg border bg-card/60 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              checked={sandboxOn}
              disabled={!sandboxAvailable}
              onCheckedChange={setSandboxRequested}
              aria-label="Route playground executes through the deterministic fixtures seam (sandbox mode)"
              aria-describedby="sandbox-reason"
            />
            <span className="text-xs font-medium">Sandbox mode</span>
          </div>
          <p id="sandbox-reason" className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
            {status.isPending ? 'resolving sandbox configuration…' : status.data?.sandbox.reason}
          </p>
        </div>
        {inventoryMismatch ? (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            This bundle carries {PLAYGROUND_OPERATIONS.length} operations but the server reports{' '}
            {status.data?.inventoryCount} — reload the page to pick up the current surface.
          </p>
        ) : null}
      </div>

      {/* Operation picker */}
      <div className="space-y-1.5">
        <Label className="text-xs">Operation</Label>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={pickerOpen}
              className="you-focus h-auto w-full justify-between gap-2 py-2.5 font-mono text-xs"
              aria-label="Pick an operation from the frozen inventory"
            >
              {op ? (
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline" className={`font-mono text-[10px] ${METHOD_STYLES[op.method.toUpperCase()]}`}>
                    {op.method.toUpperCase()}
                  </Badge>
                  <span className="truncate font-semibold text-foreground">{op.path}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Pick an operation — search by method, path or summary…</span>
              )}
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(34rem,90vw)] p-0" align="start">
            <Command>
              <CommandInput placeholder={`Search ${PLAYGROUND_OPERATIONS.length} operations…`} />
              <CommandList className="you-scroll max-h-80">
                <CommandEmpty>No matching operation.</CommandEmpty>
                {byTag.map(([tag, groupOps]) => (
                  <CommandGroup key={tag} heading={`${tagLabel(tag)} (${groupOps.length})`}>
                    {groupOps.map((o) => (
                      <CommandItem
                        key={operationKey(o.method, o.path)}
                        value={`${o.method} ${o.path} ${o.summary}`}
                        onSelect={() => {
                          setSelectedKey(operationKey(o.method, o.path));
                          setPickerOpen(false);
                        }}
                        className="gap-2"
                      >
                        <Badge variant="outline" className={`font-mono text-[9px] ${METHOD_STYLES[o.method.toUpperCase()]}`}>
                          {o.method.toUpperCase()}
                        </Badge>
                        <span className="min-w-0 truncate font-mono text-[11px]">{o.path}</span>
                        {selectedKey === operationKey(o.method, o.path) ? (
                          <span className="ml-auto text-[10px] text-muted-foreground">selected</span>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {status.isError ? (
        <div className="mt-4">
          <QueryError error={status.error} compact onRetry={() => void status.refetch()} title="Couldn’t load the playground status" />
        </div>
      ) : null}

      {op ? (
        <>
          <p className="mt-2 text-[11px] text-muted-foreground">{op.summary}</p>

          {/* Request builder */}
          <div className="mt-4 space-y-4">
            {pathParamNames.length ? (
              <div className="space-y-2">
                <Label className="text-xs">Path parameters</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {pathParamNames.map((name) => (
                    <div key={name} className="space-y-1">
                      <span className="font-mono text-[11px] text-muted-foreground">{`{${name}}`}</span>
                      <Input
                        value={pathParams[name] ?? ''}
                        onChange={(e) => setPathParams((prev) => ({ ...prev, [name]: e.target.value }))}
                        placeholder={`value for ${name}`}
                        className="h-9 font-mono text-xs"
                        aria-label={`Path parameter ${name}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label className="text-xs">Query parameters</Label>
              {queryRows.length ? (
                <div className="space-y-2">
                  {queryRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(e) => setQueryRows((prev) => prev.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                        placeholder="key"
                        className="h-9 flex-1 font-mono text-xs"
                        aria-label={`Query parameter ${i + 1} name`}
                      />
                      <span className="text-muted-foreground">=</span>
                      <Input
                        value={row.value}
                        onChange={(e) => setQueryRows((prev) => prev.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                        placeholder="value"
                        className="h-9 flex-1 font-mono text-xs"
                        aria-label={`Query parameter ${i + 1} value`}
                      />
                      <Button
                        variant="ghost" size="icon" className="you-focus size-9 shrink-0 text-muted-foreground hover:text-red-600"
                        onClick={() => setQueryRows((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove query parameter ${i + 1}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">None yet — add a row for each query parameter this operation takes.</p>
              )}
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setQueryRows((prev) => [...prev, { key: '', value: '' }])}>
                <Plus className="size-3.5" aria-hidden /> Add parameter
              </Button>
            </div>

            {op.method !== 'get' && op.method !== 'delete' ? (
              <div className="space-y-1.5">
                <Label htmlFor="playground-body" className="text-xs">Request body (JSON)</Label>
                <Textarea
                  id="playground-body"
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  placeholder={'{\n  "displayName": "Ada"\n}'}
                  className="you-scroll min-h-28 font-mono text-xs"
                  spellCheck={false}
                />
              </div>
            ) : null}
          </div>

          {/* Execute */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              className="gap-1.5"
              disabled={!executable?.executable || exec.isPending}
              onClick={triggerExecute}
            >
              {exec.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
              {mutation ? 'Execute (mutates — will confirm)' : 'Execute'}
            </Button>
            {mutation ? (
              <span className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                <ShieldAlert className="size-3.5" aria-hidden />
                Mutating operation — an explicit confirmation is required for every call.
              </span>
            ) : null}
            {!executable?.executable ? (
              <span className="text-[11px] text-muted-foreground">{executable?.reason}</span>
            ) : null}
          </div>

          {/* Execute-route failures (validation, confirmation gate, sandbox refusal) */}
          {exec.isError ? (
            <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/8 p-3">
              <p className="text-xs font-semibold text-rose-700 dark:text-rose-400">
                {exec.error instanceof YouApiError ? `Playground refused the call — ${describeApiError(exec.error)}` : 'Playground request failed'}
              </p>
              <pre className="you-scroll mt-2 max-h-40 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[10px]">
                {exec.error instanceof YouApiError ? JSON.stringify({ code: exec.error.code, status: exec.error.status, details: exec.error.details }, null, 2) : String(exec.error)}
              </pre>
            </div>
          ) : null}

          {/* Response viewer */}
          {result ? (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={`font-mono text-[11px] ${statusStyle(result.status)}`}>
                  {result.status} {result.statusText || ''}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground">{result.durationMs} ms</span>
                <span className="font-mono text-[10px] text-muted-foreground">{result.resolvedPath}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {result.sandbox ? 'sandbox fixtures' : 'live · real API, session auth'}
                </span>
              </div>

              <div className="rounded-lg border">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs font-medium"
                  onClick={() => setOpenHeaders((v) => !v)}
                  aria-expanded={openHeaders}
                >
                  <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', openHeaders && 'rotate-180')} aria-hidden />
                  Response headers ({result.headers.length})
                </button>
                {openHeaders ? (
                  <div className="you-scroll max-h-48 overflow-y-auto border-t px-3.5 py-2.5">
                    <dl className="space-y-1">
                      {result.headers.map((h) => (
                        <div key={h.name} className="flex gap-2 font-mono text-[10px]">
                          <dt className="shrink-0 text-muted-foreground">{h.name}:</dt>
                          <dd className="min-w-0 break-all">{h.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : null}
              </div>

              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Response body</div>
                <pre className="you-scroll max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {result.body ? prettyBody(result.body) : <span className="text-muted-foreground">(empty body)</span>}
                </pre>
                {result.bodyTruncated ? (
                  <p className="mt-1 text-[10px] text-muted-foreground">Truncated at 256 KiB for the viewer.</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="mt-4">
          <EmptyState
            icon={Play}
            title="Pick an operation to build a request"
            hint="Every operation of the frozen v1 inventory, grouped by surface — read-only calls run live; mutations confirm first."
          />
        </div>
      )}

      {/* Per-call mutation confirmation — no remember-me, no skip */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-amber-600" aria-hidden />
              I understand this mutates
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-xs">
                {op ? `${op.method.toUpperCase()} ${op.path}` : ''}
              </span>{' '}
              will run against your real tenant with your session — the change is real and immediate.
              This confirmation is required for every mutating call.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); setConfirmOpen(false); exec.mutate(true); }}>
              {exec.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Execute anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
