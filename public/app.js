const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (t) => new Date(t * 1000).toLocaleString();
const getJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const tile = (label, value) => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

let CATS = {};

const PAGES = {
  overview: { label: "Overview", render: overview },
  commands: { label: "Commands", render: commands },
  panels: { label: "Panels", render: panels },
  transcripts: { label: "Transcripts", render: transcripts },
  data: { label: "Data", render: data },
  logs: { label: "Logs", render: logs },
};

async function boot() {
  const me = await getJson("/api/me");
  if (!me.user) {
    $("#tabs").hidden = true;
    $("#main").innerHTML = `<div class="gate"><h1>Sniper Bot</h1>
      <p class="muted">Log in with Discord to open the dashboard.</p>
      <a class="btn" href="/login">Log in with Discord</a></div>`;
    return;
  }
  if (!me.canManage) {
    $("#main").innerHTML = `<div class="gate"><h1>No access</h1>
      <p class="muted">You need Manage Server in this server to open the dashboard.</p></div>`;
    return;
  }

  $("#account").innerHTML = `${me.user.avatar ? `<img src="${esc(me.user.avatar)}" alt="">` : ""}
    <span>${esc(me.user.name)}</span><button id="logout">Log out</button>`;
  $("#logout").onclick = async () => {
    await fetch("/logout", { method: "POST" });
    location.href = "/";
  };

  $("#tabs").innerHTML = Object.entries(PAGES)
    .map(([key, p]) => `<a href="#/${key}" data-page="${key}">${p.label}</a>`).join("");

  try { CATS = await getJson("/api/commands"); } catch { CATS = {}; }
  window.addEventListener("hashchange", route);
  route();
}

function parseHash() {
  const [, page = "overview", arg] = location.hash.replace(/^#\//, "").split("/");
  return { page: PAGES[page] ? page : "overview", arg: arg ? decodeURIComponent(arg) : null };
}

async function route() {
  const { page, arg } = parseHash();
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.page === page));
  renderChips(page, arg);

  const main = $("#main");
  main.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    main.innerHTML = await PAGES[page].render(arg);
    bindSearch();
  } catch (e) {
    main.innerHTML = `<p class="err">Couldn't load this page (${esc(e.message)}).</p>`;
  }
}

// Category chips only appear on the Commands page.
function renderChips(page, arg) {
  const box = $("#chips");
  if (page !== "commands") { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = [`<a href="#/commands" class="${!arg ? "on" : ""}">All</a>`]
    .concat(Object.entries(CATS).map(([k, c]) =>
      `<a href="#/commands/${k}" class="${arg === k ? "on" : ""}">${esc(c.label)}<span class="count">${c.commands.length}</span></a>`))
    .join("");
}

async function overview() {
  const d = await getJson("/api/overview");
  return `<h1>Overview</h1>
    <div class="tiles">
      ${tile("Vouches", d.vouches)}${tile("Payment proofs", d.proofs)}
      ${tile("Open tickets", d.openTickets)}${tile("Active giveaways", d.activeGiveaways)}
      ${tile("Warnings", d.warnings)}${tile("Applications", d.applications)}
      ${tile("LOA requests", d.loaRequests)}${tile("Temp roles", d.temproles)}
    </div>
    <p class="muted">Pick a tab above. Transcripts are saved when a ticket closes.</p>`;
}

function commands(cat) {
  const keys = cat ? [cat] : Object.keys(CATS);
  if (!keys.length) return `<h1>Commands</h1><p class="muted">No commands.json found. Restart the bot to create it.</p>`;
  return `<h1>Commands</h1>
    <input class="search" id="q" placeholder="Search commands…">
    ${keys.map(k => CATS[k] ? `<h2>${esc(CATS[k].label)}</h2>` +
      CATS[k].commands.map(c => `<div class="cmd" data-t="${esc((c.name + " " + c.desc).toLowerCase())}">
        <code>s!${esc(c.name)}</code><p>${esc(c.desc)}</p></div>`).join("") : "").join("")}`;
}

function bindSearch() {
  const q = $("#q");
  if (!q) return;
  q.oninput = () => {
    const v = q.value.trim().toLowerCase();
    document.querySelectorAll(".cmd").forEach(el => {
      el.style.display = el.dataset.t.includes(v) ? "" : "none";
    });
  };
}

async function panels() {
  const all = await getJson("/api/panels");
  const names = Object.keys(all);
  if (!names.length) return `<h1>Panels</h1><p class="muted">No ticket panels yet.</p>`;
  return `<h1>Panels</h1><div class="cards">${names.map(n => {
    const p = all[n], d = p.design || {}, info = p.info || {};
    return `<div class="card">
      <h3>${esc(n)}</h3>
      <p class="muted">${esc(d.title || "")}${d.description ? " · " + esc(d.description) : ""}</p>
      <div>${(p.options || []).map(o => `<span class="pill gold">${esc(o.label)}</span>`).join("")}</div>
      ${info.hours ? `<p><b>Hours:</b> ${esc(info.hours)}</p>` : ""}
    </div>`;
  }).join("")}</div>`;
}

async function transcripts(name) {
  if (name) {
    const t = await getJson(`/api/transcripts/${encodeURIComponent(name)}`);
    return `<h1>${esc(t.name)}</h1><a href="#/transcripts">← All transcripts</a>
      <pre class="log">${esc(t.text)}</pre>`;
  }
  const list = await getJson("/api/transcripts");
  if (!list.length) return `<h1>Transcripts</h1><p class="muted">No transcripts yet.</p>`;
  return `<h1>Transcripts</h1><table>
    <tr><th>File</th><th>Size</th><th>Saved</th></tr>
    ${list.map(t => `<tr class="click" onclick="location.hash='#/transcripts/${encodeURIComponent(t.name)}'">
      <td>${esc(t.name)}</td><td>${(t.size / 1024).toFixed(1)} KB</td><td>${when(t.time)}</td></tr>`).join("")}
  </table>`;
}

async function data() {
  const d = await getJson("/api/overview");
  const rows = (list) => list.length
    ? list.map(([id, n]) => `<tr><td>${esc(id)}</td><td>${esc(n)}</td></tr>`).join("")
    : `<tr><td colspan="2" class="muted">No data yet</td></tr>`;
  return `<h1>Data</h1>
    <div class="tiles">
      ${tile("Messages counted", d.messagesTracked)}${tile("Invites tracked", d.invites)}
      ${tile("Vouches", d.vouches)}${tile("Payment proofs", d.proofs)}
    </div>
    <div class="cards">
      <div class="card"><h3>Most messages</h3><table><tr><th>User ID</th><th>Count</th></tr>${rows(d.topMessages)}</table></div>
      <div class="card"><h3>Most vouched</h3><table><tr><th>User ID</th><th>Vouches</th></tr>${rows(d.topVouched)}</table></div>
    </div>`;
}

async function logs() {
  const rows = await getJson("/api/logs");
  if (!rows.length) return `<h1>Logs</h1><p class="muted">No moderation actions yet.</p>`;
  return `<h1>Logs</h1><table>
    <tr><th>When</th><th>Action</th><th>Target</th><th>By</th><th>Reason</th></tr>
    ${rows.map(r => `<tr><td>${when(r.time)}</td><td><span class="pill">${esc(r.type)}</span></td>
      <td>${esc(r.target)}</td><td>${esc(r.by)}</td><td>${esc(r.reason)}</td></tr>`).join("")}
  </table>`;
}

boot().catch(e => { $("#main").innerHTML = `<p class="err">Dashboard failed to start: ${esc(e.message)}</p>`; });
