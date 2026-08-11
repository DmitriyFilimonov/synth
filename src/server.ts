import { createApp } from './api/app';

const PORT = process.env.PORT ?? 3000;

const app = createApp();

app.listen(PORT, () => {
  void 0;
});
