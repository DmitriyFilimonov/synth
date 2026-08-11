import { Router } from 'express';
import {
  generateHandler,
  matchHandler,
  matchBinaryHandler,
} from '../controllers/synth-controller';

const router = Router();

router.post('/generate', generateHandler);

router.post('/match', matchHandler);
router.post('/match/binary', matchBinaryHandler);

export default router;
