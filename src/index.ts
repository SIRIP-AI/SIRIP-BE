import { createApp } from './infrastructure/http/app';
import { createDatabase } from './infrastructure/persistence/database';

const database = createDatabase();
const app = createApp(database);
const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});

async function shutdown() {
  server.close();
  await database.$disconnect();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
