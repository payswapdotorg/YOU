'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Docs panel — REAL API reference rendered from a structured array that
// mirrors src/lib/you/client/api.ts (API v1). Plain <pre> blocks, no
// syntax-highlighter. Includes a copy-paste Playground recipe.
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { BookOpen, ChevronDown, Compass, Terminal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/you/shared/primitives';
import { CodeBlock } from '@/components/you/artifact/copy-button';
import { TOUR_RESTART_EVENT } from '@/components/you/develop/onboarding-tour';
import { cn } from '@/lib/utils';

type Method = 'GET' | 'POST' | 'DELETE';

interface EndpointDoc {
  method: Method;
  path: string;
  description: string;
  curl: string;
  response: string;
}

interface DocGroup {
  section: string;
  endpoints: EndpointDoc[];
}

const BASE = 'http://localhost:3000/api/v1';
const BASE_NOTE = `# set BASE to your Studio origin
BASE=${BASE}`;

const METHOD_STYLES: Record<Method, string> = {
  GET: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  POST: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  DELETE: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
};

const GROUPS: DocGroup[] = [
  {
    section: 'Session & overview',
    endpoints: [
      {
        method: 'GET', path: '/session',
        description: 'Current tenant/user session (cookie-authenticated).',
        curl: `curl -c cookies.txt $BASE/session`,
        response: `{\n  "user": { "id": "usr_…", "email": "you@local", "name": "Local Operator", "role": "owner" },\n  "tenant": { "id": "tnt_…", "name": "Local Studio", "slug": "local" }\n}`,
      },
      {
        method: 'GET', path: '/overview',
        description: 'Dashboard aggregates: counts, pipeline stages, recent events.',
        curl: `curl -b cookies.txt $BASE/overview`,
        response: `{\n  "twins": 1, "twinsReady": 0, "captures": 1, "evidenceAssets": 3,\n  "versions": 0, "renders": 0, "activeGrants": 1, "openEvidenceRequests": 0,\n  "labRuns": 0, "recentEvents": [], "pipeline": []\n}`,
      },
    ],
  },
  {
    section: 'Twins',
    endpoints: [
      {
        method: 'POST', path: '/twins',
        description: 'Create a twin. Idempotent with x-idempotency-key.',
        curl: `curl -b cookies.txt -X POST $BASE/twins \\\n  -H 'content-type: application/json' \\\n  -H 'x-idempotency-key: <uuid>' \\\n  -d '{"displayName":"Ada","personName":"Ada L."}'`,
        response: `{\n  "id": "twin_…", "displayName": "Ada", "personName": "Ada L.",\n  "subjectId": "subj_…", "status": "draft", "currentVersion": 0,\n  "createdAt": "2025-…", "updatedAt": "2025-…"\n}`,
      },
      {
        method: 'GET', path: '/twins/:id',
        description: 'Twin with versions and capture sessions.',
        curl: `curl -b cookies.txt $BASE/twins/twin_…`,
        response: `{\n  "id": "twin_…", "displayName": "Ada", "status": "capturing",\n  "versions": [], "captures": [ { "id": "cap_…", "status": "complete", "assets": [] } ]\n}`,
      },
      {
        method: 'GET', path: '/twins/:id/versions',
        description: 'Immutable TwinVersions with full HTIR documents.',
        curl: `curl -b cookies.txt $BASE/twins/twin_…/versions`,
        response: `[\n  { "id": "twv_…", "version": 1, "status": "published",\n    "confidenceSummary": { "overall": 0.74, "byDomain": {}, "deficiencies": [] },\n    "htir": { "twinId": "twin_…", "version": 1 } }\n]`,
      },
      {
        method: 'POST', path: '/twins/:id/compile',
        description: 'Compile evidence → HTIR → TwinVersion. Returns a durable job id.',
        curl: `curl -b cookies.txt -X POST $BASE/twins/twin_…/compile \\\n  -H 'content-type: application/json' \\\n  -d '{"captureSessionId":"cap_…","style":"photorealistic"}'`,
        response: `{ "jobId": "job_…" }`,
      },
      {
        method: 'DELETE', path: '/twins/:id',
        description: 'Delete a twin. Published versions are immutable; audit history persists.',
        curl: `curl -b cookies.txt -X DELETE $BASE/twins/twin_…`,
        response: `204 No Content`,
      },
    ],
  },
  {
    section: 'Captures & evidence',
    endpoints: [
      {
        method: 'POST', path: '/twins/:id/capture-sessions',
        description: 'Start a capture session (optionally fulfilling an evidence request).',
        curl: `curl -b cookies.txt -X POST $BASE/twins/twin_…/capture-sessions \\\n  -H 'content-type: application/json' -d '{}'`,
        response: `{\n  "id": "cap_…", "twinId": "twin_…", "status": "pending",\n  "checklist": [ { "item": "front face", "region": "face.front", "status": "pending" } ],\n  "assets": []\n}`,
      },
      {
        method: 'POST', path: '/captures/:id/assets',
        description: 'Upload an evidence asset (multipart). Raw captures are immutable evidence.',
        curl: `curl -b cookies.txt -X POST $BASE/captures/cap_…/assets \\\n  -F 'file=@front.jpg' \\\n  -F 'regions=["face.front"]'`,
        response: `{\n  "id": "evid_…", "kind": "image", "regions": ["face.front"],\n  "contentHash": "sha256-…", "bytes": 204800, "mime": "image/jpeg",\n  "quality": null, "createdAt": "2025-…"\n}`,
      },
      {
        method: 'POST', path: '/captures/:id/complete',
        description: 'Finish a capture session; quality analysis runs as a job.',
        curl: `curl -b cookies.txt -X POST $BASE/captures/cap_…/complete`,
        response: `{ "jobId": "job_…" }`,
      },
      {
        method: 'GET', path: '/evidence/:assetId/url',
        description: 'Signed, expiring URL for an evidence asset.',
        curl: `curl -b cookies.txt $BASE/evidence/evid_…/url`,
        response: `{ "url": "https://…signed…", "expiresAt": "2025-…" }`,
      },
    ],
  },
  {
    section: 'Consent',
    endpoints: [
      {
        method: 'POST', path: '/consent-grants',
        description: 'Grant explicit, scoped, revocable consent for a subject.',
        curl: `curl -b cookies.txt -X POST $BASE/consent-grants \\\n  -H 'content-type: application/json' \\\n  -d '{"subjectId":"subj_…","purpose":"twin creation","scopes":["capture","reconstruct","render"],"ttlHours":72}'`,
        response: `{\n  "id": "grant_…", "subjectId": "subj_…", "scopes": ["capture","reconstruct","render"],\n  "outputs": ["derived-only"], "expiresAt": "2025-…", "revokedAt": null\n}`,
      },
      {
        method: 'DELETE', path: '/consent-grants/:id',
        description: 'Revoke a grant. Server-enforced immediately.',
        curl: `curl -b cookies.txt -X DELETE $BASE/consent-grants/grant_…`,
        response: `204 No Content`,
      },
    ],
  },
  {
    section: 'Performances & renders',
    endpoints: [
      {
        method: 'POST', path: '/performances/from-text',
        description: 'Dialog text → performance state tracks (job).',
        curl: `curl -b cookies.txt -X POST $BASE/performances/from-text \\\n  -H 'content-type: application/json' \\\n  -d '{"name":"Greeting","script":"Hello!\\nHow can I help?"}'`,
        response: `{ "jobId": "job_…" }`,
      },
      {
        method: 'GET', path: '/performances/:id',
        description: 'Performance with tracks (state frames per track).',
        curl: `curl -b cookies.txt $BASE/performances/perf_…`,
        response: `{\n  "id": "perf_…", "name": "Greeting", "origin": "text", "durationMs": 8200,\n  "tracks": [ { "trackId": "state-1", "kind": "state",\n    "frames": [ { "t": 0, "state": "listening" }, { "t": 900, "state": "speaking" } ] } ]\n}`,
      },
      {
        method: 'POST', path: '/renders',
        description: 'Render a TwinVersion (optionally driven by a performance) — job.',
        curl: `curl -b cookies.txt -X POST $BASE/renders \\\n  -H 'content-type: application/json' \\\n  -d '{"twinId":"twin_…","twinVersionId":"twv_…","kind":"image","style":"stylized-portrait","adapter":"svg-portrait-1"}'`,
        response: `{ "jobId": "job_…" }`,
      },
    ],
  },
  {
    section: 'Agent avatars',
    endpoints: [
      {
        method: 'POST', path: '/agent-bodies',
        description: 'Create an Agent Body (role/capability/tool contract — no model vendor).',
        curl: `curl -b cookies.txt -X POST $BASE/agent-bodies \\\n  -H 'content-type: application/json' \\\n  -d '{"name":"Recon Reviewer","role":"evaluator","capabilities":["face.profile"],"tools":["evidence.read"]}'`,
        response: `{\n  "id": "body_…", "name": "Recon Reviewer", "role": "evaluator", "version": 1,\n  "capabilities": ["face.profile"], "tools": ["evidence.read"], "possessions": []\n}`,
      },
      {
        method: 'POST', path: '/agent-bodies/:id/possessions',
        description: 'Possess a Body with a Soul. The Body contract never changes.',
        curl: `curl -b cookies.txt -X POST $BASE/agent-bodies/body_…/possessions \\\n  -H 'content-type: application/json' -d '{"soulKey":"reasoning-primary"}'`,
        response: `{\n  "id": "body_…", "possessions": [ { "soulKey": "reasoning-primary", "routingClass": "system_two" } ]\n}`,
      },
      {
        method: 'POST', path: '/agent-avatar-sessions',
        description: 'Start an avatar session (body + soul + optional twin).',
        curl: `curl -b cookies.txt -X POST $BASE/agent-avatar-sessions \\\n  -H 'content-type: application/json' \\\n  -d '{"bodyId":"body_…","soulKey":"reasoning-primary"}'`,
        response: `{\n  "id": "avas_…", "bodyId": "body_…", "soulKey": "reasoning-primary",\n  "status": "live", "turns": []\n}`,
      },
      {
        method: 'POST', path: '/agent-avatar-sessions/:id/events',
        description: 'Send a user turn; returns the agent turn with performance-state events.',
        curl: `curl -b cookies.txt -X POST $BASE/agent-avatar-sessions/avas_…/events \\\n  -H 'content-type: application/json' -d '{"message":"Introduce yourself."}'`,
        response: `{\n  "turn": { "id": "turn_…", "role": "agent", "content": "…", "latencyMs": 1420,\n    "states": [ { "eventId": "ev_…", "type": "thinking", "timestamp": "…" } ] },\n  "events": []\n}`,
      },
      {
        method: 'DELETE', path: '/agent-avatar-sessions/:id',
        description: 'End a session. Recorded turns and events are kept.',
        curl: `curl -b cookies.txt -X DELETE $BASE/agent-avatar-sessions/avas_…`,
        response: `204 No Content`,
      },
    ],
  },
  {
    section: 'Labs',
    endpoints: [
      {
        method: 'POST', path: '/lab/runs',
        description: 'Run a benchmark on a seeded world — compares generalist, hand-designed and searched organizations (job).',
        curl: `curl -b cookies.txt -X POST $BASE/lab/runs \\\n  -H 'content-type: application/json' \\\n  -d '{"objectiveCode":"HUMAN-RECON-001","worldSeed":42}'`,
        response: `{ "jobId": "job_…" }`,
      },
      {
        method: 'GET', path: '/lab/runs/:id',
        description: 'Benchmark run with organizations and evaluation reports.',
        curl: `curl -b cookies.txt $BASE/lab/runs/run_…`,
        response: `{\n  "id": "run_…", "objectiveCode": "HUMAN-RECON-001", "worldSeed": 42,\n  "status": "succeeded", "organizations": [], "reports": []\n}`,
      },
      {
        method: 'GET', path: '/lab/technologies',
        description: 'Technology registry — adapters with four-column licensing.',
        curl: `curl -b cookies.txt $BASE/lab/technologies`,
        response: `[\n  { "id": "tech_…", "techId": "svg-portrait", "name": "SVG Portrait",\n    "source": "open", "status": "candidate",\n    "license": { "code": "MIT", "weights": "n/a", "data": "n/a", "providerTerms": "n/a" } }\n]`,
      },
    ],
  },
  {
    section: 'Developer platform',
    endpoints: [
      {
        method: 'POST', path: '/api-keys',
        description: 'Create an API key. The secret is returned exactly once.',
        curl: `curl -b cookies.txt -X POST $BASE/api-keys \\\n  -H 'content-type: application/json' -d '{"name":"CI key","scopes":["read"]}'`,
        response: `{\n  "key": { "id": "key_…", "name": "CI key", "prefix": "you_live_ab12", "scopes": ["read"] },\n  "secret": "you_live_ab12_…shown_once…"\n}`,
      },
      {
        method: 'GET', path: '/events?type=&limit=',
        description: 'Tenant event feed (filterable by type).',
        curl: `curl -b cookies.txt '$BASE/events?limit=20'`,
        response: `[\n  { "id": "evt_…", "type": "twin.created", "entityType": "Twin",\n    "entityId": "twin_…", "payload": {}, "createdAt": "2025-…" }\n]`,
      },
      {
        method: 'POST', path: '/webhooks',
        description: 'Register a webhook endpoint for selected event types.',
        curl: `curl -b cookies.txt -X POST $BASE/webhooks \\\n  -H 'content-type: application/json' \\\n  -d '{"url":"https://example.local/you/hooks","events":["twin.compiled","render.succeeded"]}'`,
        response: `{ "id": "wh_…", "url": "https://example.local/you/hooks", "active": true }\n}`,
      },
      {
        method: 'GET', path: '/usage',
        description: 'Metered usage metrics and totals.',
        curl: `curl -b cookies.txt $BASE/usage`,
        response: `{\n  "metrics": [ { "metric": "evidence.assets", "quantity": 3, "unit": "assets" } ],\n  "totals": { "evidenceMb": 0.6, "jobs": 1, "renders": 0, "llmCalls": 0 }\n}`,
      },
    ],
  },
  {
    section: 'Artifacts, feedback & jobs',
    endpoints: [
      {
        method: 'GET', path: '/artifacts/:id',
        description: 'Solution Artifact manifest — the portable review surface over canonical data.',
        curl: `curl -b cookies.txt $BASE/artifacts/sol_…`,
        response: `{\n  "id": "sol_…", "title": "Twin review — Ada v1", "type": "twin-review",\n  "manifest": { "solutionId": "sol_…", "type": "twin-review", "artifacts": [],\n    "evidence": [], "consent": { "grantIds": [], "scopes": ["render"] } }\n}`,
      },
      {
        method: 'POST', path: '/feedback',
        description: 'Create a feedback request. Creates review requests — never mutates immutable evidence.',
        curl: `curl -b cookies.txt -X POST $BASE/feedback \\\n  -H 'content-type: application/json' \\\n  -d '{"twinVersionId":"twv_…","verdict":"missing-detail","region":"face.profile","note":"ears unclear"}'`,
        response: `{\n  "id": "fbr_…", "twinVersionId": "twv_…", "verdict": "missing-detail",\n  "region": "face.profile", "status": "open"\n}`,
      },
      {
        method: 'POST', path: '/evidence-requests',
        description: 'Request targeted evidence for a capability gap.',
        curl: `curl -b cookies.txt -X POST $BASE/evidence-requests \\\n  -H 'content-type: application/json' \\\n  -d '{"twinVersionId":"twv_…","reason":"profile unclear","capability":"face.profile","instructions":"90° side photo","expectedSignal":"ear silhouette + jawline"}'`,
        response: `{\n  "id": "evreq_…", "capability": "face.profile", "status": "open",\n  "instructions": "90° side photo"\n}`,
      },
      {
        method: 'GET', path: '/jobs/:id',
        description: 'Durable job status — the single source of truth for async work.',
        curl: `curl -b cookies.txt $BASE/jobs/job_…`,
        response: `{\n  "id": "job_…", "kind": "twin.compile", "status": "running", "progress": 0.4,\n  "steps": [ { "key": "reconstruct", "label": "Reconstructing", "status": "running" } ]\n}`,
      },
    ],
  },
];

const PLAYGROUND = [
  {
    title: '1 · Create a twin',
    code: `curl -b cookies.txt -X POST $BASE/twins \\\n  -H 'content-type: application/json' \\\n  -d '{"displayName":"Ada"}'`,
  },
  {
    title: '2 · Start a capture session',
    code: `curl -b cookies.txt -X POST $BASE/twins/$TWIN_ID/capture-sessions \\\n  -H 'content-type: application/json' -d '{}'`,
  },
  {
    title: '3 · Upload evidence (immutable)',
    code: `curl -b cookies.txt -X POST $BASE/captures/$CAPTURE_ID/assets \\\n  -F 'file=@front.jpg' -F 'regions=["face.front"]'`,
  },
  {
    title: '4 · Complete the capture → quality job',
    code: `curl -b cookies.txt -X POST $BASE/captures/$CAPTURE_ID/complete`,
  },
  {
    title: '5 · Poll the job (durable truth, real progress only)',
    code: `curl -b cookies.txt $BASE/jobs/$JOB_ID`,
  },
  {
    title: '6 · Compile the twin → HTIR version',
    code: `curl -b cookies.txt -X POST $BASE/twins/$TWIN_ID/compile \\\n  -H 'content-type: application/json' \\\n  -d '{"captureSessionId":"'$CAPTURE_ID'","style":"photorealistic"}'`,
  },
  {
    title: '7 · Render an artifact from the version',
    code: `curl -b cookies.txt -X POST $BASE/renders \\\n  -H 'content-type: application/json' \\\n  -d '{"twinId":"'$TWIN_ID'","twinVersionId":"'$VERSION_ID'","kind":"image","style":"stylized-portrait"}'`,
  },
];

export function DocsPanel() {
  const [open, setOpen] = useState<Set<string>>(new Set(GROUPS.slice(0, 1).map((g) => g.section)));

  const toggle = (section: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });

  return (
    <div className="space-y-4">
      <SectionCard
        title="API reference"
        description="The same application services behind the Studio UI — HTTP, SDK, MCP and UI share one authority (ARCHITECTURE §12)."
        icon={BookOpen}
        actions={
          <Button
            variant="outline" size="sm" className="gap-1.5"
            onClick={() => window.dispatchEvent(new CustomEvent(TOUR_RESTART_EVENT))}
            title="Replay the first-run walkthrough of the primary flow"
          >
            <Compass className="size-3.5" aria-hidden /> Restart tour
          </Button>
        }
      >
        <CodeBlock code={BASE_NOTE} className="mb-4" />
        <p className="mb-4 text-xs text-muted-foreground">
          Mutating requests accept <span className="font-mono">x-idempotency-key</span>; async work returns a durable
          job id immediately; errors use stable machine codes.
        </p>
        <div className="space-y-2">
          {GROUPS.map((group) => {
            const isOpen = open.has(group.section);
            return (
              <div key={group.section} className="rounded-lg border">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm font-medium"
                  onClick={() => toggle(group.section)}
                  aria-expanded={isOpen}
                >
                  <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} aria-hidden />
                  {group.section}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{group.endpoints.length} endpoints</span>
                </button>
                {isOpen ? (
                  <div className="space-y-4 border-t px-3.5 py-3.5">
                    {group.endpoints.map((ep) => (
                      <div key={`${ep.method} ${ep.path}`} className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={`font-mono text-[10px] ${METHOD_STYLES[ep.method]}`}>{ep.method}</Badge>
                          <code className="font-mono text-xs font-semibold">{ep.path}</code>
                        </div>
                        <p className="text-xs text-muted-foreground">{ep.description}</p>
                        <CodeBlock code={ep.curl} />
                        <div>
                          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Response</div>
                          <CodeBlock code={ep.response} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Playground"
        description="Copy-paste recipe: create twin → capture → compile → render"
        icon={Terminal}
      >
        <CodeBlock code={BASE_NOTE} className="mb-4" />
        <div className="space-y-4">
          {PLAYGROUND.map((step) => (
            <div key={step.title} className="space-y-1.5">
              <div className="text-xs font-semibold">{step.title}</div>
              <CodeBlock code={step.code} />
            </div>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">
          Capture shell variables from each response (<span className="font-mono">TWIN_ID</span>,{' '}
          <span className="font-mono">CAPTURE_ID</span>, <span className="font-mono">JOB_ID</span>,{' '}
          <span className="font-mono">VERSION_ID</span>) as you go.
        </p>
        <Button
          variant="outline" size="sm" className="mt-2"
          onClick={() => window.open('https://github.com/payswapdotorg/YOU', '_blank', 'noopener')}
        >
          Canonical contracts — payswapdotorg/YOU
        </Button>
      </SectionCard>
    </div>
  );
}
