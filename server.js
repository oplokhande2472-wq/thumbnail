// Trakin Thumbnail Studio
// Image generation runs through the Codex CLI on each person's OWN ChatGPT
// login. No API key, no npm packages.
//
// Two modes:
//  - Local (default): runs on your computer at localhost, uses your codex login.
//  - Hosted: set TEAM_PASSWORD. Teammates sign in with the team password and
//    connect their own ChatGPT account (device code). Each person's login is
//    kept in its own folder under DATA_DIR/users/<name>/codex.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 4321;
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || "";
const HOSTED = TEAM_PASSWORD.length > 0;
const HOST = process.env.HOST || (HOSTED ? "0.0.0.0" : "127.0.0.1");
const ROOT = __dirname;
const DATA = path.resolve(process.env.DATA_DIR || ROOT);
const PUBLIC = path.join(ROOT, "public");
const JOBS = path.join(DATA, "jobs");
const AVATARS = path.join(DATA, "avatars");
const BRAND = path.join(DATA, "brand");
const USERS = path.join(DATA, "users");
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); } catch {}
const REFS = !HOSTED && CONFIG.referencesFolder && fs.existsSync(CONFIG.referencesFolder)
  ? path.resolve(CONFIG.referencesFolder)
  : path.join(DATA, "references");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

if (HOSTED && TEAM_PASSWORD.length < 8) {
  console.error("TEAM_PASSWORD must be at least 8 characters.");
  process.exit(1);
}
const IS_WIN = process.platform === "win32";
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

for (const d of [JOBS, AVATARS, BRAND, REFS, USERS]) fs.mkdirSync(d, { recursive: true });

// When DATA_DIR is a fresh volume, seed it with the files shipped in the app
// folder (reference thumbnails, logo, avatars) so the app works straight away.
if (DATA !== ROOT) {
  for (const sub of ["references", "brand", "avatars"]) {
    const src = path.join(ROOT, sub), dst = path.join(DATA, sub);
    if (!fs.existsSync(src) || fs.readdirSync(dst).length) continue;
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}

// ---------- team sign-in (hosted mode) ----------
const sessions = new Map(); // token -> { user, created }
const SESSION_MS = 30 * 24 * 3600 * 1000;
const failures = new Map(); // ip -> [timestamps]

function slugUser(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  if (!HOSTED) return "local";
  const s = sessions.get(parseCookies(req).tts);
  if (!s || Date.now() - s.created > SESSION_MS) return null;
  return s.user;
}
function codexHomeFor(user) {
  if (!HOSTED) return CODEX_HOME;
  const d = path.join(USERS, user, "codex");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
function codexEnv(user) {
  return { ...process.env, CODEX_HOME: codexHomeFor(user) };
}
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}
function passwordOk(pw) {
  const a = crypto.createHash("sha256").update(String(pw)).digest();
  const b = crypto.createHash("sha256").update(TEAM_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- ChatGPT device-code connect (hosted mode) ----------
const connects = new Map(); // user -> { status, url, code, log, child }
const stripAnsi = (t) => String(t).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

const STYLES = require("./styles.json");
const jobs = new Map();

// ---------- helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Upload too large (max 60 MB total)")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("Bad JSON")); }
    });
    req.on("error", reject);
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "Not found" });
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  });
}

// Prevent ../ escapes
function safeJoin(base, rel) {
  const p = path.resolve(base, "." + path.sep + decodeURIComponent(rel));
  return p.startsWith(path.resolve(base) + path.sep) || p === path.resolve(base) ? p : null;
}

