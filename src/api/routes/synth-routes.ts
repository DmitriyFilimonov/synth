import { Router } from 'express';
import {
  generateHandler,
  matchHandler,
  matchBinaryHandler,
  createMatchJobHandler,
  createMatchJobJsonHandler,
  getJobStatusHandler,
  getJobsListHandler,
  downloadJobResultHandler,
  downloadJobParamsHandler,
  deleteJobHandler,
} from '../controllers/synth-controller';

const router = Router();

router.post('/generate', generateHandler);

router.post('/match', matchHandler);
router.post('/match/binary', matchBinaryHandler);

router.post('/match/job', createMatchJobHandler);
router.post('/match/job/json', createMatchJobJsonHandler);
router.get('/match/jobs', getJobsListHandler);
router.get('/match/jobs/:id', getJobStatusHandler);
router.get('/match/jobs/:id/download', downloadJobResultHandler);
router.get(
  '/match/jobs/:id/download-params',
  downloadJobParamsHandler,
);
router.delete('/match/jobs/:id', deleteJobHandler);

export default router;
