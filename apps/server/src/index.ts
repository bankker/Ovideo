import 'dotenv/config';
import { buildApp, startRuntime } from './app.js';
import { db } from './lib/db.js';

const port = Number(process.env.PORT || 8787);

const app = await buildApp({ db });
const worker = startRuntime(db);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[ovideo-server] http://localhost:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

const shutdown = async () => {
  await worker.stop();
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