function saveDataUrl(dataUrl, dir, baseName) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl || "");
  if (!m) throw new Error("Only PNG, JPG or WEBP images are supported");
  const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  const file = path.join(dir, `${baseName}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], "base64"));
  return file;
}

function listImages(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => IMG_EXT.has(path.extname(f).toLowerCase())).sort();
  } catch { return []; }
}

function walkImages(dir, since, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkImages(p, since, out);
    else if (IMG_EXT.has(path.extname(e.name).toLowerCase())) {
      try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push({ p, t: st.mtimeMs }); } catch {}
    }
  }
  return out;
}

function runCmd(args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("codex", args, { shell: IS_WIN, windowsHide: true, env: opts.env || process.env, ...opts });
    } catch (e) { return resolve({ code: -1, out: String(e) }); }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: -1, out: out + String(e) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// Pick references whose file names share words with the headline,
// topped up with the most recent ones, so every run has 3 style examples.
function autoPickRefs(text, n = 3) {
  const words = new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const files = listImages(REFS).map((f) => {
    const fw = f.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    let mt = 0; try { mt = fs.statSync(path.join(REFS, f)).mtimeMs; } catch {}
    return { f, score: fw.filter((w) => words.has(w)).length, mt };
  });
  files.sort((a, b) => b.score - a.score || b.mt - a.mt);
  return files.slice(0, n).map((x) => x.f);
}

// ---------- prompt ----------
function buildPrompt(job) {
  const s = STYLES.find((x) => x.id === job.style) || STYLES[0];
  const size = { "16:9": "1536x1024 landscape (16:9 YouTube thumbnail)", "9:16": "1024x1536 portrait (9:16 Reel / Shorts cover)", "1:1": "1024x1024 square post" }[job.aspect] || "1536x1024 landscape";
  const avatarLine = job.avatarFile
    ? `- HOST AVATAR: the image "${path.basename(job.avatarFile)}" is the host. Place this exact person at the BOTTOM ${job.avatarPosition === "center" ? "CENTRE" : job.avatarPosition.toUpperCase()} of the frame, chest-up and cropped by the bottom edge, head at roughly 55-60% of the frame height, large (about 40-45% of the frame height), facing camera with this expression: ${job.expression}. Keep their face, skin tone, hair and identity faithful to the reference — do not beautify or change who they are. Cut them out cleanly with a subtle rim light so they pop from the background.`
    : "- No host avatar: make the main subject (product / screenshot) the hero in the centre.";
  const mediaLine = job.mediaFiles.length
    ? `- MEDIA: use these reference files as real content in the design (screenshots, product shots, logos): ${job.mediaFiles.map((f) => `"${path.basename(f)}"`).join(", ")}. Show them recognisably (e.g. as tilted cards, phone screens or cut-outs) arranged around the host, not hidden behind them.`
    : "";
  const refLine = job.refFiles.length
    ? `- STYLE REFERENCES: ${job.refFiles.map((f) => `"${path.basename(f)}"`).join(", ")} are this channel's previous thumbnails. Match their overall look closely — colour grading, layout habits, how the host is cut out and lit, text treatment, energy and polish — so the new thumbnail clearly feels like the same channel. Do NOT copy their faces, products, logos or words; only the style.`
    : "";
  const textLine = job.textMode === "ai"
    ? `- TEXT: render the headline exactly as written, spelled correctly, letter for letter: "${job.headline}"${job.subtext ? ` and a smaller secondary line: "${job.subtext}"` : ""}. Huge, bold, high-contrast, readable on a phone at small size, max 2 lines. Do not add any other words.`
    : `- TEXT: do NOT draw any text, letters or words anywhere. Leave a clean, uncluttered area at the ${job.avatarPosition === "left" ? "right" : job.avatarPosition === "right" ? "left" : "top"} for a headline that will be added later. (Topic for context only, do not write it: "${job.headline}")`;

  const files = Array.from({ length: job.count }, (_, i) => `thumb_${i + 1}.png`).join(", ");
  return [
    `You are a thumbnail designer for the creator channel "Trakin". Use your built-in image generation tool (do not write code to draw images, do not use any API key).`,
    ``,
    `Create ${job.count} distinct thumbnail design option(s) — vary composition, colour accents and background each time while following the brief.`,
    ``,
    `BRIEF`,
    `- Format: ${size}.`,
    `- Style: ${s.name} — ${s.prompt}`,
    job.customStyle ? `- Extra style notes from the user: ${job.customStyle}` : "",
    refLine,
    avatarLine,
    mediaLine,
    textLine,
    job.notes ? `- Additional instructions: ${job.notes}` : "",
    `- No watermarks, no fake UI chrome, no borders. Professional, click-worthy, clean.`,
    ``,
    `OUTPUT`,
    `Save the finished images into the current working directory with exactly these file names: ${files}.`,
    `If the image tool saved them elsewhere, copy them into the current directory with those names. Do not create any other files. When done, reply with just "DONE".`,
  ].filter((l) => l !== "").join("\n");
}

