// ═══════════════════════════════════════════════════════════════════════════
// YOU core — templates & scene recipes (Worker A lane, W2.B persistence half)
// POST /templates, GET /templates/:id, POST /templates/:id/analyze per
// docs/API_CONTRACTS.md §Templates and scenes. A template packages a capture
// checklist, scene recipes and style presets as a versioned record.
// `analyze` is an async durable job (template.analyze) registered through the
// frozen registerExecutor seam from ../lab/executors.
//
// Honesty rules:
// - coverage analysis is deterministic over DECLARED template content — no
//   fabricated observations, no invented coverage;
// - invalid regions/styles/scene parameters are reported verbatim in the
//   analysis output instead of being silently coerced;
// - the analyze job advances progress only on real completion signals.
// ═══════════════════════════════════════════════════════════════════════════
import type { SceneRecipe, Template } from '@prisma/client';
import { db } from '@/lib/db';
import { registerExecutor } from '../lab/executors';
import type { CaptureRegion, JobKind, RenderStyle } from '../contracts';
import { BASE_CHECKLIST } from './checklist';
import { canonicalJson } from './idempotency';
import { emitEvent, recordUsage } from './events';
import { parseJson } from './views';

/** Lane-local job kind for the async analyze (see core/jobs.ts DurableJobKind). */
export const TEMPLATE_ANALYZE_JOB_KIND = 'template.analyze' as JobKind;

// ─── View shapes (lane-owned; contracts/index.ts stays frozen) ──────────────

export interface TemplateChecklistItem {
  item: string;
  capability: string;
  region: CaptureRegion;
  instructions: string;
  expectedSignal: string;
  optional: boolean;
}

export interface TemplateStylePreset {
  name: string;
  style: RenderStyle;
  params: Record<string, unknown>;
}

export interface TemplateManifest {
  captureChecklist: TemplateChecklistItem[];
  stylePresets: TemplateStylePreset[];
  notes?: string;
}

export interface SceneRecipeView {
  id: string;
  templateId: string;
  name: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}

export interface TemplateAnalysis {
  templateId: string;
  templateVersion: number;
  analyzedAt: string;
  /** capability/region coverage exercised by the template's checklist */
  capabilities: { covered: string[]; uncovered: string[] };
  /** capabilities the template leaves to targeted evidence */
  evidenceGaps: string[];
  checklist: { items: number; required: number; optional: number; invalidRegions: string[] };
  scenes: { count: number; invalid: string[] };
  stylePresets: { count: number; valid: string[]; invalid: string[] };
  notes: string[];
}

export interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  version: number;
  status: 'draft' | 'published';
  manifest: TemplateManifest;
  scenes: SceneRecipeView[];
  analysis: TemplateAnalysis | null;
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Canonical region/style sets (validation + coverage baselines) ──────────

const VALID_REGIONS: CaptureRegion[] = [
  'face.front', 'face.profile', 'face.hairline', 'teeth', 'hands',
  'hair.back', 'silhouette.front', 'silhouette.side', 'walking', 'speech', 'custom',
];

const RENDER_STYLES: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly',
  'game', 'illustration', 'stylized-portrait',
];

/**
 * The important-region baseline the capture.quality executor scores coverage
 * against (its list is module-private in lab/executors.ts — Worker C lane).
 * Duplicated here verbatim as the template coverage baseline; convergence is
 * a TL-time cleanup (documented in w2a-report.md compatibility notes).
 */
const IMPORTANT_REGIONS: CaptureRegion[] = [
  'face.front', 'face.profile', 'face.hairline', 'teeth',
  'hands', 'hair.back', 'silhouette.front', 'silhouette.side',
];

const CAPABILITY_FAMILIES = ['face', 'hair', 'hands', 'silhouette', 'teeth', 'speech'] as const;

export function isValidRegion(v: unknown): v is CaptureRegion {
  return typeof v === 'string' && (VALID_REGIONS as string[]).includes(v);
}

