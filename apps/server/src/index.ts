import 'dotenv/config';
import { buildApp, startRuntime } from './app.js';
import { db } from './lib/db.js';

// 用专属变量名：预览/托管环境常注入通用 PORT（如 5173），会与前端端口冲突
const port = Number(process.env.OVIDEO_SERVER_PORT || 8787);

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
