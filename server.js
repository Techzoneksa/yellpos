// Production server for Hostinger Node.js hosting.
// Uses ES module syntax (project has "type": "module").
import { createServer } from "http";
import next from "next";

const port = parseInt(process.env.PORT || "3000", 10);
const hostname = "0.0.0.0";
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    handle(req, res);
  }).listen(port, hostname, () => {
    console.log(`✓ Yellow Chicken POS ready on http://${hostname}:${port}`);
  });
}).catch((err) => {
  console.error("Failed to start Next.js server:", err);
  process.exit(1);
});