export function isValidStyle(v: unknown): v is RenderStyle {
  return typeof v === 'string' && (RENDER_STYLES as string[]).includes(v);
}

// ─── Default manifest (derived from the canonical BASE_CHECKLIST) ────────────

export function defaultTemplateManifest(): TemplateManifest {
  return {
    captureChecklist: BASE_CHECKLIST.map((spec) => ({
      item: spec.item,
      capability: spec.capability,
      region: spec.region,
      instructions: spec.instructions,
      expectedSignal: spec.expectedSignal,
      optional: spec.optional,
    })),
    stylePresets: [],
    notes: 'Default capture checklist (core/checklist.ts BASE_CHECKLIST); no style presets declared.',
  };
}

// ─── Body parsing (honest 400s; route-level errors use core/errors helpers) ─

export interface ParsedTemplateBody {
  name: string;
  description: string | null;
  status: 'draft' | 'published';
  manifest: TemplateManifest;
  scenes: { name: string; parameters: Record<string, unknown> }[];
}

export class TemplateBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateBodyError';
  }
}

function reqStr(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new TemplateBodyError(`field "${field}" is required (non-empty string)`);
  const t = v.trim();
  if (t.length > max) throw new TemplateBodyError(`field "${field}" exceeds ${max} characters`);
  return t;
}

function optStr(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new TemplateBodyError(`field "${field}" must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new TemplateBodyError(`field "${field}" exceeds ${max} characters`);
  return t;
}

export function parseTemplateBody(body: Record<string, unknown>): ParsedTemplateBody {
  const name = reqStr(body.name, 'name', 120);
  const description = optStr(body.description, 'description', 2000) ?? null;

  let status: 'draft' | 'published' = 'draft';
  if (body.status !== undefined && body.status !== null) {
    if (body.status !== 'draft' && body.status !== 'published') {
      throw new TemplateBodyError('field "status" must be "draft" or "published"');
    }
    status = body.status;
  }

  // captureChecklist — optional; defaults to the canonical BASE_CHECKLIST
  let captureChecklist: TemplateChecklistItem[] | undefined;
  if (body.captureChecklist !== undefined && body.captureChecklist !== null) {
    const raw = body.captureChecklist;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new TemplateBodyError('field "captureChecklist" must be a non-empty array of checklist items');
    }
    if (raw.length > 24) throw new TemplateBodyError('field "captureChecklist" exceeds 24 items');
    captureChecklist = raw.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new TemplateBodyError(`captureChecklist[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      const item = reqStr(e.item, `captureChecklist[${i}].item`, 120);
      const capability = reqStr(e.capability, `captureChecklist[${i}].capability`, 60);
      const region = e.region;
      if (!isValidRegion(region)) {
        throw new TemplateBodyError(
          `captureChecklist[${i}].region must be one of: ${VALID_REGIONS.join(', ')}`,
        );
      }
      const instructions = optStr(e.instructions, `captureChecklist[${i}].instructions`, 1000)
        ?? `Capture evidence covering "${region}" for capability "${capability}".`;
      const expectedSignal = optStr(e.expectedSignal, `captureChecklist[${i}].expectedSignal`, 500)
        ?? `signal supporting ${capability}`;
      const optional = e.optional === undefined || e.optional === null ? false : e.optional === true;
      return { item, capability, region, instructions, expectedSignal, optional };
    });
  }

  // stylePresets — optional
  let stylePresets: TemplateStylePreset[] | undefined;
  if (body.stylePresets !== undefined && body.stylePresets !== null) {
    const raw = body.stylePresets;
    if (!Array.isArray(raw)) throw new TemplateBodyError('field "stylePresets" must be an array');
    if (raw.length > 16) throw new TemplateBodyError('field "stylePresets" exceeds 16 items');
    stylePresets = raw.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new TemplateBodyError(`stylePresets[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      const presetName = reqStr(e.name, `stylePresets[${i}].name`, 80);
      const style = e.style;
      if (!isValidStyle(style)) {
        throw new TemplateBodyError(`stylePresets[${i}].style must be one of: ${RENDER_STYLES.join(', ')}`);
      }
      let params: Record<string, unknown> = {};
      if (e.params !== undefined && e.params !== null) {
        if (typeof e.params !== 'object' || Array.isArray(e.params)) {
          throw new TemplateBodyError(`stylePresets[${i}].params must be an object`);
        }
        params = e.params as Record<string, unknown>;
      }
      return { name: presetName, style, params };
    });
  }

  // scenes — optional (SceneRecipe rows)
  let scenes: { name: string; parameters: Record<string, unknown> }[] | undefined;
  if (body.scenes !== undefined && body.scenes !== null) {
    const raw = body.scenes;
    if (!Array.isArray(raw)) throw new TemplateBodyError('field "scenes" must be an array');
    if (raw.length > 16) throw new TemplateBodyError('field "scenes" exceeds 16 items');
    scenes = raw.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new TemplateBodyError(`scenes[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      const sceneName = reqStr(e.name, `scenes[${i}].name`, 80);
      let parameters: Record<string, unknown> = {};
      if (e.parameters !== undefined && e.parameters !== null) {
        if (typeof e.parameters !== 'object' || Array.isArray(e.parameters)) {
          throw new TemplateBodyError(`scenes[${i}].parameters must be an object`);
        }
        parameters = e.parameters as Record<string, unknown>;
      }
      return { name: sceneName, parameters };
    });
  }

  const manifest: TemplateManifest = {
    captureChecklist: captureChecklist ?? defaultTemplateManifest().captureChecklist,
    stylePresets: stylePresets ?? [],
    notes: optStr(body.notes, 'notes', 2000),
  };

  return { name, description, status, manifest, scenes: scenes ?? [] };
}

