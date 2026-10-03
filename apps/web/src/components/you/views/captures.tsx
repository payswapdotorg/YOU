'use client';
// Captures — every capture session across twins, with evidence grids, quality
// chips and links back into the owning twin. Params: { sessionId } opens the
// detail dialog for that session.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, IdChip, PageHeader, StatusBadge } from '@/components/you/shared/primitives';
import { useYouStore } from '@/hooks/you/use-you-store';
import { api } from '@/lib/you/client/api';
import type { CaptureSessionView } from '@/lib/you/contracts';
import { Camera, RotateCw, UserRound } from 'lucide-react';
import { ConsentGrantDialog } from '../build/consent-dialog';
import { CaptureSessionPanel } from '../build/capture-session-panel';
import { QueryError, RowSkeletons } from '../build/confidence';
import { timeAgo } from '../build/format';

const TERMINAL: CaptureSessionView['status'][] = ['complete', 'failed'];

export function CapturesView() {
  const params = useYouStore((s) => s.params);
  const navigate = useYouStore((s) => s.navigate);
  const [openId, setOpenId] = useState<string | null>(null);
  const [consentSubject, setConsentSubject] = useState<{ subjectId: string; hint: string; twinName: string } | null>(null);

  const capturesQ = useQuery({
    queryKey: ['captures'],
    queryFn: api.captures.list,
    refetchInterval: (q) => {
      const data = q.state.data as CaptureSessionView[] | undefined;
      return data?.some((c) => !TERMINAL.includes(c.status)) ? 3_000 : false;
    },
  });
  const twinsQ = useQuery({ queryKey: ['twins'], queryFn: api.twins.list });

  const twinById = useMemo(() => {
    const m = new Map<string, { displayName: string; subjectId: string }>();
    for (const t of twinsQ.data ?? []) m.set(t.id, { displayName: t.displayName, subjectId: t.subjectId });
    return m;
  }, [twinsQ.data]);

  const sessions = useMemo(
    () => [...(capturesQ.data ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [capturesQ.data],
  );

  // Consume { sessionId } param → open that session's dialog (render-phase
  // adjustment pattern; consumed in the store after commit).
  const [prevParams, setPrevParams] = useState<unknown>(null);
  if (params !== prevParams) {
    setPrevParams(params);
    if (params && typeof params.sessionId === 'string') setOpenId(params.sessionId);
  }
  useEffect(() => {
    if (params) useYouStore.setState({ params: null });
  }, [params]);

  const openSession = openId ? sessions.find((s) => s.id === openId) ?? null : null;
  const openTwin = openSession ? twinById.get(openSession.twinId) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Captures"
        description="Authorized capture sessions and their immutable evidence — quality analysis is per-asset and never guessed."
        actions={
          <Button variant="outline" size="sm" onClick={() => { void capturesQ.refetch(); void twinsQ.refetch(); }} className="gap-1.5" disabled={capturesQ.isFetching}>
            <RotateCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        }
      />

      {capturesQ.isPending ? (
        <RowSkeletons rows={5} />
      ) : capturesQ.isError ? (
        <QueryError error={capturesQ.error} title="Could not load capture sessions" onRetry={() => void capturesQ.refetch()} />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={Camera}
          title="No capture sessions yet"
          hint="Capture sessions are started from a twin — the checklist guides region coverage and uploads are consent-gated."
          action={
            <Button size="sm" onClick={() => navigate('twins')} className="gap-1.5">
              <UserRound className="size-3.5" aria-hidden /> Go to Twins
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="overflow-x-auto you-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Twin</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Assets</TableHead>
                  <TableHead className="text-right">Checklist</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="w-16"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const twin = twinById.get(session.twinId);
                  const provided = session.checklist?.filter((i) => i.status === 'provided').length ?? 0;
                  return (
                    <TableRow
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open capture session ${session.id}`}
                      className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => setOpenId(session.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(session.id); }
                      }}
                    >
                      <TableCell><IdChip id={session.id} label="" /></TableCell>
                      <TableCell className="max-w-40">
                        {twinsQ.isPending ? (
                          <Skeleton className="h-4 w-20" />
                        ) : twin ? (
                          <button
                            type="button"
                            className="truncate text-[13px] font-medium hover:underline"
                            onClick={(e) => { e.stopPropagation(); navigate('twins', { twinId: session.twinId }); }}
                          >
                            {twin.displayName}
                          </button>
                        ) : (
                          <IdChip id={session.twinId} label="twin" />
                        )}
                      </TableCell>
                      <TableCell><StatusBadge status={session.status} /></TableCell>
                      <TableCell className="you-num text-right text-[13px]">{session.assets?.length ?? 0}</TableCell>
                      <TableCell className="you-num text-right text-[13px]">{provided}/{session.checklist?.length ?? 0}</TableCell>
                      <TableCell className="you-num whitespace-nowrap text-[13px] text-muted-foreground">{timeAgo(session.createdAt)}</TableCell>
                      <TableCell className="you-num whitespace-nowrap text-[13px] text-muted-foreground">
                        {session.completedAt ? timeAgo(session.completedAt) : '—'}
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" className="h-7 text-[11.5px]" onClick={(e) => { e.stopPropagation(); setOpenId(session.id); }}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Session detail dialog */}
      <Dialog open={!!openSession} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto you-scroll">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              Capture session <IdChip id={openSession?.id ?? ''} label="" />
            </DialogTitle>
            <DialogDescription>
              {openSession
                ? `${openTwin ? `Twin: ${openTwin.displayName} · ` : ''}${openSession.assets?.length ?? 0} evidence assets · checklist ${openSession.checklist?.filter((i) => i.status === 'provided').length ?? 0}/${openSession.checklist?.length ?? 0}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {openSession ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11.5px]"
                  onClick={() => { setOpenId(null); navigate('twins', { twinId: openSession.twinId }); }}
                >
                  <UserRound className="size-3.5" aria-hidden /> Open twin
                </Button>
                <span className="you-num">created {timeAgo(openSession.createdAt)}</span>
              </div>
              <CaptureSessionPanel
                twinId={openSession.twinId}
                session={openSession}
                onConsentRequired={(hint) => {
                  const twin = twinById.get(openSession.twinId);
                  if (twin) setConsentSubject({ subjectId: twin.subjectId, hint, twinName: twin.displayName });
                }}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Consent gate reachable from an upload blocked in the dialog */}
      <ConsentGrantDialog
        open={!!consentSubject}
        onOpenChange={(o) => !o && setConsentSubject(null)}
        subjectId={consentSubject?.subjectId ?? ''}
        purpose={`Create and reconstruct digital twin “${consentSubject?.twinName ?? ''}”`}
        missingScopeHint={consentSubject?.hint}
      />
    </div>
  );
}

export default CapturesView;
