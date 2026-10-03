'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Settings — read-only profile & environment facts for the local deployment,
// plus the Twin deletion policy (danger zone, informational).
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { AlertTriangle, Building2, Database, HardDrive, KeySquare, Moon, Palette, RotateCw, ShieldCheck, UserRound } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { KeyValue, PageHeader, SectionCard } from '@/components/you/shared/primitives';
import { SettingsOps } from '@/components/you/views/settings-ops';
import { useYouStore } from '@/hooks/you/use-you-store';
import { api } from '@/lib/you/client/api';

export function SettingsView() {
  const session = useYouStore((s) => s.session);
  const sessionError = useYouStore((s) => s.sessionError);
  const setSession = useYouStore((s) => s.setSession);
  const setSessionError = useYouStore((s) => s.setSessionError);
  const [retrying, setRetrying] = useState(false);

  // P6.B2 — honest bootstrap-failure retry: re-runs the same get→create
  // cascade the shell uses at startup. A success clears the error via
  // setSession; a failure re-renders this surface with the new reason.
  const retryBootstrap = async () => {
    setRetrying(true);
    try {
      const s = await api.session.get().catch(() => api.session.create());
      setSession(s);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Session bootstrap failed');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Local-environment settings. This deployment runs a single signed-in development identity."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="Profile" description="Session identity (read-only)" icon={UserRound}>
          {session ? (
            <KeyValue
              items={[
                { label: 'Name', value: session.user.name },
                { label: 'Email', value: <span className="font-mono text-xs">{session.user.email}</span> },
                { label: 'Role', value: <span className="font-mono text-xs">{session.user.role}</span> },
                { label: 'User id', value: <span className="font-mono text-xs text-muted-foreground">{session.user.id}</span> },
              ]}
            />
          ) : sessionError ? (
            <div className="space-y-2.5">
              <p className="text-sm font-medium text-foreground">Couldn’t load the session</p>
              <p className="text-xs text-muted-foreground">
                Both the session lookup and the local bootstrap failed:{' '}
                <span className="font-mono">{sessionError}</span>
              </p>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => void retryBootstrap()}
                disabled={retrying}
              >
                <RotateCw className={retrying ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
                Retry
              </Button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <p className="text-xs text-muted-foreground">Loading session…</p>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Tenant" description="Workspace (read-only)" icon={Building2}>
          {session ? (
            <KeyValue
              items={[
                { label: 'Tenant', value: session.tenant.name },
                { label: 'Slug', value: <span className="font-mono text-xs">{session.tenant.slug}</span> },
                { label: 'Tenant id', value: <span className="font-mono text-xs text-muted-foreground">{session.tenant.id}</span> },
              ]}
            />
          ) : (
            <div className="space-y-2.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Environment" description="Architecture facts for this deployment" icon={HardDrive}>
        <KeyValue
          items={[
            { label: 'Environment', value: <span className="font-mono text-xs">local</span> },
            { label: 'API', value: <span className="font-mono text-xs">v1 — /api/v1</span> },
            { label: 'Database', value: <span className="flex items-center gap-1.5"><Database className="size-3.5 text-muted-foreground" aria-hidden /> SQLite via Prisma (local file)</span> },
            { label: 'Object storage', value: 'Local object store — signed, expiring URLs' },
            { label: 'Media policy', value: 'Large media stays in object storage; relational storage holds metadata and hashes' },
            { label: 'Session', value: 'Cookie session, same-origin' },
          ]}
        />
      </SectionCard>

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="Appearance" description="Theme" icon={Palette}>
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Moon className="mt-0.5 size-4 shrink-0" aria-hidden />
            Dark and light themes follow your choice in the top bar; the toggle respects your system preference until
            you override it. Both are first-class — no content differs between them.
          </p>
        </SectionCard>

        <SectionCard title="Keys & access" description="Where credentials live" icon={KeySquare}>
          <p className="text-sm text-muted-foreground">
            API keys are managed in <span className="font-medium text-foreground">Develop → API Keys</span>. Secrets are
            shown exactly once at creation; revocation is immediate and server-enforced.
          </p>
        </SectionCard>
      </div>

      {/* P6.B8 — operator maintenance surface: dead-letter queue (list /
          replay / purge) + provider breaker states, over the existing
          operator-gated maintenance/metrics routes. Non-operator sessions get
          an honest gate notice from the backend's 403. */}
      <SettingsOps />

      <section className="rounded-xl border border-red-500/30 bg-red-500/5">
        <header className="flex items-center gap-2.5 border-b border-red-500/20 px-5 py-3.5">
          <AlertTriangle className="size-4 text-red-600" aria-hidden />
          <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">Danger zone</h2>
        </header>
        <div className="space-y-2.5 p-5 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Twin deletion policy</p>
          <p>
            Published TwinVersions are immutable — deletion never rewrites history. Deleting a Twin cascades to its
            draft working set (captures in progress, draft versions), while audit history, consent records and
            provenance references persist.
          </p>
          <p>
            Deletion is performed from the Twins view on a per-twin basis; there is no bulk or tenant-level destructive
            action in this environment.
          </p>
        </div>
      </section>
    </div>
  );
}
export default SettingsView;
