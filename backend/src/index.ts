// backend/src/index.ts
import { createApp } from "./app";
import { env } from "./utils/env";

const app = createApp();

app.listen(Number(env.PORT), () => {
  console.log(`Backend listening on http://localhost:${env.PORT}`);
});
