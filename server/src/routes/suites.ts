import { suiteRequestSchema, type ApiErrorBody } from '@duel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SUITE_ID_PATTERN } from '../suite-store';
import type { SuiteManager } from '../suites';

interface IdParams {
  Params: { id: string };
}

const NO_SUITE = 'There is no suite with that id.';

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  const body: ApiErrorBody = { error, message };
  return reply.code(status).send(body);
}

/** Suites: a queue of text races that run one after another, and their summary. */
export function registerSuiteRoutes(app: FastifyInstance, deps: { suites: SuiteManager }): void {
  const { suites } = deps;

  app.post('/api/suites', async (request, reply) => {
    const parsed = suiteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        reply,
        400,
        'validation',
        parsed.error.issues[0]?.message ?? 'The suite request is not valid.',
      );
    }
    const started = suites.start(parsed.data);
    if (!started.ok) return fail(reply, started.status, started.error, started.message);
    request.log.info(
      { suiteId: started.suite.id, races: started.suite.races.length },
      'suite started',
    );
    return reply.code(201).send(started.suite);
  });

  app.get('/api/suites', async () => ({ suites: suites.list() }));

  app.get<IdParams>('/api/suites/:id', async (request, reply) => {
    if (!SUITE_ID_PATTERN.test(request.params.id)) return fail(reply, 404, 'not_found', NO_SUITE);
    const suite = await suites.get(request.params.id);
    return suite ?? fail(reply, 404, 'not_found', NO_SUITE);
  });

  app.post<IdParams>('/api/suites/:id/cancel', async (request, reply) => {
    if (!SUITE_ID_PATTERN.test(request.params.id)) return fail(reply, 404, 'not_found', NO_SUITE);
    const suite = await suites.cancel(request.params.id);
    return suite ?? fail(reply, 404, 'not_found', NO_SUITE);
  });

  /** Deletes the suite's record only: its races stay, with their result files. */
  app.delete<IdParams>('/api/suites/:id', async (request, reply) => {
    if (!SUITE_ID_PATTERN.test(request.params.id)) return fail(reply, 404, 'not_found', NO_SUITE);
    const result = await suites.remove(request.params.id);
    if (result === 'running') {
      return fail(reply, 409, 'running', 'This suite is still running. Cancel it first.');
    }
    if (result === 'missing') return fail(reply, 404, 'not_found', NO_SUITE);
    return reply.code(204).send();
  });
}
