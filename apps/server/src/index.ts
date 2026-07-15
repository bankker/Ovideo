import 'dotenv/config';
import { buildApp } from './app.js';

const port = Number(process.env.PORT || 8787);

const app = await buildApp();
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[ovideo-server] http://localhost:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