// ---------- job runner ----------
async function runJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  const dir = job.dir;
  const prompt = buildPrompt(job);
  fs.writeFileSync(path.join(dir, "prompt.txt"), prompt);

  const images = [...job.refFiles, job.avatarFile, ...job.mediaFiles].filter(Boolean);
  const args = ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", dir];
  if (images.length) args.push(`--image=${images.join(",")}`);
  args.push("-"); // read prompt from stdin

  const child = spawn("codex", args, { cwd: dir, shell: IS_WIN, windowsHide: true, env: codexEnv(job.user) });
  job.pid = child.pid;
  const append = (d) => { job.log += d.toString(); if (job.log.length > 40000) job.log = job.log.slice(-40000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.stdin.write(prompt);
  child.stdin.end();

  const timer = setTimeout(() => { append("\n[timeout] Took longer than 15 minutes, stopping.\n"); child.kill(); }, JOB_TIMEOUT_MS);

  const code = await new Promise((resolve) => {
    child.on("error", (e) => { append(`\n[error] Could not start the image engine: ${e.message}\n`); resolve(-1); });
    child.on("close", resolve);
  });
  clearTimeout(timer);

  // Collect results: files Codex saved in the job folder, plus a fallback
  // scan of Codex's own generated-images folder for anything new.
  const inputs = new Set(images.map((f) => path.basename(f)));
  let results = listImages(dir).filter((f) => !inputs.has(f));
  if (!results.length) {
    const fresh = walkImages(codexHomeFor(job.user), job.startedAt - 2000).sort((a, b) => a.t - b.t).slice(-job.count);
    fresh.forEach((f, i) => {
      const name = `thumb_${i + 1}${path.extname(f.p)}`;
      fs.copyFileSync(f.p, path.join(dir, name));
      results.push(name);
    });
  }
  job.images = results.map((f) => `/jobs/${job.id}/${f}`);
  job.code = code;
  job.status = results.length ? "done" : "failed";
  if (!results.length && !job.error) {
    job.error = /login|auth|unauthori[sz]ed|401/i.test(job.log)
      ? (HOSTED ? "Your ChatGPT account isn't connected. Click the status button at the top to connect it." : "ChatGPT isn't connected. Open Command Prompt and run: codex login")
      : /usage limit|rate limit|quota/i.test(job.log)
      ? "Your ChatGPT image limit is used up for now. Try later or use another account."
      : code === -1 ? "The image engine isn't installed on this computer or server (npm i -g @openai/codex)."
      : "ChatGPT finished without producing an image. Open the details below.";
  }
  job.finishedAt = Date.now();
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- sign-in endpoints (open) ----
    if (req.method === "GET" && p === "/api/me") {
      const user = currentUser(req);
      return send(res, user ? 200 : 401, { hosted: HOSTED, user });
    }
    if (req.method === "POST" && p === "/api/login") {
      const ip = clientIp(req);
      const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60 * 1000);
      if (recent.length >= 10) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      const b = await readBody(req, 10000);
      const user = slugUser(b.name);
      if (!user) return send(res, 400, { error: "Enter your name" });
      if (!HOSTED || !passwordOk(b.password)) {
        recent.push(Date.now()); failures.set(ip, recent);
        return send(res, 401, { error: "Wrong team password" });
      }
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { user, created: Date.now() });
      const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
      res.setHeader("Set-Cookie", `tts=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
      return send(res, 200, { user });
    }
    if (req.method === "POST" && p === "/api/logout") {
      sessions.delete(parseCookies(req).tts);
      res.setHeader("Set-Cookie", "tts=; Path=/; Max-Age=0");
      return send(res, 200, { ok: true });
    }

    // ---- everything else needs a signed-in user (hosted mode) ----
    const isPublicAsset = req.method === "GET" && !p.startsWith("/api/") && !/^\/(jobs|avatars|brand|references)\//.test(p);
    const user = currentUser(req);
    if (!user && !isPublicAsset) return send(res, 401, { error: "Sign in first" });
    const env = user ? codexEnv(user) : process.env;

    if (req.method === "POST" && p === "/api/chatgpt/connect") {
      if (!HOSTED) return send(res, 400, { error: "On your own computer, run: codex login" });
      const old = connects.get(user);
      if (old && old.status === "waiting" && old.child) { try { old.child.kill(); } catch {} }
      const st = { status: "starting", url: null, code: null, log: "" };
      connects.set(user, st);
      const child = spawn("codex", ["login", "--device-auth"], { env, windowsHide: true });
      st.child = child;
      const onData = (d) => {
        st.log = (st.log + stripAnsi(d)).slice(-4000);
        const url = /(https:\/\/[^\s]*(?:device|auth)[^\s]*)/i.exec(st.log);
        const code = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(st.log);
        if (url) st.url = url[1];
        if (code) st.code = code[1];
        if (st.url && st.code && st.status === "starting") st.status = "waiting";
      };
      child.stdout.on("data", onData); child.stderr.on("data", onData);
      child.on("error", (e) => { st.status = "failed"; st.log += String(e); });
      child.on("close", (c) => { st.status = c === 0 ? "done" : "failed"; st.child = null; });
      setTimeout(() => { if (st.status === "starting") { st.status = "failed"; try { child.kill(); } catch {} } }, 60000);
      for (let i = 0; i < 40 && st.status === "starting"; i++) await new Promise((r) => setTimeout(r, 250));
      return send(res, 200, { status: st.status, url: st.url, code: st.code, log: st.status === "failed" ? st.log : "" });
    }
    if (req.method === "GET" && p === "/api/chatgpt/connect") {
      const st = connects.get(user) || { status: "none" };
      return send(res, 200, { status: st.status, url: st.url, code: st.code, log: st.status === "failed" ? st.log : "" });
    }
    if (req.method === "POST" && p === "/api/chatgpt/disconnect") {
      await runCmd(["logout"], { env });
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/status") {
      const v = await runCmd(["--version"], { env });
      if (v.code !== 0) return send(res, 200, { hosted: HOSTED, user, installed: false, loggedIn: false, detail: v.out.trim() });
      const s = await runCmd(["login", "status"], { env });
      const loggedIn = s.code === 0 && !/not logged in/i.test(s.out);
      return send(res, 200, { hosted: HOSTED, user, installed: true, version: v.out.trim(), loggedIn, detail: stripAnsi(s.out).trim() });
    }

    if (req.method === "GET" && p === "/api/styles") return send(res, 200, STYLES);

    if (req.method === "GET" && p === "/api/avatars") {
      return send(res, 200, listImages(AVATARS).map((f) => ({ name: f, url: `/avatars/${encodeURIComponent(f)}` })));
    }

    if (req.method === "POST" && p === "/api/avatars") {
      const body = await readBody(req);
      const name = String(body.name || "host").replace(/[^\w\- ]+/g, "").trim().slice(0, 40) || "host";
      const file = saveDataUrl(body.image, AVATARS, `${name}-${Date.now().toString(36)}`);
      return send(res, 200, { name: path.basename(file), url: `/avatars/${encodeURIComponent(path.basename(file))}` });
    }

    if (req.method === "GET" && p === "/api/references") {
      return send(res, 200, listImages(REFS).map((f) => ({ name: f, url: `/references/${encodeURIComponent(f)}` })));
    }

    if (req.method === "POST" && p === "/api/references") {
      const body = await readBody(req);
      const saved = (Array.isArray(body.images) ? body.images : []).slice(0, 20).map((img, i) =>
        path.basename(saveDataUrl(img, REFS, `ref-${Date.now().toString(36)}-${i}`)));
      return send(res, 200, saved);
    }

    if (req.method === "POST" && p === "/api/references/delete") {
      const body = await readBody(req);
      const f = safeJoin(REFS, String(body.name || ""));
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/brand") {
      const logo = listImages(BRAND).find((f) => /logo/i.test(f)) || listImages(BRAND)[0];
      return send(res, 200, { logo: logo ? `/brand/${encodeURIComponent(logo)}` : null });
    }

    if (req.method === "POST" && p === "/api/generate") {
      const b = await readBody(req);
      const headline = String(b.headline || "").trim();
      if (!headline) return send(res, 400, { error: "Headline text is required" });
      if ([...jobs.values()].some((j) => j.status === "running" && j.user === user)) {
        return send(res, 409, { error: "A thumbnail is already being generated. Wait for it to finish." });
      }

      const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + crypto.randomBytes(2).toString("hex");
      const dir = path.join(JOBS, id);
      fs.mkdirSync(dir, { recursive: true });

      let avatarFile = null;
      if (b.avatar && b.avatar.library) {
        const src = safeJoin(AVATARS, b.avatar.library);
        if (!src || !fs.existsSync(src)) return send(res, 400, { error: "Avatar not found" });
        avatarFile = path.join(dir, "host_avatar" + path.extname(src));
        fs.copyFileSync(src, avatarFile);
      } else if (b.avatar && b.avatar.dataUrl) {
        avatarFile = saveDataUrl(b.avatar.dataUrl, dir, "host_avatar");
      }
      const refFiles = [];
      let refNames = Array.isArray(b.references) ? b.references.slice(0, 4) : [];
      if (!refNames.length && b.autoRefs !== false) refNames = autoPickRefs(`${b.headline} ${b.subtext || ""} ${b.notes || ""}`);
      for (const [i, name] of refNames.entries()) {
        const src = safeJoin(REFS, String(name));
        if (!src || !fs.existsSync(src)) continue;
        const dst = path.join(dir, `style_ref_${i + 1}${path.extname(src)}`);
        fs.copyFileSync(src, dst); refFiles.push(dst);
      }
      const mediaFiles = (Array.isArray(b.media) ? b.media.slice(0, 6) : []).map((m, i) => saveDataUrl(m, dir, `media_${i + 1}`));

      const job = {
        id, dir, user, status: "queued", log: "", images: [], error: null, createdAt: Date.now(),
        style: String(b.style || STYLES[0].id),
        customStyle: String(b.customStyle || "").slice(0, 500),
        aspect: ["16:9", "9:16", "1:1"].includes(b.aspect) ? b.aspect : "16:9",
        avatarPosition: ["center", "left", "right"].includes(b.avatarPosition) ? b.avatarPosition : "center",
        expression: String(b.expression || "excited, mouth slightly open").slice(0, 120),
        headline: headline.slice(0, 120), subtext: String(b.subtext || "").trim().slice(0, 120),
        textMode: b.textMode === "overlay" ? "overlay" : "ai",
        notes: String(b.notes || "").slice(0, 800),
        count: Math.min(Math.max(parseInt(b.count, 10) || 2, 1), 4),
        avatarFile, mediaFiles, refFiles,
      };
      job.refNames = refNames;
      fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ ...job, dir: undefined, log: undefined }, null, 2));
      jobs.set(id, job);
      runJob(job).catch((e) => { job.status = "failed"; job.error = e.message; });
      return send(res, 200, { id });
    }

    const jm = /^\/api\/jobs\/([\w\-]+)$/.exec(p);
    if (req.method === "GET" && jm) {
      const j = jobs.get(jm[1]);
      if (!j) return send(res, 404, { error: "Job not found" });
      return send(res, 200, {
        id: j.id, status: j.status, images: j.images, error: j.error,
        headline: j.headline, subtext: j.subtext, refs: j.refNames || [], textMode: j.textMode, aspect: j.aspect,
        elapsed: Math.round(((j.finishedAt || Date.now()) - (j.startedAt || j.createdAt)) / 1000),
        log: j.log.slice(-6000),
      });
    }

    if (req.method === "POST" && /^\/api\/jobs\/[\w\-]+\/cancel$/.test(p)) {
      const j = jobs.get(p.split("/")[3]);
      if (j && j.status === "running" && j.pid) {
        try { IS_WIN ? spawn("taskkill", ["/pid", String(j.pid), "/T", "/F"]) : process.kill(j.pid); } catch {}
        j.error = "Cancelled";
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/history") {
      const dirs = fs.readdirSync(JOBS).filter((d) => fs.statSync(path.join(JOBS, d)).isDirectory()).sort().reverse().slice(0, 30);
      return send(res, 200, dirs.map((d) => {
        let req = {};
        try { req = JSON.parse(fs.readFileSync(path.join(JOBS, d, "request.json"), "utf8")); } catch {}
        return { id: d, headline: req.headline, aspect: req.aspect, images: listImages(path.join(JOBS, d)).filter((f) => f.startsWith("thumb") || f.startsWith("final")).map((f) => `/jobs/${d}/${f}`) };
      }).filter((h) => h.images.length));
    }

    // static files
    if (req.method === "GET") {
      for (const [prefix, base] of [["/jobs/", JOBS], ["/avatars/", AVATARS], ["/brand/", BRAND], ["/references/", REFS]]) {
        if (p.startsWith(prefix)) {
          const f = safeJoin(base, p.slice(prefix.length));
          return f ? serveFile(res, f) : send(res, 403, { error: "Forbidden" });
        }
      }
      const f = safeJoin(PUBLIC, p === "/" ? "index.html" : p.slice(1));
      return f ? serveFile(res, f) : send(res, 403, { error: "Forbidden" });
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}

// Local mode listens on localhost only, because it uses YOUR ChatGPT login
// without a password. Hosted mode (TEAM_PASSWORD set) listens publicly.
http.createServer(handle).listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}`;
  console.log(HOSTED
    ? `\n  Trakin Thumbnail Studio (hosted mode) listening on ${HOST}:${PORT}\n  Data folder: ${DATA}\n`
    : `\n  Trakin Thumbnail Studio is running at ${link}\n  Keep this window open. Press Ctrl+C to stop.\n`);
  if (process.argv.includes("--open")) {
    const opener = IS_WIN ? ["cmd", ["/c", "start", "", link]] : process.platform === "darwin" ? ["open", [link]] : ["xdg-open", [link]];
    try { spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref(); } catch {}
  }
});
