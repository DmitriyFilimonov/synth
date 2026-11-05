import { Router } from 'express';
import { frequencyEnvelopesHandler } from '../controllers/visualization-controller';

const router = Router();

router.post('/frequency-envelopes', frequencyEnvelopesHandler);

export default router;