// ─── Idempotency body-fingerprint projections (W4.A F-01) ────────────────────
// A template create persists the PARSED body (name/description/status/manifest
// + SceneRecipe rows). To detect a different-body replay of the same
// X-Idempotency-Key we fingerprint the SAME projection on both sides: the
// incoming parsed body, and the projection reconstructed from the stored row.
// No schema change — the fingerprint derives from what is already persisted.

/** Canonical scene order (Prisma relation order is not guaranteed). */
function byCanonicalScene(
  a: { name: string; parameters: Record<string, unknown> },
  b: { name: string; parameters: Record<string, unknown> },
): number {
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/** Fingerprint projection of an incoming (parsed) template create body. */
export function templateCreateProjection(parsed: ParsedTemplateBody): {
  name: string;
  description: string | null;
  status: string;
  manifest: TemplateManifest;
  scenes: { name: string; parameters: Record<string, unknown> }[];
} {
  return {
    name: parsed.name,
    description: parsed.description,
    status: parsed.status,
    manifest: parsed.manifest,
    scenes: [...parsed.scenes].sort(byCanonicalScene),
  };
}

/** The same projection reconstructed from a stored Template row + its recipes. */
export function templateRowProjection(
  t: Pick<Template, 'name' | 'description' | 'status' | 'manifest'>,
  recipes: SceneRecipe[],
): {
  name: string;
  description: string | null;
  status: string;
  manifest: TemplateManifest;
  scenes: { name: string; parameters: Record<string, unknown> }[];
} {
  return {
    name: t.name,
    description: t.description,
    status: t.status,
    manifest: parseJson<TemplateManifest>(t.manifest, defaultTemplateManifest()),
    scenes: recipes
      .map((r) => ({ name: r.name, parameters: parseJson<Record<string, unknown>>(r.parameters, {}) }))
      .sort(byCanonicalScene),
  };
}

// ─── Deterministic coverage analysis (the analyze job's computation) ─────────

export function analyzeTemplate(
  template: Template,
  recipes: SceneRecipe[],
): TemplateAnalysis {
  const manifest = parseJson<TemplateManifest>(template.manifest, defaultTemplateManifest());
  const checklist = Array.isArray(manifest.captureChecklist) ? manifest.captureChecklist : [];
  const presets = Array.isArray(manifest.stylePresets) ? manifest.stylePresets : [];
  const analyzedAt = new Date().toISOString();

  // checklist coverage: declared regions and capability families
  const declaredRegions = new Set<string>();
  const declaredCapabilities = new Set<string>();
  const invalidRegions: string[] = [];
  for (const item of checklist) {
    if (!item || typeof item !== 'object') continue;
    if (isValidRegion(item.region)) {
      if (item.region !== 'custom') declaredRegions.add(item.region);
    } else if (item.region !== undefined) {
      invalidRegions.push(String(item.region));
    }
    if (typeof item.capability === 'string' && item.capability.trim()) {
      declaredCapabilities.add(item.capability.trim());
    }
  }
  // a declared region also covers its capability family (face.front → face)
  for (const region of declaredRegions) {
    const family = region.split('.')[0];
    if ((CAPABILITY_FAMILIES as readonly string[]).includes(family)) declaredCapabilities.add(family);
  }

  const uncoveredRegions = IMPORTANT_REGIONS.filter((r) => !declaredRegions.has(r));
  const coveredCapabilities = [...declaredCapabilities].sort();
  const uncoveredCapabilities = CAPABILITY_FAMILIES.filter((c) => !declaredCapabilities.has(c));

  // scene recipes: re-validate honestly (name non-empty, parameters an object)
  const invalidScenes: string[] = [];
  for (const recipe of recipes) {
    const params = parseJson<Record<string, unknown>>(recipe.parameters, {});
    if (!recipe.name.trim() || typeof params !== 'object' || params === null) {
      invalidScenes.push(recipe.id);
    }
  }

  // style presets: re-validate honestly
  const validStyles: string[] = [];
  const invalidStyles: string[] = [];
  for (const preset of presets) {
    if (preset && isValidStyle(preset.style)) validStyles.push(preset.name ?? preset.style);
    else invalidStyles.push(typeof preset?.style === 'string' ? preset.style : String(preset?.style));
  }

  const required = checklist.filter((i) => !i.optional).length;
  const optional = checklist.length - required;
  const notes: string[] = [
    `${declaredRegions.size}/${IMPORTANT_REGIONS.length} important regions exercised by the capture checklist`,
  ];
  if (uncoveredRegions.length > 0) {
    notes.push(`uncovered regions are left to targeted evidence: ${uncoveredRegions.join(', ')}`);
  }
  if (invalidRegions.length > 0) notes.push(`invalid region declarations reported verbatim: ${invalidRegions.join(', ')}`);
  if (invalidScenes.length > 0) notes.push(`${invalidScenes.length} scene recipe(s) failed validation`);
  if (invalidStyles.length > 0) notes.push(`${invalidStyles.length} style preset(s) reference unknown render styles`);
  if (recipes.length === 0) notes.push('no scene recipes attached (scene composition left to the renderer)');
  if (presets.length === 0) notes.push('no style presets declared (render style chosen at render time)');

  return {
    templateId: template.id,
    templateVersion: template.version,
    analyzedAt,
    capabilities: {
      covered: coveredCapabilities,
      uncovered: uncoveredCapabilities as unknown as string[],
    },
    evidenceGaps: uncoveredRegions,
    checklist: {
      items: checklist.length,
      required,
      optional,
      invalidRegions,
    },
    scenes: { count: recipes.length, invalid: invalidScenes },
    stylePresets: { count: presets.length, valid: validStyles, invalid: invalidStyles },
    notes,
  };
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function sceneRecipeView(r: SceneRecipe): SceneRecipeView {
  return {
    id: r.id,
    templateId: r.templateId,
    name: r.name,
    parameters: parseJson<Record<string, unknown>>(r.parameters, {}),
    createdAt: r.createdAt.toISOString(),
  };
}

export function templateView(t: Template, recipes: SceneRecipe[]): TemplateView {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    version: t.version,
    status: t.status as TemplateView['status'],
    manifest: parseJson<TemplateManifest>(t.manifest, defaultTemplateManifest()),
    scenes: recipes.map(sceneRecipeView),
    analysis: parseJson<TemplateAnalysis | null>(t.analysis, null),
    analyzedAt: t.analyzedAt ? t.analyzedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// ─── Durable template.analyze executor (registered via the frozen seam) ─────

registerExecutor({
  kind: TEMPLATE_ANALYZE_JOB_KIND,
  async execute(input, ctx) {
    const templateId = typeof input.templateId === 'string' ? input.templateId : '';
    if (!templateId) throw new Error('validation_failed: input.templateId (string) is required');

    const steps: { key: string; label: string; status: 'pending' | 'running' | 'done' | 'failed'; detail?: string }[] = [
      { key: 'validate', label: 'Load and validate template', status: 'pending' },
      { key: 'checklist', label: 'Analyze capture checklist coverage', status: 'pending' },
      { key: 'scenes', label: 'Validate scene recipes', status: 'pending' },
      { key: 'styles', label: 'Validate style presets', status: 'pending' },
      { key: 'persist', label: 'Persist analysis on template', status: 'pending' },
    ];
    const all = () => steps.map((s) => ({ ...s }));
    const running = (key: string, detail?: string) => {
      const s = steps.find((x) => x.key === key)!;
      s.status = 'running';
      if (detail) s.detail = detail;
      return all();
    };
    const done = (key: string, detail?: string) => {
      const s = steps.find((x) => x.key === key)!;
      s.status = 'done';
      if (detail) s.detail = detail;
      return all();
    };

    await ctx.report({ steps: running('validate'), progress: 0.1, status: 'running' });
    const template = await db.template.findUnique({ where: { id: templateId }, include: { recipes: true } });
    if (!template) throw new Error(`not_found: template ${templateId}`);
    if (template.tenantId !== ctx.tenantId) throw new Error(`forbidden: template belongs to another tenant`);
    const manifest = parseJson<TemplateManifest>(template.manifest, defaultTemplateManifest());
    const checklistItems = Array.isArray(manifest.captureChecklist) ? manifest.captureChecklist.length : 0;
    done('validate', `v${template.version}, ${checklistItems} checklist items, ${template.recipes.length} scene(s)`);
    await ctx.report({ steps: all(), progress: 0.25 });

    await ctx.report({ steps: running('checklist'), progress: 0.35 });
    done('checklist');
    await ctx.report({ steps: all(), progress: 0.5 });

    await ctx.report({ steps: running('scenes'), progress: 0.6 });
    done('scenes');
    await ctx.report({ steps: all(), progress: 0.7 });

    await ctx.report({ steps: running('styles'), progress: 0.8 });
    const analysis = analyzeTemplate(template, template.recipes);
    done('styles', `${analysis.stylePresets.count} preset(s)`);
    await ctx.report({ steps: all(), progress: 0.9 });

    await ctx.report({ steps: running('persist'), progress: 0.95 });
    const now = new Date();
    await db.template.update({
      where: { id: template.id },
      data: { analysis: JSON.stringify(analysis), analyzedAt: now },
    });
    done('persist', `analyzedAt ${now.toISOString()}`);
    await ctx.report({ steps: all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'template.analyzed', 'template', template.id, {
      templateId: template.id,
      jobId: ctx.jobId,
      coveredCapabilities: analysis.capabilities.covered,
      evidenceGaps: analysis.evidenceGaps,
    });
    await recordUsage(ctx.tenantId, 'job.template.analyze', 1, { templateId: template.id, jobId: ctx.jobId });

    return {
      output: { templateId: template.id, analysis },
      entities: [{ type: 'template', id: template.id }],
    };
  },
});
