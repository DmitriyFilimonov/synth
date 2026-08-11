import express from 'express';
import type { Express } from 'express';
import { join } from 'path';
import { SAMPLE_RATE } from '../consts';
import synthRoutes from './routes/synth-routes';

export function createApp(): Express {
  const app = express();

  app.set('synth_sample_rate', SAMPLE_RATE);

  app.use(
    express.json({
      limit: '50mb',
    }),
  );

  app.use(
    express.raw({
      limit: '50mb',
      type: 'audio/wav',
    }),
  );

  const webDist = join(__dirname, '../../web/dist');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/presets', (_req, res) => {
    res.json({
      presets: ['synthPreset1'],
      defaultPreset: 'synthPreset1',
    });
  });

  app.use('/api', synthRoutes);

  app.use(express.static(webDist));

  app.use((_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });

  return app;
}
