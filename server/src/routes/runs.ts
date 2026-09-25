import type { FastifyInstance } from 'fastify';
import type { DeviceRunIndex } from '../runs';

export function registerRunRoutes(app: FastifyInstance, options: { runs: DeviceRunIndex }): void {
  /** Every machine's run in every finished race, newest race first, for the Results tab. */
  app.get('/api/runs', async () => ({ runs: await options.runs.all() }));
}
