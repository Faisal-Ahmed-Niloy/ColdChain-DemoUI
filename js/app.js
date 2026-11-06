/* ColdChain web demo — user interface.
 * Pages: login, dashboard (with the simulated hardware), inventory, logs and
 * integrity, AI, admin. Every action goes through CC.world.api, which checks the
 * signed session token and the user's role, the way the FastAPI server does.
 */
"use strict";

(function () {
  const W = CC.world, act = CC.sim.act;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const app = $("#app");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
  const clock = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const stamp = ts => new Date(ts * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const WORD = { SAFE: "Safe", WARNING: "Warning", BREACH: "Breach", FAULT: "Sensor fault", AT_RISK: "At risk", DISCARD: "Discard" };
  const DEVS = ["FRIDGE-A", "FRIDGE-B"];

  /* ------------------------------------------------------------ session */
  let token = null, user = null, view = null;
  try { token = sessionStorage.getItem("cc-token"); } catch (e) { /* storage blocked */ }

  function call(fn, ...args) {
    try { return W.api[fn](token, ...args); }
    catch (e) {
      if (e.status === 401) { logout("Your session ended. Log in again."); }
      throw e;
    }
  }
  function tryCall(fn, ...args) {
    try { return call(fn, ...args); }
    catch (e) { if (e.status !== 401) toast(e.message, "critical"); return null; }
  }
  function logout(msg) {
    token = null; user = null;
    try { sessionStorage.removeItem("cc-token"); } catch (e) { /* ignore */ }
    view = null;
    renderLogin();
    if (msg) toast(msg);
  }
  const can = p => !!(user && user.permissions.includes(p));

  function toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = msg;
    $("#toasts").append(t);
    setTimeout(() => t.remove(), kind === "critical" ? 8000 : 4500);
  }

  /* ------------------------------------------------------------ shell */
  const NAV = [
    ["dashboard", "Dashboard", "dashboard.view", '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>'],
    ["inventory", "Inventory", "inventory.view", '<path d="M4 7h16M4 12h16M4 17h10"/>'],
    ["logs", "Logs", "logs.view", '<path d="M7 3h10l4 4v14H7zM11 11h6M11 15h6"/>'],
    ["ai", "AI", "ai.view", '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/><circle cx="12" cy="12" r="3"/>'],
    ["admin", "Admin", "users.manage", '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'],
  ];
  const LOGO = '<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--glacier)"/><path d="M16 6v20M8 11l16 10M24 11L8 21" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';

  function shell(id, title, inner) {
    app.innerHTML = `<div class="shell">
      <aside class="side">
        <div class="brand">${LOGO}<span>ColdChain</span></div>
        <nav class="nav" aria-label="Main">${NAV.filter(n => can(n[2])).map(n => `<a href="#${n[0]}" ${n[0] === id ? 'aria-current="page"' : ""}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${n[3]}</svg>${n[1]}</a>`).join("")}</nav>
        <div class="who"><strong>${esc(user.username)}</strong><span>${esc(user.role)}</span><button class="btn small" id="logout" type="button">Log out</button></div>
      </aside>
      <main class="main">
        <div class="topline"><h1>${esc(title)}</h1>
          <div class="clock"><span class="dot" aria-hidden="true"></span><span>Simulated time <strong id="simtime">${clock(W.S.now)}</strong></span>
            <span class="seg" role="group" aria-label="Demo speed">${[1, 10, 60].map(x => `<button type="button" data-speed="${x}" aria-pressed="${W.speed === x}">${x}×</button>`).join("")}</span>
          </div>
        </div>
        ${inner}
      </main></div>`;
    $("#logout").onclick = () => logout();
    $$("[data-speed]").forEach(b => { b.onclick = () => { act.setSpeed(Number(b.dataset.speed)); $$("[data-speed]").forEach(x => x.setAttribute("aria-pressed", String(Number(x.dataset.speed) === W.speed))); }; });
  }

  /* ------------------------------------------------------------ login */
  function renderLogin() {
    view = "login";
    const accounts = [["admin", "Admin@123", "Admin", "everything, including LED reset and users"],
      ["pharmacist", "Pharma@123", "Pharmacist", "stock, moves, alerts, one-click relocation"],
      ["inspector", "Inspect@123", "Inspector", "read-only: logs, integrity, security events"]];
    app.innerHTML = `<div class="login"><form class="panel login-card" id="login-form">
        <div class="brand" style="padding:0;font-size:22px">${LOGO}<span>ColdChain</span></div>
        <p class="muted">Vaccine and insulin fridge monitor. This is a live demo: two simulated fridges run in your browser.</p>
        <label for="u">Username<input id="u" name="username" autocomplete="username" required></label>
        <label for="p">Password<input id="p" name="password" type="password" autocomplete="current-password" required></label>
        <div class="error" id="login-error"></div>
        <button class="btn primary" type="submit">Log in</button>
        <div class="accounts"><span class="muted" style="font-size:13px">Demo accounts (click to fill in)</span>
          ${accounts.map(a => `<button class="btn account" type="button" data-u="${a[0]}" data-p="${a[1]}"><strong>${a[2]}</strong><code>${a[0]} / ${a[1]}</code><span>${a[3]}</span></button>`).join("")}
        </div>
      </form></div>`;
    $$(".account").forEach(b => { b.onclick = () => { $("#u").value = b.dataset.u; $("#p").value = b.dataset.p; $("#p").focus(); }; });
    $("#login-form").onsubmit = ev => {
      ev.preventDefault();
      try {
        const r = W.api.login($("#u").value, $("#p").value);
        token = r.token; user = r.user;
        try { sessionStorage.setItem("cc-token", token); } catch (e) { /* ignore */ }
        if (location.hash !== "#dashboard") location.hash = "#dashboard"; else route();
      } catch (e) { $("#login-error").textContent = e.message; }
    };
  }

  /* ------------------------------------------------------------ dashboard */
  const pos = t => Math.max(0, Math.min(100, t / 16 * 100));

  function hwPanel() {
    return `<section class="panel" aria-labelledby="hw-h">
      <h2 id="hw-h">Simulated fridge nodes</h2>
      <p class="muted" style="font-size:13px">What the ESP32, OLED, LEDs and buzzer on each fridge would show. Use the buttons the way you would use the real door, power button and router.</p>
      <div class="hw">${DEVS.map(dev => {
        const L = dev.slice(-1);
        return `<div class="node" data-dev="${dev}">
          <div class="board">
            <div class="oled" id="oled-${L}" aria-live="off"></div>
            <div class="leds"><span class="led g" id="led-g-${L}" title="green: safe"></span><span class="led y" id="led-y-${L}" title="yellow: warning"></span><span class="led r" id="led-r-${L}" title="red: breach or discard"></span><span class="buzz" id="buzz-${L}">BUZZER</span></div>
          </div>
          <div class="node-controls">
            <h3>Fridge ${L}</h3>
            <div class="row"><button class="btn small" type="button" data-act="door" data-dev="${dev}"></button>
              <button class="btn small" type="button" data-act="power" data-dev="${dev}"></button>
              <button class="btn small" type="button" data-act="wifi" data-dev="${dev}"></button></div>
            <label for="wear-${L}">Compressor strength <span id="wear-v-${L}"></span><input type="range" id="wear-${L}" min="0.2" max="1" step="0.05" data-act="wear" data-dev="${dev}"></label>
          </div>
        </div>`;
      }).join("")}</div>
    </section>`;
  }

  function updateHw() {
    for (const dev of DEVS) {
      const n = W.nodes[dev], o = n.oled(), L = dev.slice(-1);
      const el = $(`#oled-${L}`);
      if (!el) return;
      const alertSt = o.state !== "SAFE";
      el.innerHTML = `<div class="l1"><span>${o.dev}</span><span>${esc(o.link)}</span></div>
        <div class="big">${o.temp === null ? "--.-" : fmt(o.temp)}<small> C</small></div>
        <div><span class="st ${alertSt ? "inv" : ""}">${o.state}</span></div>
        <div class="l4"><span>${o.door}</span><span>${o.comp}</span><span>${o.power}${o.batt}%</span></div>`;
      $(`#led-g-${L}`).classList.toggle("on", o.leds.green);
      $(`#led-y-${L}`).classList.toggle("on", o.leds.yellow);
      const r = $(`#led-r-${L}`);
      r.classList.toggle("on", o.leds.red);
      r.classList.toggle("blink", o.leds.red && !n.ledLatch);
      $(`#buzz-${L}`).classList.toggle("on", o.buzzer);
      const set = (a, text, pressed) => { const b = $(`[data-act="${a}"][data-dev="${dev}"]`); b.textContent = text; b.setAttribute("aria-pressed", String(pressed)); };
      set("door", n.door ? "Close door" : "Open door", n.door);
      set("power", n.mains ? "Cut power" : "Restore power", !n.mains);
      set("wifi", n.wifi ? "Turn Wi-Fi off" : "Turn Wi-Fi on", !n.wifi);
      const w = $(`#wear-${L}`);
      if (document.activeElement !== w) w.value = n.fridge.p.health;
      $(`#wear-v-${L}`).textContent = `${Math.round(n.fridge.p.health * 100)}%`;
    }
  }

  function bindHw() {
    $$("[data-act]").forEach(el => {
      const dev = el.dataset.dev, a = el.dataset.act;
      if (a === "wear") el.oninput = () => { act.wear(dev, Number(el.value)); };
      else el.onclick = () => {
        const n = W.nodes[dev];
        if (a === "door") act.door(dev, !n.door);
        if (a === "power") act.power(dev);
        if (a === "wifi") act.wifi(dev, !n.wifi);
        updateHw();
      };
    });
  }

  function fridgePanel(f) {
    const st = f.online ? (f.state || "SAFE") : null;
    const power = f.power === "BATTERY" ? `Battery ${f.batt}%` : "Mains";
    const health = f.health === null ? `<span class="muted">${esc(f.healthNote)}</span>`
      : `<span class="health"><span class="meter ${f.health >= 70 ? "" : f.health >= 40 ? "mid" : "low"}"><i style="width:${f.health}%"></i></span><strong class="num">${Math.round(f.health)}</strong></span>`;
    const batches = f.batches.length ? f.batches.map(b => `<div class="batch">
        <div><div class="name">${esc(b.vaccine)}</div><div class="sub">Lot ${esc(b.lot)}, ${b.qty} units, expires ${esc(b.expiry)}${b.expired ? " (expired)" : ""}</div></div>
        <span class="chip ${b.status}">${WORD[b.status]}</span>
        <div class="budget"><span class="meter ${b.remainingPct < 20 ? "low" : b.remainingPct < 50 ? "mid" : ""}"><i style="width:${b.remainingPct}%"></i></span><span>${fmt(b.remainingMin, 0)} min left</span></div>
      </div>`).join("") : `<p class="muted">No batches stored here.</p>`;
    return `<section class="panel fridge" aria-labelledby="h-${f.id}">
      <div class="fridge-head"><h2 id="h-${f.id}">${esc(f.name)}</h2>
        ${f.online ? `<span class="chip ${st}">${WORD[st]}</span>` : `<span class="chip off">Offline</span>`}</div>
      <div class="reading">
        <div class="temp ${f.online ? st : ""}">${fmt(f.temp)}<small>°C</small></div>
        <div class="info muted"><span>Reading from ${clock(f.stateTs || W.S.now)}</span>
          ${f.backlog > 1 ? `<span>Syncing ${f.backlog} buffered readings</span>` : ""}
          ${f.ledLatch ? `<span class="chip DISCARD">Red LED latched</span>` : ""}</div>
      </div>
      <dl class="facts">
        <div><dt>Door</dt><dd class="${f.door && f.doorOpenS > 60 ? "alarm" : ""}">${f.door ? `Open ${f.doorOpenS} s` : "Closed"}</dd></div>
        <div><dt>Compressor</dt><dd>${f.comp ? "Running" : "Off"}</dd></div>
        <div><dt>Power</dt><dd class="${f.power === "BATTERY" ? "alarm" : ""}">${power}</dd></div>
        <div><dt>Stock</dt><dd>${f.unitsUsed} / ${f.capacity}</dd></div>
      </dl>
      <div class="ai-line ${f.predWarn ? "warn" : ""}">
        <span><strong>30-min forecast:</strong> ${esc(f.predNote)}</span><span class="num">${f.pred !== null && f.pred !== undefined ? `${fmt(f.pred)} °C` : ""}</span>
        <span><strong>Compressor health</strong> <span class="muted">${f.health === null ? "" : esc(f.healthNote)}</span></span>${health}
      </div>
      <canvas class="chart" data-fridge="${f.id}" role="img" aria-label="${esc(f.name)}: temperature over the last 60 minutes and the 30-minute forecast"></canvas>
      <div>${batches}</div>
    </section>`;
  }

  function relocBanner(r) {
    const p = r.plan;
    const items = p.moves.map(m => `<li><strong>${esc(m.vaccine)}</strong> lot ${esc(m.lot)} (${m.qty} units, ${fmt(m.remaining, 0)}% budget left) to ${esc(m.toName)}</li>`).join("")
      + p.unplaced.map(m => `<li><strong>${esc(m.vaccine)}</strong> lot ${esc(m.lot)}: no safe fridge has room</li>`).join("");
    return `<section class="reloc" aria-live="assertive">
      <h2>${esc(p.sourceName)} may become unsafe</h2>
      <div>Why: ${p.reasons.map(esc).join("; ")}.</div>
      <ul>${items}</ul>
      <div>${esc(p.advice)}</div>
      ${can("relocation.confirm") ? `<div class="row"><button class="btn primary" type="button" data-confirm="${r.id}" ${p.moves.length ? "" : "disabled"}>Confirm and move ${p.moves.length} batch${p.moves.length === 1 ? "" : "es"}</button>
        <button class="btn" type="button" data-dismiss="${r.id}">Dismiss</button></div>` : `<div class="muted">A pharmacist must confirm this move.</div>`}
    </section>`;
  }

  function alertsList(list) {
    if (!list.length) return `<p class="muted">No alerts yet.</p>`;
    return list.map(a => `<div class="alert"><span class="sev ${a.severity}" aria-hidden="true"></span>
      <div>${esc(a.message)}<span class="when">${stamp(a.ts)}${a.notify ? ". Telegram/e-mail sent by the backend" : ""}${a.ack && a.ack !== "history" ? `. Acknowledged by ${esc(a.ack)}` : ""}</span></div>
      ${!a.ack && a.severity !== "info" && can("alert.ack") ? `<button class="btn small" type="button" data-ack="${a.id}">Acknowledge</button>` : "<span></span>"}</div>`).join("");
  }

  function viewDashboard() {
    shell("dashboard", "Storage overview", `<div class="stack">
      <div id="relocs" class="stack"></div>
      ${hwPanel()}
      <p class="muted" id="summary" style="margin:0"></p>
      <div class="grid2" id="fridges"></div>
      <section class="panel"><h2>Alerts</h2><div id="alerts"></div></section>
    </div>`);
    bindHw();
    refreshDashboard();
  }

  function refreshDashboard() {
    const d = tryCall("dashboard");
    if (!d) return;
    updateHw();
    $("#relocs").innerHTML = d.relocations.map(relocBanner).join("");
    $("#summary").textContent = `${d.summary.SAFE} batches safe, ${d.summary.AT_RISK} at risk, ${d.summary.DISCARD} to discard.`;
    $("#fridges").innerHTML = d.fridges.map(fridgePanel).join("");
    $("#alerts").innerHTML = alertsList(d.alerts);
    $$("[data-confirm]").forEach(b => { b.onclick = () => {
      const r = tryCall("confirmRelocation", Number(b.dataset.confirm));
      if (r) toast(`Moved ${r.applied.length} batch${r.applied.length === 1 ? "" : "es"}${r.skipped.length ? `; ${r.skipped.length} skipped` : ""}`);
      refreshDashboard();
    }; });
    $$("[data-dismiss]").forEach(b => { b.onclick = () => { tryCall("dismissRelocation", Number(b.dataset.dismiss)); refreshDashboard(); }; });
    $$("[data-ack]").forEach(b => { b.onclick = () => { tryCall("ackAlert", Number(b.dataset.ack)); refreshDashboard(); }; });
    $$("canvas.chart").forEach(c => { const h = tryCall("history", c.dataset.fridge, 60); if (h) drawChart(c, h); });
  }

  // Temperature over the last 60 min, the 2–8 °C band, door openings, and the 30-min forecast
  function drawChart(canvas, h) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, ht = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr; canvas.height = ht * dpr;
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
    const now = W.S.now, t0 = now - 3600, t1 = now + 1800;
    const rows = h.readings.filter(r => r.temp !== null);
    const preds = h.predictions;
    const last = preds.length ? preds[preds.length - 1] : null;
    const vals = rows.map(r => r.temp).concat(last ? [last.upper] : []);
    const lo = Math.min(0, ...vals), hi = Math.max(12, ...vals);
    const L = 30, R = 8, T = 8, B = 22;
    const X = t => L + (t - t0) / (t1 - t0) * (w - L - R), Y = v => T + (hi - v) / (hi - lo) * (ht - T - B);
    g.fillStyle = col("--band"); g.fillRect(L, Y(8), w - L - R, Y(2) - Y(8));
    g.strokeStyle = col("--line"); g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(now), T); g.lineTo(X(now), ht - B); g.stroke();
    g.fillStyle = col("--slate"); g.font = "11px Public Sans, system-ui, sans-serif";
    g.textAlign = "right"; [2, 8].forEach(v => g.fillText(String(v), L - 6, Y(v) + 4));
    g.textAlign = "left"; g.fillText("60 min ago", L, ht - 6);
    g.textAlign = "center"; g.fillText("now", X(now), ht - 6);
    g.textAlign = "right"; g.fillText("+30 min", w - R, ht - 6);
    g.fillStyle = col("--warn");
    h.readings.forEach(r => { if (r.door) g.fillRect(X(r.ts) - 1, ht - B - 6, 2, 6); });
    if (rows.length > 1) {
      g.strokeStyle = col("--ink"); g.lineWidth = 1.8; g.beginPath();
      rows.forEach((r, i) => (i ? g.lineTo(X(r.ts), Y(r.temp)) : g.moveTo(X(r.ts), Y(r.temp))));
      g.stroke();
    }
    if (last && rows.length) {
      const x0 = X(rows[rows.length - 1].ts), y0 = Y(rows[rows.length - 1].temp);
      g.fillStyle = col("--glacier"); g.globalAlpha = 0.16;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(X(t1), Y(last.upper)); g.lineTo(X(t1), Y(last.pred)); g.closePath(); g.fill();
      g.globalAlpha = 1; g.strokeStyle = col("--glacier"); g.setLineDash([5, 4]); g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(X(t1), Y(last.pred)); g.stroke(); g.setLineDash([]);
      g.fillStyle = col("--glacier"); g.beginPath(); g.arc(X(t1) - 3, Y(last.pred), 3.5, 0, 7); g.fill();
    }
  }

  /* ------------------------------------------------------------ inventory */
  function viewInventory() {
    const fridges = tryCall("fridges") || [];
    const opts = fridges.map(f => `<option value="${f.id}">${esc(f.name)} (${f.free} units free)</option>`).join("");
    const editable = can("inventory.edit");
    shell("inventory", "Inventory", `<div class="stack">
      <section class="panel"><h2>Receive a batch</h2>
        ${editable ? "" : `<p class="muted">Inspectors have read-only access. The server enforces this, not just the screen:</p>`}
        <form id="add-batch" class="form-row">
          <label for="f-v">Vaccine or medicine<input id="f-v" name="vaccine" maxlength="80" required></label>
          <label for="f-l">Lot number<input id="f-l" name="lot" maxlength="40" required></label>
          <label for="f-q">Units<input id="f-q" name="qty" type="number" min="1" max="100000" required></label>
          <label for="f-e">Expiry<input id="f-e" name="expiry" type="date" required></label>
          <label for="f-f">Fridge<select id="f-f" name="fridge">${opts}</select></label>
          <button class="btn primary" type="submit">${editable ? "Add batch" : "Try to add anyway"}</button>
        </form><div class="error" id="add-error"></div>
      </section>
      <section class="panel"><h2>Batches in storage</h2><div class="table-wrap" id="inv-table"></div></section>
    </div>`);
    $("#add-batch").onsubmit = ev => {
      ev.preventDefault();
      const d = Object.fromEntries(new FormData(ev.target));
      d.qty = Number(d.qty);
      try { call("addBatch", d); toast("Batch added"); ev.target.reset(); $("#add-error").textContent = ""; refreshInventory(); }
      catch (e) { $("#add-error").textContent = e.status === 403 ? `The server refused it (403): ${e.message}` : e.message; }
    };
    refreshInventory();
  }

  function refreshInventory() {
    const wrap = $("#inv-table");
    if (!wrap || wrap.contains(document.activeElement)) return;
    const rows = tryCall("batches") || [];
    const fridges = tryCall("fridges") || [];
    const name = id => (fridges.find(f => f.id === id) || {}).name || id;
    wrap.innerHTML = `<table><thead><tr><th>Batch</th><th class="n">Units</th><th>Fridge</th><th>Expiry</th><th>Status</th><th>Heat budget left</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${rows.map(b => `<tr>
        <td><strong>${esc(b.vaccine)}</strong><div class="muted">Lot ${esc(b.lot)}</div></td>
        <td class="n">${b.qty}</td><td>${esc(name(b.fridge))}</td>
        <td>${esc(b.expiry)}${b.expired ? ` <span class="chip bad">Expired</span>` : ""}</td>
        <td><span class="chip ${b.status}">${WORD[b.status]}</span></td>
        <td style="min-width:150px"><div class="budget"><span class="meter ${b.remainingPct < 20 ? "low" : b.remainingPct < 50 ? "mid" : ""}"><i style="width:${b.remainingPct}%"></i></span><span>${fmt(b.remainingMin, 0)} min</span></div></td>
        <td><div class="row" style="flex-wrap:nowrap">
          ${can("batch.move") && b.status !== "DISCARD" ? `<select data-move="${b.id}" aria-label="Move ${esc(b.vaccine)} to another fridge" style="width:auto"><option value="">Move to…</option>${fridges.filter(f => f.id !== b.fridge).map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}</select>` : ""}
          <button class="btn small" type="button" data-qr="${b.id}">QR code</button>
          ${can("inventory.edit") ? `<button class="btn small danger" type="button" data-remove="${b.id}">Remove</button>` : ""}
        </div></td></tr>`).join("") || `<tr><td colspan="7" class="muted">No batches in storage. Receive one with the form above.</td></tr>`}
      </tbody></table>`;
    $$("[data-move]", wrap).forEach(s => { s.onchange = () => {
      if (!s.value) return;
      const r = tryCall("moveBatch", Number(s.dataset.move), s.value);
      if (r) toast(`Moved to ${r.name}`);
      s.blur(); refreshInventory();
    }; });
    $$("[data-qr]", wrap).forEach(b => { b.onclick = () => showQr(rows.find(x => x.id === Number(b.dataset.qr))); });
    $$("[data-remove]", wrap).forEach(b => { b.onclick = () => removeDialog(rows.find(x => x.id === Number(b.dataset.remove))); });
  }

  function checkUrl(b) {
    const snap = CC.crypto.b64url(JSON.stringify({ v: b.vaccine, l: b.lot, e: b.expiry, s: b.status, t: Math.floor(W.S.now) }));
    return new URL("check.html", location.href).href.split("#")[0] + `#id=${b.publicId}&s=${snap}`;
  }

  function showQr(b) {
    const url = checkUrl(b);
    let img = `<p class="muted">The QR library did not load (no internet?). Use the link below.</p>`;
    if (window.qrcode) {
      const q = window.qrcode(0, "M"); q.addData(url); q.make();
      img = `<img src="${q.createDataURL(5, 2)}" alt="QR code linking to the public check page for lot ${esc(b.lot)}">`;
    }
    const dlg = $("#dialog");
    dlg.innerHTML = `<h2 id="dialog-title">Public check for lot ${esc(b.lot)}</h2>
      <div class="qr">${img}</div>
      <p class="muted" style="margin-top:10px">Anyone can scan this to see the batch status and expiry without logging in.</p>
      <div class="linkbox" id="qr-link">${esc(url)}</div>
      <div class="row" style="margin-top:12px"><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open check page</a>
        <button class="btn" type="button" id="copy-link">Copy link</button><button class="btn primary" type="button" id="close-dlg">Close</button></div>`;
    dlg.showModal();
    $("#close-dlg").onclick = () => dlg.close();
    $("#copy-link").onclick = () => {
      navigator.clipboard?.writeText(url).then(() => toast("Link copied"), () => selectText($("#qr-link")));
      if (!navigator.clipboard) selectText($("#qr-link"));
    };
  }
  function selectText(el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Link selected: press Ctrl+C to copy"); }

  function removeDialog(b) {
    const dlg = $("#dialog");
    dlg.innerHTML = `<h2 id="dialog-title">Remove ${esc(b.vaccine)} lot ${esc(b.lot)}</h2>
      <label for="rm-reason">Why is it leaving storage?<select id="rm-reason">
        <option>Used for vaccination</option><option>Destroyed (discard)</option><option>Transferred to another site</option></select></label>
      <div class="row" style="margin-top:14px"><button class="btn danger" type="button" id="rm-ok">Remove batch</button><button class="btn" type="button" id="rm-cancel">Cancel</button></div>`;
    dlg.showModal();
    $("#rm-cancel").onclick = () => dlg.close();
    $("#rm-ok").onclick = () => { if (tryCall("removeBatch", b.id, $("#rm-reason").value)) toast("Batch removed"); dlg.close(); refreshInventory(); };
  }

  /* ------------------------------------------------------------ logs */
  let logTab = "audit";
  function viewLogs() {
    const sec = can("security.view");
    shell("logs", "Logs and integrity", `<div class="stack">
      <section class="panel"><h2>Verify integrity</h2>
        <p class="muted">Every sensor reading and log entry is chained to the one before it with SHA-256 and sealed with a server key. Verifying recomputes the whole chain and names any record that was edited, deleted or rewritten.</p>
        <div class="row"><button class="btn primary" type="button" id="verify">Verify integrity</button>
          <button class="btn" type="button" id="tamper">Demo: edit a stored reading</button>
          <button class="btn" type="button" id="restore">Undo the edit</button></div>
        <div id="verdict"></div>
      </section>
      <section class="panel">
        <div class="tabs" role="tablist">
          <button class="btn small" type="button" role="tab" data-tab="audit" aria-selected="${logTab === "audit"}">Audit trail</button>
          ${sec ? `<button class="btn small" type="button" role="tab" data-tab="security" aria-selected="${logTab === "security"}">Security events</button>` : ""}
        </div>
        ${sec ? `<div class="row" id="attacks" style="margin-bottom:12px" ${logTab === "security" ? "" : "hidden"}>
          <span class="muted" style="font-size:13px">Send a bad message to Fridge A:</span>
          <button class="btn small" type="button" data-attack="replay">Replay a captured one</button>
          <button class="btn small" type="button" data-attack="tamper">Change its temperature</button>
          <button class="btn small" type="button" data-attack="forge">Sign with a guessed key</button>
          <button class="btn small" type="button" data-attack="stale">Send an old one</button></div>` : ""}
        <div class="table-wrap" id="log-table"></div>
      </section></div>`);
    if (!sec) logTab = "audit";
    $$("[data-tab]").forEach(b => { b.onclick = () => { logTab = b.dataset.tab; viewLogs(); }; });
    $$("[data-attack]").forEach(b => { b.onclick = () => { toast(act[b.dataset.attack]("FRIDGE-A")); refreshLogs(); }; });
    $("#verify").onclick = () => {
      const r = tryCall("verify");
      if (!r) return;
      const names = { readings: "Sensor readings", audit: "Audit trail" };
      $("#verdict").innerHTML = `<div class="verdict ${r.ok ? "ok" : "bad"}">${r.ok ? "Intact: no record has been changed." : "Tampering detected."}</div>
        <ul>${r.chains.map(c => `<li><strong>${names[c.table]}</strong>: ${c.checked} records checked${c.archived ? ` (${c.archived} older ones archived)` : ""}. ${c.ok ? "OK" : c.problems.slice(0, 3).map(p => `Record #${p.id}: ${esc(p.meaning)}`).join("; ")}</li>`).join("")}</ul>`;
      refreshLogs();
    };
    $("#tamper").onclick = () => { const id = act.tamperLog(); toast(id ? `Reading #${id} was edited directly in storage, as an insider might. Now press Verify integrity.` : "Not enough readings yet"); };
    $("#restore").onclick = () => toast(act.restoreLog() ? "Original value put back" : "Nothing to undo");
    refreshLogs();
  }

  // {"fridge":"FRIDGE-A","pred":13.1} -> "fridge FRIDGE-A, pred 13.1"
  function details(json) {
    try { return Object.entries(JSON.parse(json)).map(([k, v]) => `${k.replace(/_/g, " ")} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", "); }
    catch (e) { return json; }
  }

  function refreshLogs() {
    const wrap = $("#log-table");
    if (!wrap) return;
    if (logTab === "security") {
      const ev = tryCall("security") || [];
      wrap.innerHTML = `<table><thead><tr><th>Time</th><th>Device</th><th>Rejected because</th><th>Detail</th></tr></thead><tbody>
        ${ev.map(e => `<tr><td>${stamp(e.ts)}</td><td>${esc(e.dev)}</td><td><span class="chip bad">${esc(e.kind.replace(/_/g, " "))}</span></td><td class="details">${esc(e.detail)}</td></tr>`).join("")
          || `<tr><td colspan="4" class="muted">No rejected messages yet. Use the buttons above to send some.</td></tr>`}</tbody></table>`;
    } else {
      const rows = tryCall("audit") || [];
      wrap.innerHTML = `<table><thead><tr><th class="n">#</th><th>Time</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>
        ${rows.map(e => `<tr><td class="n">${e.id}</td><td>${stamp(e.ts)}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td class="details">${esc(details(e.details))}</td></tr>`).join("")}</tbody></table>`;
    }
  }

  /* ------------------------------------------------------------ AI */
  function viewAI() {
    const m = CC.modelReport;
    shell("ai", "Breach prediction and compressor health", `<div class="stack">
      <div class="grid2" id="ai-fridges"></div>
      <section class="panel"><h2>How the forecast works here</h2>
        <p>Every 30 seconds each fridge's own warming and cooling rates are fitted from its recent readings, then the fridge is run forward 30 minutes with the real compressor rule. The upper bound adds the fit's error. A warning shows when that bound passes 8 °C.</p>
        <p class="muted">The competition backend runs a trained gradient-boosting model instead. A browser has no Python, so this demo uses the physics forecaster. The trained model's results are below.</p>
      </section>
      <section class="panel"><h2>Trained model results (held-out test runs)</h2>
        <div class="table-wrap"><table><thead><tr><th>30-min forecast</th><th class="n">MAE (°C)</th><th class="n">RMSE (°C)</th></tr></thead><tbody>
          <tr><td>Gradient boosting</td><td class="n">${m.regression.model.mae}</td><td class="n">${m.regression.model.rmse}</td></tr>
          <tr><td>No-change baseline</td><td class="n">${m.regression.persistence_baseline.mae}</td><td class="n">${m.regression.persistence_baseline.rmse}</td></tr>
          <tr><td>Linear trend baseline</td><td class="n">${m.regression.linear_trend_baseline.mae}</td><td class="n">${m.regression.linear_trend_baseline.rmse}</td></tr>
        </tbody></table></div>
        <div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Breach warning (above 8 °C in 30 min)</th><th class="n">Precision</th><th class="n">Recall</th><th class="n">F1</th></tr></thead><tbody>
          <tr><td>Upper-bound rule</td><td class="n">${m.warning_T30_above_8C.model_upper.precision}</td><td class="n">${m.warning_T30_above_8C.model_upper.recall}</td><td class="n">${m.warning_T30_above_8C.model_upper.f1}</td></tr>
          <tr><td>Linear trend</td><td class="n">${m.warning_T30_above_8C.linear_trend_baseline.precision}</td><td class="n">${m.warning_T30_above_8C.linear_trend_baseline.recall}</td><td class="n">${m.warning_T30_above_8C.linear_trend_baseline.f1}</td></tr>
        </tbody></table></div>
        <p class="muted" style="margin-top:12px">Dataset: ${m.dataset.runs} simulated fridge-days, ${m.dataset.rows.toLocaleString()} rows; ${esc(m.dataset.test_split)}. Compressor health score error: ${m.health_estimator.mae_points} points across ${m.health_estimator.fridges} fridges with known wear.</p>
        <div class="figs">
          <img src="assets/report/forecast_trace.png" alt="Forecast against measured temperature on a held-out run, including a power failure" loading="lazy">
          <img src="assets/report/pred_vs_actual.png" alt="Predicted against actual temperature 30 minutes ahead" loading="lazy">
          <img src="assets/report/feature_importance.png" alt="Which inputs the forecaster relies on" loading="lazy">
          <img src="assets/report/health_estimator.png" alt="Estimated against true compressor health" loading="lazy">
        </div>
      </section></div>`);
    refreshAI();
  }
  function refreshAI() {
    const el = $("#ai-fridges");
    if (!el) return;
    const fr = tryCall("ai") || [];
    el.innerHTML = fr.map(f => `<section class="panel"><h2>${esc(f.name)}</h2>
      <p>${esc(f.predNote)}</p>
      <dl class="facts" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div><dt>Now</dt><dd>${fmt(f.temp)} °C</dd></div>
        <div><dt>In 30 min</dt><dd>${fmt(f.pred)} °C</dd></div>
        <div><dt>Upper bound</dt><dd>${fmt(f.predUpper)} °C</dd></div>
      </dl>
      <p style="margin-top:12px"><strong>Compressor health:</strong> ${f.health === null ? esc(f.healthNote) : `${Math.round(f.health)} / 100, ${esc(f.healthNote)}`}</p>
      <p class="muted" style="font-size:13px">Lower the compressor strength slider on the dashboard to watch this score fall.</p></section>`).join("");
  }

  /* ------------------------------------------------------------ admin */
  let resetArmed = false;
  function viewAdmin() {
    shell("admin", "Administration", `<div class="stack">
      <section class="panel"><h2>Fridges</h2><div class="table-wrap" id="adm-fridges"></div></section>
      <section class="panel"><h2>Users</h2>
        <form id="add-user" class="form-row">
          <label for="nu">Username<input id="nu" name="username" required minlength="3" maxlength="32"></label>
          <label for="np">Password<input id="np" name="password" type="password" required minlength="8"></label>
          <label for="nr">Role<select id="nr" name="role"><option value="pharmacist">Pharmacist</option><option value="inspector">Inspector</option><option value="admin">Admin</option></select></label>
          <button class="btn primary" type="submit">Add user</button></form>
        <div class="error" id="user-error"></div>
        <div class="table-wrap" id="adm-users"></div>
      </section>
      <section class="panel"><h2>Demo</h2>
        <p class="muted">Everything here lives in this browser only. Starting over clears it and rebuilds 100 minutes of history.</p>
        <button class="btn danger" type="button" id="reset-demo">Start the demo over</button></section>
    </div>`);
    $("#add-user").onsubmit = ev => {
      ev.preventDefault();
      const d = Object.fromEntries(new FormData(ev.target));
      try { call("addUser", d.username, d.password, d.role); toast("User added"); ev.target.reset(); $("#user-error").textContent = ""; refreshAdmin(); }
      catch (e) { $("#user-error").textContent = e.message; }
    };
    $("#reset-demo").onclick = ev => {
      if (!resetArmed) { resetArmed = true; ev.target.textContent = "Click again to clear everything"; setTimeout(() => { resetArmed = false; if ($("#reset-demo")) $("#reset-demo").textContent = "Start the demo over"; }, 4000); return; }
      resetArmed = false; act.reset(); logout("The demo was reset. Log in again.");
    };
    refreshAdmin();
  }
  function refreshAdmin() {
    const d = tryCall("dashboard"), users = tryCall("users");
    if (!d || !users || !$("#adm-fridges")) return;
    $("#adm-fridges").innerHTML = `<table><thead><tr><th>Fridge</th><th>Red LED</th><th class="n">Accepted</th><th class="n">Duplicates</th><th class="n">Rejected</th><th></th></tr></thead><tbody>
      ${d.fridges.map(f => `<tr><td><strong>${esc(f.name)}</strong></td><td>${f.ledLatch ? `<span class="chip DISCARD">Latched</span>` : `<span class="chip off">Off</span>`}</td>
        <td class="n">${f.device.accepted}</td><td class="n">${f.device.duplicates}</td><td class="n">${f.device.rejected}</td>
        <td><button class="btn small" type="button" data-reset="${f.id}" ${f.ledLatch ? "" : "disabled"}>Reset discard LED</button></td></tr>`).join("")}</tbody></table>`;
    $("#adm-users").innerHTML = `<table><thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${u.active ? "Active" : "Disabled"}</td>
        <td><button class="btn small" type="button" data-user="${u.id}" data-active="${u.active}">${u.active ? "Disable" : "Enable"}</button></td></tr>`).join("")}</tbody></table>`;
    $$("[data-reset]").forEach(b => { b.onclick = () => { if (tryCall("resetLed", b.dataset.reset)) toast("Discard LED cleared. The node switches it off on its next report."); refreshAdmin(); }; });
    $$("[data-user]").forEach(b => { b.onclick = () => { tryCall("setUserActive", Number(b.dataset.user), b.dataset.active !== "true"); refreshAdmin(); }; });
  }

  /* ------------------------------------------------------------ router + live updates */
  const VIEWS = { dashboard: [viewDashboard, refreshDashboard, "dashboard.view"], inventory: [viewInventory, refreshInventory, "inventory.view"],
    logs: [viewLogs, refreshLogs, "logs.view"], ai: [viewAI, refreshAI, "ai.view"], admin: [viewAdmin, refreshAdmin, "users.manage"] };

  function route() {
    if (!token) return renderLogin();
    try { user = W.api.me(token); } catch (e) { return logout(); }
    let v = location.hash.replace("#", "") || "dashboard";
    if (!VIEWS[v] || !can(VIEWS[v][2])) v = "dashboard";
    view = v;
    VIEWS[v][0]();
    window.scrollTo(0, 0);
  }

  let tick = 0;
  function onWorldChange() {
    // toast new alerts, then refresh the page's live parts
    const evs = W.S.events.splice(0);
    if (!user) return;
    evs.filter(e => e.type === "alert" && e.alert.severity !== "info").slice(-3)
      .forEach(e => toast(e.alert.message, e.alert.severity === "critical" ? "critical" : ""));
    const t = $("#simtime"); if (t) t.textContent = clock(W.S.now);
    tick++;
    if (view === "dashboard") refreshDashboard();
    else if (view === "logs" && tick % 3 === 0) refreshLogs();
    else if (view === "inventory" && tick % 3 === 0) refreshInventory();
    else if (view === "ai") refreshAI();
    else if (view === "admin" && tick % 3 === 0 && !$("main").contains(document.activeElement)) refreshAdmin();
  }

  CC.sim.init();
  CC.sim.onChange(onWorldChange);
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => { if (view === "dashboard") refreshDashboard(); });
  route();
})();
