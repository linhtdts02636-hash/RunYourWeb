import http from "node:http";
import { readFile } from "node:fs/promises";
import { boot, stop } from "./boot.mjs";

if (!process.env.DAYTONA_API_KEY) {
  console.error("Set DAYTONA_API_KEY first");
  process.exit(1);
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => {
  let s = "";
  for await (const c of req) s += c;
  return JSON.parse(s || "{}");
};

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(await readFile(new URL("./daytona-test.html", import.meta.url)));
      }
      if (req.method === "POST" && req.url === "/boot") {
        const { repoUrl, branch, sha, token } = await readBody(req);
        return json(res, 200, await boot(repoUrl, { branch, sha, token }));
      }
      if (req.method === "POST" && req.url === "/stop") {
        const { sandboxId } = await readBody(req);
        await stop(sandboxId);
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  })
  .listen(5173, "127.0.0.1", () => console.log("http://127.0.0.1:5173"));
