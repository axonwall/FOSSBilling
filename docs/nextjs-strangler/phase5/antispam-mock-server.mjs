// R5h antispam mock server (test-only, suite-owned, port 18026).
// Serves: (a) a fakefilter-format temp-domain list with a hit counter
// (to prove caching: a second call within TTL does NOT refetch);
// (b) captcha verify endpoints mimicking each provider's response
// shape (success true/false, v3 score + action, token-reuse marking
// — the provider-side single-use rule: a token's SECOND verify
// returns success:false); (c) a stopforumspam-shaped JSON endpoint
// (success true/false, per-field appears flags).
// Modes are set via POST /control {service, mode}; counts via GET
// /hits; POST /reset zeroes counters, token state, and modes.
// NEVER logs request bodies: the mock records token validity only,
// never secret values (parity uses dummy keys, never real secrets).
// Mode "drop" destroys the socket without responding, simulating a
// transport error (the mock itself stays alive for control/hits).
import http from "node:http";

const PORT = 18026;
const TEMP_LIST = [
  "# fakefilter-format comment line (must be dropped by the parser)",
  "",
  "mockthrow.test",
  "mockthrow2.test",
  "not a domain!!",
  "UPPERCASE-TEST.test",
  "sub.listed.test",
].join("\n") + "\n";

const state = {
  modes: { temp: "ok", sfs: "ok", recaptcha: "ok", turnstile: "ok", hcaptcha: "ok" },
  hits: { temp: 0, recaptcha: 0, turnstile: 0, hcaptcha: 0, sfs: 0 },
  usedTokens: new Set(),
};

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

// Token semantics per provider shape. "valid-token" always succeeds;
// "low-score-token" succeeds with score 0.2; "wrong-action-token"
// succeeds with score 0.9 but a foreign action; "reuse-token"
// succeeds ONCE then fails (provider-side single-use); anything else
// fails. v3 fields are included on recaptcha responses only.
function captchaResult(provider, token) {
  if (token === "reuse-token") {
    const key = provider + ":" + token;
    if (state.usedTokens.has(key)) return { success: false };
    state.usedTokens.add(key);
    return { success: true, ...(provider === "recaptcha" ? { score: 0.9, action: "fossbilling_submit" } : {}) };
  }
  if (token === "valid-token") {
    return { success: true, ...(provider === "recaptcha" ? { score: 0.9, action: "fossbilling_submit" } : {}) };
  }
  if (token === "low-score-token") {
    return { success: true, ...(provider === "recaptcha" ? { score: 0.2, action: "fossbilling_submit" } : {}) };
  }
  if (token === "wrong-action-token") {
    return { success: true, ...(provider === "recaptcha" ? { score: 0.9, action: "someone_else" } : {}) };
  }
  return { success: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  if (req.method === "GET" && path === "/temp-list") {
    state.hits.temp += 1;
    if (state.modes.temp === "drop") { req.socket.destroy(); return; }
    if (state.modes.temp === "500") { res.writeHead(500); res.end("mock temp-list failure"); return; }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(TEMP_LIST);
    return;
  }
  if (req.method === "POST" && (path === "/recaptcha" || path === "/turnstile" || path === "/hcaptcha")) {
    const provider = path.slice(1);
    state.hits[provider] += 1;
    if (state.modes[provider] === "drop") { req.socket.destroy(); return; }
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    // The response token field name differs per provider, but the
    // mock only needs the token VALUE; field name is not asserted.
    const token = params.get("response") ?? "";
    sendJson(res, captchaResult(provider, token));
    return;
  }
  if (req.method === "GET" && path === "/sfs") {
    state.hits.sfs += 1;
    if (state.modes.sfs === "drop") { req.socket.destroy(); return; }
    if (state.modes.sfs === "successfalse") { sendJson(res, { success: false }); return; }
    const ip = url.searchParams.get("ip") ?? "";
    const email = url.searchParams.get("email") ?? "";
    const username = url.searchParams.get("username") ?? "";
    sendJson(res, {
      success: true,
      username: { appears: username === "sfsuser" ? 1 : 0 },
      email: { appears: email === "sfsflag@example.com" ? 1 : 0 },
      ip: { appears: ip === "203.0.113.99" ? 1 : 0 },
    });
    return;
  }
  if (req.method === "POST" && path === "/control") {
    const body = JSON.parse(await readBody(req));
    if (body.service && body.mode) state.modes[body.service] = body.mode;
    sendJson(res, { modes: state.modes });
    return;
  }
  if (req.method === "POST" && path === "/reset") {
    state.modes = { temp: "ok", sfs: "ok", recaptcha: "ok", turnstile: "ok", hcaptcha: "ok" };
    state.hits = { temp: 0, recaptcha: 0, turnstile: 0, hcaptcha: 0, sfs: 0 };
    state.usedTokens.clear();
    sendJson(res, { reset: true });
    return;
  }
  if (req.method === "GET" && path === "/hits") {
    sendJson(res, { hits: state.hits, modes: state.modes });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`antispam mock listening on 127.0.0.1:${PORT}`);
});
