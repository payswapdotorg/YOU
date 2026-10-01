// GET  /api/v1/lab/objectives — LabObjectiveView[] (research plane, global)
// POST /api/v1/lab/objectives — create (code unique → 409 on duplicate)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { conflict, handleRoute, readJsonBody, reqString } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { labObjectiveView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const objectives = await db.labObjective.findMany({ orderBy: { createdAt: 'asc' } });
    return Response.json(objectives.map(labObjectiveView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const code = reqString(body, 'code', { max: 64 }).toUpperCase().replace(/\s+/g, '-');
    const title = reqString(body, 'title', { max: 200 });
    const description = reqString(body, 'description', { max: 4000 });

    const existing = await db.labObjective.findUnique({ where: { code } });
    if (existing) throw conflict(`lab objective "${code}" already exists`);

    const objective = await db.labObjective.create({
      data: {
        code,
        title,
        description,
        target: '{}',
        gates: '{}',
        status: 'active',
      },
    });

    await emitEvent(auth.tenantId, 'lab.objective.created', 'lab_objective', objective.id, {
      objectiveId: objective.id,
      code,
      title,
    });

    return Response.json(labObjectiveView(objective), { status: 201 });
  });
}
