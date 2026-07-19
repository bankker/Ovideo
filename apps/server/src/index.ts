import 'dotenv/config';
import { installOutboundProxy } from './lib/proxy.js';
import { buildApp, startRuntime } from './app.js';
import { db } from './lib/db.js';

// 必须在任何模型调用之前：Node 的全局 fetch 默认忽略 HTTP_PROXY/HTTPS_PROXY，
// 在「直连厂商不通、只能走本地代理」的机器上不接这一下，所有生成任务都会以「网络不可达」失败。
// 放在 dotenv 之后，因此代理也可以写在 .env 里。
installOutboundProxy();

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
