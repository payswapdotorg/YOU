'use client';
// Provenance mini-view for a TwinVersion — consent references, evidence
// content hashes and the pipeline components that produced this version
// (docs/ARCHITECTURE.md §3: derived representations reference evidence by
// content hash; history is immutable).
import { IdChip, KeyValue } from '@/components/you/shared/primitives';
import type { TwinVersionView } from '@/lib/you/contracts';
import { FileClock } from 'lucide-react';
import { timeAbs } from './format';

export function ProvenancePanel({ version }: { version: TwinVersionView }) {
  const p = version.htir?.provenance;
  if (!p) {
    return <p className="text-xs text-muted-foreground">No provenance recorded for this version.</p>;
  }
  return (
    <div className="space-y-5">
      <KeyValue
        items={[
          { label: 'Subject', value: <IdChip id={p.subjectId} label="" /> },
          { label: 'Compiled at', value: <span className="you-num">{timeAbs(p.compiledAt)}</span> },
          { label: 'Compiled by', value: <span className="font-mono text-[12px]">{p.compiledBy}</span> },
          { label: 'Pipeline', value: p.pipeline?.pipelineId ? <span className="font-mono text-[12px]">{p.pipeline.pipelineId}</span> : null },
        ]}
      />

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Consent grants</h4>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {p.consentGrantIds?.length
            ? p.consentGrantIds.map((id) => <IdChip key={id} id={id} label="" />)
            : <span className="text-xs text-muted-foreground">—</span>}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pipeline components</h4>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {p.pipeline?.components?.length
            ? p.pipeline.components.map((c, i) => (
              <span
                key={`${c.adapterId}-${i}`}
                className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                title={`adapter ${c.adapterId} @ ${c.version}`}
              >
                {c.adapterId}<span className="you-num text-foreground/60">@{c.version}</span>
              </span>
            ))
            : <span className="text-xs text-muted-foreground">—</span>}
        </div>
      </div>

      <div>
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FileClock className="size-3" aria-hidden /> Evidence ({p.evidenceAssetIds?.length ?? 0} assets)
        </h4>
        {p.evidenceAssetIds?.length ? (
          <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto you-scroll pr-1" aria-label="Evidence references">
            {p.evidenceAssetIds.map((assetId, i) => (
              <li key={assetId} className="flex flex-wrap items-center gap-2">
                <IdChip id={assetId} label="" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground" title={p.evidenceHashes?.[i]}>
                  {p.evidenceHashes?.[i] ? `sha256: ${p.evidenceHashes[i].slice(0, 24)}…` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No evidence assets referenced.</p>
        )}
      </div>
    </div>
  );
}
