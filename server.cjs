// Production server for Hostinger Node.js hosting.
// Reads PORT from environment (Hostinger provides this dynamically).
const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");

const port = parseInt(process.env.PORT || "3000", 10);
const hostname = "0.0.0.0";
const app = next({ dev: false });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(port, hostname, () => {
    console.log(`✓ Yellow Chicken POS ready on http://${hostname}:${port}`);
  });
}).catch((err) => {
  console.error("Failed to start Next.js server:", err);
  process.exit(1);
});
