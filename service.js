require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE = __dirname;
const DATA_FILE = path.join(BASE, "vouches.json");
const COMMANDS_FILE = path.join(BASE, "commands.json");
const TRANSCRIPT_DIR = path.join(BASE, "transcripts");
const PUBLIC_DIR = path.join(BASE, "public");
const API = "https://discord.com/api/v10";
const env = process.env;
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;
const SAFE_NAME = /^[\w\-. ]+\.txt$/;

const app = express();
app.use(express.json());
app.use(session({
  secret: env.DASHBOARD_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: "lax", secure: env.DASHBOARD_HTTPS === "1", maxAge: 12 * 60 * 60 * 1000 },
}));
app.use(express.static(PUBLIC_DIR));

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Checks the bot is in the dashboard server. Cached for 60 seconds.
let botCheck = { at: 0, ok: false };
async function botInGuild() {
  if (Date.now() - botCheck.at < 60_000) return botCheck.ok;
  const r = await fetch(`${API}/guilds/${env.DASHBOARD_GUILD_ID}`, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
  });
  botCheck = { at: Date.now(), ok: r.ok };
  return r.ok;
}

async function requireStaff(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Log in first." });
  if (!req.session.canManage) return res.status(403).json({ error: "You need Manage Server here." });
  if (!(await botInGuild())) return res.status(404).json({ error: "The bot isn't in this server." });
  next();
}

// ---------- pages ----------

app.get("/privacy", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "privacy.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "terms.html")));

// ---------- login ----------

app.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;
  const qs = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: env.DASHBOARD_REDIRECT,
    response_type: "code",
    scope: "identify guilds",
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${qs}`);
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.state) return res.status(400).send("Login state didn't match. Try again.");
  delete req.session.state;

  const tokenRes = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: env.DASHBOARD_REDIRECT,
    }),
  });
  if (!tokenRes.ok) return res.status(400).send("Discord login failed.");
  const { access_token } = await tokenRes.json();
  const auth = { Authorization: `Bearer ${access_token}` };

  const me = await (await fetch(`${API}/users/@me`, { headers: auth })).json();
  const guilds = await (await fetch(`${API}/users/@me/guilds`, { headers: auth })).json();

  req.session.user = {
    id: me.id,
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
  };
  req.session.canManage = guilds.some(g =>
    g.id === env.DASHBOARD_GUILD_ID && (BigInt(g.permissions) & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n);
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- API ----------

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null, canManage: !!req.session.canManage });
});

app.get("/api/guild", requireStaff, async (req, res) => {
  const r = await fetch(`${API}/guilds/${env.DASHBOARD_GUILD_ID}`, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
  });
  const g = await r.json();
  res.json({ id: g.id, name: g.name, icon: g.icon || null });
});

app.get("/api/commands", requireStaff, (req, res) => {
  res.json(readJson(COMMANDS_FILE, {}));
});

app.get("/api/panels", requireStaff, (req, res) => {
  res.json(readJson(DATA_FILE, {}).panels || {});
});

app.get("/api/overview", requireStaff, (req, res) => {
  const db = readJson(DATA_FILE, {});
  const msgs = db.messages || {};
  const gw = Object.values(db.giveaways || {});
  const warnings = Object.values(db.warnings || {}).reduce((n, list) => n + list.length, 0);
  const count = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

  const vouchCounts = {};
  for (const v of db.vouches || []) vouchCounts[v.target] = (vouchCounts[v.target] || 0) + 1;

  res.json({
    vouches: (db.vouches || []).length,
    proofs: (db.proofs || []).length,
    openTickets: Object.keys(db.tickets || {}).length,
    giveaways: gw.length,
    activeGiveaways: gw.filter(g => !g.ended && !g.cancelled).length,
    warnings,
    applications: Object.keys(db.apps?.applications || {}).length,
    loaRequests: Object.keys(db.loa || {}).length,
    messagesTracked: count(msgs),
    invites: count(db.invite_counts || {}),
    temproles: (db.temproles || []).length,
    topMessages: Object.entries(msgs).sort((a, b) => b[1] - a[1]).slice(0, 10),
    topVouched: Object.entries(vouchCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
  });
});

app.get("/api/transcripts", requireStaff, (req, res) => {
  if (!fs.existsSync(TRANSCRIPT_DIR)) return res.json([]);
  const items = fs.readdirSync(TRANSCRIPT_DIR)
    .filter(n => SAFE_NAME.test(n))
    .map(n => {
      const st = fs.statSync(path.join(TRANSCRIPT_DIR, n));
      return { name: n, size: st.size, time: Math.floor(st.mtimeMs / 1000) };
    })
    .sort((a, b) => b.time - a.time);
  res.json(items);
});

app.get("/api/transcripts/:name", requireStaff, (req, res) => {
  if (!SAFE_NAME.test(req.params.name)) return res.status(400).json({ error: "Bad file name." });
  const file = path.join(TRANSCRIPT_DIR, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found." });
  res.json({ name: req.params.name, text: fs.readFileSync(file, "utf8") });
});

app.get("/api/logs", requireStaff, (req, res) => {
  const db = readJson(DATA_FILE, {});
  const rows = (db.modlog || []).map(e => ({
    type: e.action, target: e.target, by: e.mod, reason: e.reason, time: e.time,
  }));
  for (const [uid, list] of Object.entries(db.warnings || {})) {
    for (const w of list) {
      rows.push({ type: `Warn #${w.case}`, target: uid, by: w.mod, reason: w.reason, time: w.time });
    }
  }
  rows.sort((a, b) => b.time - a.time);
  res.json(rows.slice(0, 300));
});

app.listen(Number(env.PORT || env.DASHBOARD_PORT || 8080), () => {
  console.log(`Dashboard running on port ${env.PORT || env.DASHBOARD_PORT || 8080}`);
});

