'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Provenance chain — vertical chain-of-custody view over the artifact
// manifest: inputs → pipeline → evidence → consent → outputs → timestamps.
// Renders only what the manifest actually carries.
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import {
  Camera, Clock, Drama, FileBox, FileInput, GitBranch, Hash, ShieldCheck, UserRound,
} from 'lucide-react';
import type { SolutionArtifactManifest } from '@/lib/you/contracts';
import { Badge } from '@/components/ui/badge';
import { IdChip } from '@/components/you/shared/primitives';
import { cn } from '@/lib/utils';

interface ChainNode {
  icon: typeof FileInput;
  title: string;
  content: React.ReactNode;
}

export function ProvenanceChain({ manifest, createdAt }: { manifest: SolutionArtifactManifest; createdAt: string }) {
  const [showAllHashes, setShowAllHashes] = useState(false);
  const prov = (manifest.provenance ?? {}) as Record<string, unknown>;
  const components = (
    (prov.components as { adapterId?: string; version?: string }[] | undefined)
    ?? ((prov.pipeline as { components?: { adapterId?: string; version?: string }[] } | undefined)?.components)
  );
  const compiledAt = typeof prov.compiledAt === 'string' ? prov.compiledAt : null;
  const evidenceHashes = manifest.evidence.map((e) => e.contentHash);
  const artifactHashNote = manifest.artifacts.length
    ? `${manifest.artifacts.length} artifact${manifest.artifacts.length === 1 ? '' : 's'} with content hashes`
    : null;

  const nodes: ChainNode[] = [];

  if (manifest.inputs.length) {
    nodes.push({
      icon: FileInput,
      title: 'Inputs',
      content: (
        <div className="flex flex-wrap gap-1.5">
          {manifest.inputs.map((i) => (
            <Badge key={`${i.label}-${i.ref}`} variant="outline" className="max-w-64 gap-1 truncate text-[10px]">
              <span className="truncate">{i.label}</span>
              <span className="font-mono text-muted-foreground">{i.kind}</span>
            </Badge>
          ))}
        </div>
      ),
    });
  }

  if (manifest.pipeline || Array.isArray(components)) {
    nodes.push({
      icon: GitBranch,
      title: 'Pipeline',
      content: (
        <div className="space-y-1.5">
          {manifest.pipeline ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{manifest.pipeline.name}</span>
              <IdChip id={manifest.pipeline.id} label="pipeline" />
            </div>
          ) : null}
          {Array.isArray(components) && components.length ? (
            <div className="flex flex-wrap gap-1">
              {components.map((c, i) => (
                <Badge key={i} variant="outline" className="font-mono text-[10px]">
                  {c?.adapterId ?? 'adapter'}{c?.version ? `@${c.version}` : ''}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      ),
    });
  }

  if (manifest.evidence.length) {
    nodes.push({
      icon: Camera,
      title: `Evidence — ${manifest.evidence.length} immutable assets`,
      content: (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {(showAllHashes ? manifest.evidence : manifest.evidence.slice(0, 3)).map((e) => (
              <IdChip key={e.assetId} id={e.contentHash} label="sha256" />
            ))}
            {manifest.evidence.length > 3 ? (
              <button
                type="button"
                onClick={() => setShowAllHashes((v) => !v)}
                className="text-[10px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {showAllHashes ? 'show fewer' : `+${manifest.evidence.length - 3} more`}
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">Raw captures are immutable — derived representations reference them by content hash.</p>
        </div>
      ),
    });
  }

  // P6.B6: consent is null on artifacts where no consent applies (e.g.
  // text-origin performances record no subject evidence) — honest node text.
  nodes.push(
    manifest.consent
      ? {
          icon: ShieldCheck,
          title: 'Consent',
          content: (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">subject</span>
                <span className="font-mono text-[11px]">{manifest.consent.subjectId}</span>
                {manifest.consent.scopes.map((s) => (
                  <Badge key={s} variant="outline" className="font-mono text-[9px]">{s}</Badge>
                ))}
              </div>
              {manifest.consent.grantIds.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {manifest.consent.grantIds.map((g) => <IdChip key={g} id={g} label="grant" />)}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">No grant ids recorded on this manifest.</p>
              )}
            </div>
          ),
        }
      : {
          icon: ShieldCheck,
          title: 'Consent',
          content: (
            <p className="text-[11px] text-muted-foreground">
              No consent grant applies — {manifest.sections?.consent?.reason
                ?? 'this artifact records no subject evidence (no biometrics involved).'}
            </p>
          ),
        },
  );

  if (manifest.twinVersion) {
    nodes.push({
      icon: UserRound,
      title: 'Twin version',
      content: (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="you-num font-mono text-[10px]">v{manifest.twinVersion.version}</Badge>
          <IdChip id={manifest.twinVersion.id} label="version" />
        </div>
      ),
    });
  }

  if (manifest.performance) {
    nodes.push({
      icon: Drama,
      title: 'Performance',
      content: (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{manifest.performance.name}</span>
          <IdChip id={manifest.performance.id} label="perf" />
        </div>
      ),
    });
  }

  if (manifest.organization) {
    nodes.push({
      icon: GitBranch,
      title: 'Organization',
      content: (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{manifest.organization.label}</span>
          <IdChip id={manifest.organization.id} label="org" />
        </div>
      ),
    });
  }

  if (compiledAt) {
    nodes.push({
      icon: Clock,
      title: 'Compiled at',
      content: <span className="you-num font-mono text-xs">{new Date(compiledAt).toLocaleString()}</span>,
    });
  }

  nodes.push({
    icon: FileBox,
    title: 'Artifact created',
    content: <span className="you-num font-mono text-xs">{new Date(createdAt).toLocaleString()}</span>,
  });

  if (artifactHashNote) {
    nodes.push({
      icon: Hash,
      title: 'Output content hashes',
      content: (
        <div className="flex flex-wrap gap-1.5">
          {manifest.artifacts.map((a) => (
            <span key={a.artifactId} className="inline-flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">{a.label}</Badge>
              <span className="font-mono text-[10px] text-muted-foreground">{a.kind}</span>
            </span>
          ))}
          {evidenceHashes.length ? (
            <p className="basis-full text-[11px] text-muted-foreground">
              Evidence hashes are listed under the Evidence node; outputs carry their own sha-256 hashes in the manifest.
            </p>
          ) : null}
        </div>
      ),
    });
  }

  return (
    <div className="relative space-y-0 pl-7">
      <div className="absolute bottom-3 left-[10px] top-3 w-px bg-border" aria-hidden />
      {nodes.map((node, i) => (
        <div key={`${node.title}-${i}`} className="relative pb-5 last:pb-0">
          <span
            className={cn(
              'absolute -left-7 top-0 flex size-[21px] items-center justify-center rounded-full border bg-card',
            )}
          >
            <node.icon className="size-3 text-muted-foreground" aria-hidden />
          </span>
          <div className="text-xs font-semibold">{node.title}</div>
          <div className="mt-1.5">{node.content}</div>
        </div>
      ))}
    </div>
  );
}
