'use client';
// ═══════════════════════════════════════════════════════════════════════════
// API snippets for one Solution Artifact — curl examples carrying the REAL
// ids from this artifact (get / feedback / request evidence).
// ═══════════════════════════════════════════════════════════════════════════
import { Terminal } from 'lucide-react';
import type { SolutionArtifactManifest } from '@/lib/you/contracts';
import { SectionCard } from '@/components/you/shared/primitives';
import { CodeBlock } from '@/components/you/artifact/copy-button';

const BASE = 'http://localhost:3000/api/v1';

export function ApiSnippets({ artifactId, manifest }: { artifactId: string; manifest: SolutionArtifactManifest }) {
  const twinVersionId = manifest.twinVersion?.id ?? 'twv_…';
  const solutionRef = `solutionArtifactId: '${artifactId}',`;

  const getArtifact = `curl -b cookies.txt $BASE/artifacts/${artifactId}`;
  const feedback = `curl -b cookies.txt -X POST $BASE/feedback \\
  -H 'content-type: application/json' \\
  -d '{${solutionRef} "twinVersionId": "${twinVersionId}", "verdict": "missing-detail", "region": "face.profile", "note": "…" }'`;
  const requestEvidence = `curl -b cookies.txt -X POST $BASE/evidence-requests \\
  -H 'content-type: application/json' \\
  -d '{"twinVersionId": "${twinVersionId}", "reason": "…", "capability": "${manifest.evidence_request_schema.capabilities[0] ?? 'face.profile'}", "instructions": "…", "expectedSignal": "…"}'`;

  return (
    <SectionCard
      title="API"
      description="This artifact over HTTP — same application services the Studio uses"
      icon={Terminal}
    >
      <CodeBlock code={`# set BASE to your Studio origin\nBASE=${BASE}`} className="mb-4" />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Get this artifact</div>
          <CodeBlock code={getArtifact} />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Create feedback (review request — no direct mutation)</div>
          <CodeBlock code={feedback} />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Request targeted evidence</div>
          <CodeBlock code={requestEvidence} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Feedback creates review requests against this artifact’s TwinVersion; canonical data changes only through new
          versions compiled from new evidence.
        </p>
      </div>
    </SectionCard>
  );
}
