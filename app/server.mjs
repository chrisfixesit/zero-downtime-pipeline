/**
 * Demo service for the zero-downtime pipeline.
 * The VERSION env var is baked in per image so you can watch
 * blue/green traffic shift between versions in real time.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = process.env.VERSION ?? "dev";
// Set CHAOS=1 on a deployment to make /healthz fail and demo auto-rollback.
const CHAOS = process.env.CHAOS === "1";

const started = Date.now();

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    if (CHAOS) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "unhealthy", chaos: true }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: VERSION }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      service: "zero-downtime-demo",
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
    })
  );
});

server.listen(PORT, () => {
  console.log(`v${VERSION} listening on :${PORT} (chaos=${CHAOS})`);
});
