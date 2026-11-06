/* ColdChain web demo — the backend, running inside the browser.
 *
 * GitHub Pages can only host static files, so this file plays the part of the
 * FastAPI server from the main project with the same rules:
 *   - device messages: HMAC-SHA256 + timestamp + nonce, rejected and logged when invalid
 *   - per-boot sequence numbers + ACKs: in order, no duplicates
 *   - readings and audit trail in SHA-256 hash chains sealed with a server key
 *   - heat-exposure budget per batch (x2 above 12 °C, At Risk < 20 %, Discard at 0 %)
 *   - roles checked on every API call (signed JWT, permissions table)
 * State is kept in this browser's localStorage, so every visitor gets their own demo.
 */
"use strict";
window.CC = window.CC || {};

(function () {
  const { sha256, hmac, safeEqual, randomHex, b64url, unb64url, canonical } = CC.crypto;
  const CFG = CC.CFG;
  const GENESIS = "0".repeat(64);
  const BUDGET_MIN = 60, AT_RISK = 0.20;

  const PERMS = {
    "dashboard.view": ["admin", "pharmacist", "inspector"],
    "inventory.view": ["admin", "pharmacist", "inspector"],
    "inventory.edit": ["admin", "pharmacist"],
    "batch.move": ["admin", "pharmacist"],
    "relocation.confirm": ["admin", "pharmacist"],
    "alert.ack": ["admin", "pharmacist"],
    "logs.view": ["admin", "pharmacist", "inspector"],
    "logs.verify": ["admin", "pharmacist", "inspector"],
    "security.view": ["admin", "inspector"],
    "ai.view": ["admin", "pharmacist", "inspector"],
    "device.reset_led": ["admin"],
    "users.manage": ["admin"],
    "demo.control": ["admin", "pharmacist", "inspector"],
  };
  const can = (role, p) => (PERMS[p] || []).includes(role);
  const permsFor = role => Object.keys(PERMS).filter(p => can(role, p));

  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  /* ------------------------------------------------------------ hash chains */
  const CHAIN_FIELDS = {
    readings: ["dev", "fridge", "boot", "seq", "ts", "temp", "door", "comp", "power", "batt", "state", "reason", "led", "buffered", "recv"],
    audit: ["ts", "actor", "action", "details"],
  };
  function chainAppend(S, table, rec) {
    const list = S[table];
    const prev = list.length ? list[list.length - 1].hash : S.anchors[table];
    const core = {};
    CHAIN_FIELDS[table].forEach(f => { core[f] = rec[f] ?? null; });
    const hash = sha256(prev + canonical(core));
    const row = Object.assign({ id: ++S.ids[table] }, core, { prev, hash, seal: hmac(S.sealKey, hash) });
    list.push(row);
    return row;
  }
  function chainVerify(S, table) {
    let prev = S.anchors[table];
    const problems = [];
    for (const row of S[table]) {
      const core = {};
      CHAIN_FIELDS[table].forEach(f => { core[f] = row[f] ?? null; });
      if (row.prev !== prev) problems.push({ id: row.id, problem: "broken_link", meaning: "a record before this one was deleted, inserted or reordered" });
      const h = sha256(row.prev + canonical(core));
      if (h !== row.hash) problems.push({ id: row.id, problem: "content_mismatch", meaning: "this record was edited after it was written" });
      else if (!safeEqual(hmac(S.sealKey, h), row.seal)) problems.push({ id: row.id, problem: "bad_seal", meaning: "the chain was rebuilt without the server key" });
      prev = row.hash;
      if (problems.length >= 20) break;
    }
    return { table, checked: S[table].length, archived: S.archived[table], ok: !problems.length, problems };
  }
  // Keep localStorage small: archive the oldest rows but keep the chain checkable from an anchor
  function prune(S, table, max, keep) {
    if (S[table].length <= max) return;
    const cut = S[table].length - keep;
    S.anchors[table] = S[table][cut - 1].hash;
    S.archived[table] += cut;
    S[table] = S[table].slice(cut);
  }

  function audit(S, actor, action, details) {
    chainAppend(S, "audit", { ts: S.now, actor, action, details: canonical(details || {}) });
  }

  /* ------------------------------------------------------------ alerts */
  const NOTIFY = new Set(["door_alarm", "breach", "discard", "at_risk", "power_lost", "predicted_breach", "relocation_suggested", "device_offline", "compressor_weak"]);
  function alert(S, fridge, kind, severity, message, cooldown) {
    if (cooldown) {
      const last = [...S.alerts].reverse().find(a => a.kind === kind && a.fridge === fridge);
      if (last && S.now - last.ts < cooldown) return null;
    }
    const a = { id: ++S.ids.alerts, ts: S.now, fridge, kind, severity, message, notify: NOTIFY.has(kind), ack: null };
    S.alerts.push(a);
    if (S.alerts.length > 300) S.alerts = S.alerts.slice(-250);
    S.events.push({ type: "alert", alert: a });
    return a;
  }

  /* ------------------------------------------------------------ heat budget */
  const weight = t => (t > 12 ? 2 : t > 8 ? 1 : 0);
  function statusFor(exp) {
    const rem = Math.max(0, BUDGET_MIN - exp);
    if (rem <= 1e-9) return "DISCARD";
    if (rem / BUDGET_MIN < AT_RISK) return "AT_RISK";
    return "SAFE";
  }
  const remainingPct = exp => Math.round(Math.max(0, BUDGET_MIN - exp) / BUDGET_MIN * 1000) / 10;

  function overlap(S, batchId, fridge, a, b) {
    const moves = S.moves.filter(m => m.batch === batchId);
    let total = 0;
    moves.forEach((m, i) => {
      if (m.to !== fridge) return;
      const end = i + 1 < moves.length ? moves[i + 1].ts : Infinity;
      const lo = Math.max(a, m.ts), hi = Math.min(b, end);
      if (hi > lo) total += hi - lo;
    });
    return total;
  }

  function integrate(S, fid, ts, temp) {
    const f = S.fridges[fid];
    if (temp === null) temp = f.procTemp;
    if (f.procTs === null || f.procTemp === null) { f.procTs = ts; f.procTemp = temp; return; }
    if (ts <= f.procTs) return;
    const w = weight(Math.max(f.procTemp, temp));
    if (w) {
      const ids = new Set(S.moves.filter(m => m.to === fid || m.from === fid).map(m => m.batch));
      for (const b of S.batches) {
        if (!b.active || !ids.has(b.id)) continue;
        const secs = overlap(S, b.id, fid, f.procTs, ts);
        if (secs <= 0) continue;
        const old = b.status;
        b.exposure += w * secs / 60;
        b.status = old === "DISCARD" ? "DISCARD" : statusFor(b.exposure);
        if (b.status !== old) {
          audit(S, "system", `batch.status.${b.status.toLowerCase()}`, { batch: b.id, lot: b.lot, exposure_min: +b.exposure.toFixed(2) });
          if (b.status === "AT_RISK") alert(S, fid, "at_risk", "warning", `${b.vaccine} lot ${b.lot} is at risk: ${remainingPct(b.exposure)}% of its heat budget left`);
          if (b.status === "DISCARD") {
            b.discardedAt = ts;
            f.ledLatch = true;
            alert(S, fid, "discard", "critical", `${b.vaccine} lot ${b.lot} must be discarded: heat budget used up. Red LED latched on ${f.name}`);
          }
        }
      }
    }
    f.procTs = ts; f.procTemp = temp;
  }

  /* ------------------------------------------------------------ device messages */
  function command(S, dev, body) {
    return CC.signEnvelope(dev, S.devices[dev].key, Math.floor(S.now), JSON.stringify(body));
  }

  function reject(S, dev, kind, detail) {
    S.security.push({ ts: S.now, dev, kind, detail: detail || "" });
    if (S.security.length > 200) S.security = S.security.slice(-150);
    if (S.devices[dev]) S.devices[dev].rejected++;
    audit(S, `device:${dev || "unknown"}`, `security.reject.${kind}`, { detail: detail || kind });
    S.events.push({ type: "security", kind, dev });
    return [];
  }

  // Returns the signed replies (ACK, LED command) for the device
  function ingest(S, topicDev, payload) {
    let env;
    try { env = JSON.parse(payload); } catch (e) { return reject(S, topicDev, "bad_json"); }
    const { dev, ts, nonce, body, sig } = env || {};
    if (typeof dev !== "string" || !Number.isInteger(ts) || typeof nonce !== "string" || typeof body !== "string" || typeof sig !== "string")
      return reject(S, topicDev, "malformed");
    if (dev !== topicDev) return reject(S, topicDev, "topic_mismatch", `envelope says ${dev}`);
    const d = S.devices[dev];
    if (!d) return reject(S, topicDev, "unknown_device", dev);
    const skew = S.now - ts;
    if (skew > CFG.TS_WINDOW_S) return reject(S, dev, "stale_timestamp", `${Math.round(skew)} s old`);
    if (skew < -CFG.TS_WINDOW_S) return reject(S, dev, "future_timestamp", `${Math.round(-skew)} s ahead`);
    if (!safeEqual(hmac(d.key, `${dev}|${ts}|${nonce}|${body}`), sig)) return reject(S, dev, "bad_signature");
    S.nonces[dev] = S.nonces[dev] || {};
    if (S.nonces[dev][nonce] !== undefined) return reject(S, dev, "replayed_nonce");
    S.nonces[dev][nonce] = S.now;
    let r;
    try { r = JSON.parse(body); } catch (e) { return reject(S, dev, "bad_body"); }

    const out = [];
    // order and de-duplicate within one boot of the node
    if (d.boot !== r.boot) {
      if (d.boot) audit(S, `device:${dev}`, "device.reboot", { old: d.boot, new: r.boot });
      d.boot = r.boot; d.lastSeq = 0;
    }
    if (r.seq <= d.lastSeq) {
      d.duplicates++;
      out.push(command(S, dev, { cmd: "ack", boot: r.boot, seq: d.lastSeq }));
      return out;
    }
    if (d.lastSeq > 0 && r.seq > d.lastSeq + 1) {
      d.gaps++;
      audit(S, `device:${dev}`, "device.sequence_gap", { expected: d.lastSeq + 1, got: r.seq });
    }
    const fid = d.fridge, f = S.fridges[fid];
    const buffered = S.now - r.t > 15 ? 1 : 0;
    chainAppend(S, "readings", { dev, fridge: fid, boot: r.boot, seq: r.seq, ts: r.t, temp: r.temp, door: r.door, comp: r.comp,
      power: r.power, batt: r.batt, state: r.state, reason: r.reason, led: r.led, buffered, recv: Math.floor(S.now) });
    d.lastSeq = r.seq; d.accepted++;

    // live state (newest reading only) and alerts on state changes
    const late = buffered ? " (reported late from the offline buffer)" : "";
    if (f.stateTs === null || r.t >= f.stateTs) {
      if (r.state === "BREACH" && f.state !== "BREACH") {
        f.breachSince = r.t;
        alert(S, fid, "breach", "critical", `${f.name} is at ${r.temp.toFixed(1)} °C, outside 2–8 °C${late}`, 600);
      }
      if (r.state !== "BREACH") f.breachSince = null;
      if (r.power === "BATTERY" && f.power !== "BATTERY") {
        alert(S, fid, "power_lost", "critical", `${f.name} lost mains power and is running on battery (${r.batt}%)${late}`, 60);
        audit(S, `device:${dev}`, "power.lost", { batt: r.batt });
      } else if (r.power === "MAINS" && f.power === "BATTERY") {
        alert(S, fid, "power_restored", "info", `${f.name} mains power restored${late}`);
        audit(S, `device:${dev}`, "power.restored", {});
      }
      f.doorOpenSince = r.door ? (f.door && f.doorOpenSince ? f.doorOpenSince : r.t) : null;
      Object.assign(f, { stateTs: r.t, temp: r.temp, state: r.state, door: r.door, comp: r.comp, power: r.power,
        batt: r.batt, ledReported: r.led, backlog: r.backlog || 0 });
    }
    if (!f.online) audit(S, `device:${dev}`, "device.online", {});
    f.online = true; f.lastSeen = S.now;
    if (r.reason === "door_alarm") {
      const ep = f.doorOpenSince || r.t;
      if (f.doorAlertFor !== ep) {
        f.doorAlertFor = ep;
        alert(S, fid, "door_alarm", "critical", `${f.name} door has been open for more than 60 s${late}`);
        audit(S, `device:${dev}`, "door.alarm", { since: ep });
      }
    }
    integrate(S, fid, r.t, r.temp);
    // keep the node's red LED in step with the server (self-healing latch)
    if (!buffered && !!r.led !== !!f.ledLatch && S.now - (f.lastLedCmd || 0) > 10) {
      f.lastLedCmd = S.now;
      out.push(command(S, dev, { cmd: "led_latch", on: !!f.ledLatch }));
    }
    out.push(command(S, dev, { cmd: "ack", boot: r.boot, seq: r.seq }));
    return out;
  }

  // Server-side safety nets (same as ingest.watchdog in the backend)
  function watchdog(S) {
    for (const f of Object.values(S.fridges)) {
      if (f.online && f.lastSeen && S.now - f.lastSeen > 20) {
        f.online = false;
        audit(S, "system", "device.offline", { fridge: f.id });
        alert(S, f.id, "device_offline", "warning", `${f.name} has not reported for ${Math.round(S.now - f.lastSeen)} s. The node keeps buffering readings.`);
      }
      if (f.online && f.door && f.doorOpenSince && S.now - f.doorOpenSince > 60 && f.doorAlertFor !== f.doorOpenSince) {
        f.doorAlertFor = f.doorOpenSince;
        alert(S, f.id, "door_alarm", "critical", `${f.name} door has been open for more than 60 s (server watchdog)`);
      }
    }
    for (const dev of Object.keys(S.nonces)) {
      for (const [n, t] of Object.entries(S.nonces[dev])) if (S.now - t > 2 * CFG.TS_WINDOW_S) delete S.nonces[dev][n];
    }
    prune(S, "readings", 4200, 3000);
    prune(S, "audit", 1600, 1200);
  }

  /* ------------------------------------------------------------ auth (JWT) */
  function hashPw(salt, pw) { return sha256(salt + ":" + pw); }   // demo only; the real server uses bcrypt (cost 12)
  function issueToken(S, u) {
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ sub: u.id, usr: u.username, role: u.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 8 * 3600 }));
    const sig = b64url(hmac(S.jwtSecret, `${head}.${body}`));
    return `${head}.${body}.${sig}`;
  }
  function verifyToken(S, token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) throw new ApiError(401, "Not logged in");
    if (!safeEqual(b64url(hmac(S.jwtSecret, `${parts[0]}.${parts[1]}`)), parts[2])) throw new ApiError(401, "Session is not valid");
    const claims = JSON.parse(unb64url(parts[1]));
    if (claims.exp < Date.now() / 1000) throw new ApiError(401, "Session expired");
    const u = S.users.find(x => x.id === claims.sub);
    if (!u || !u.active) throw new ApiError(401, "Account disabled");
    return u;
  }

  /* ------------------------------------------------------------ public API (what the browser UI calls) */
  function makeApi(S) {
    const guard = (token, perm) => {
      const u = verifyToken(S, token);
      if (!can(u.role, perm)) throw new ApiError(403, `Your role (${u.role}) cannot do this`);
      return u;
    };
    const actor = u => `user:${u.username}`;
    const fridgeName = id => (S.fridges[id] ? S.fridges[id].name : id);
    const batchView = b => Object.assign({}, b, { remainingPct: remainingPct(b.exposure), remainingMin: Math.max(0, BUDGET_MIN - b.exposure),
      expired: b.expiry < new Date(S.now * 1000).toISOString().slice(0, 10) });
    const used = fid => S.batches.filter(b => b.active && b.fridge === fid && b.status !== "DISCARD").reduce((a, b) => a + b.qty, 0);

    function moveBatch(u, b, to, reason) {
      if (b.status === "DISCARD") throw new ApiError(409, "Discarded batches cannot be moved; they must be destroyed");
      if (b.fridge === to) throw new ApiError(400, "The batch is already in that fridge");
      const f = S.fridges[to];
      if (!f) throw new ApiError(400, "Unknown fridge");
      if (f.capacity - used(to) < b.qty) throw new ApiError(409, `${f.name} does not have room for ${b.qty} units`);
      S.moves.push({ batch: b.id, from: b.fridge, to, ts: S.now, by: actor(u), reason });
      audit(S, actor(u), "batch.moved", { batch: b.id, from: b.fridge, to, reason });
      b.fridge = to;
    }

    return {
      login(username, password) {
        const u = S.users.find(x => x.username === String(username).trim() && x.active);
        if (!u || !safeEqual(hashPw(u.salt, password), u.hash)) {
          audit(S, `user:${username}`, "auth.failed", {});
          throw new ApiError(401, "Wrong username or password");
        }
        audit(S, actor(u), "auth.login", { role: u.role });
        return { token: issueToken(S, u), user: { id: u.id, username: u.username, role: u.role, permissions: permsFor(u.role) } };
      },
      me: token => { const u = verifyToken(S, token); return { id: u.id, username: u.username, role: u.role, permissions: permsFor(u.role) }; },

      dashboard(token) {
        guard(token, "dashboard.view");
        const batches = S.batches.filter(b => b.active).map(batchView);
        const fridges = Object.values(S.fridges).map(f => Object.assign({}, f, {
          batches: batches.filter(b => b.fridge === f.id).sort((a, b) => b.exposure - a.exposure),
          unitsUsed: used(f.id),
          doorOpenS: f.door && f.doorOpenSince ? Math.max(0, Math.round(S.now - f.doorOpenSince)) : 0,
          device: S.devices[f.device],
        }));
        const summary = { SAFE: 0, AT_RISK: 0, DISCARD: 0 };
        batches.forEach(b => { summary[b.status]++; });
        return { now: S.now, fridges, summary, alerts: S.alerts.slice(-12).reverse(),
          relocations: S.relocations.filter(r => r.status === "PENDING").reverse() };
      },
      history(token, fid, minutes) {
        guard(token, "dashboard.view");
        const from = S.now - minutes * 60;
        return {
          readings: S.readings.filter(r => r.fridge === fid && r.ts >= from).map(r => ({ ts: r.ts, temp: r.temp, door: r.door })),
          predictions: (S.predictions[fid] || []).filter(p => p.ts >= from),
        };
      },

      batches(token) { guard(token, "inventory.view"); return S.batches.filter(b => b.active).map(batchView).sort((a, b) => b.id - a.id); },
      fridges(token) { guard(token, "inventory.view"); return Object.values(S.fridges).map(f => ({ id: f.id, name: f.name, free: f.capacity - used(f.id) })); },
      addBatch(token, d) {
        const u = guard(token, "inventory.edit");
        const vaccine = String(d.vaccine || "").trim(), lot = String(d.lot || "").trim(), qty = Number(d.qty), expiry = String(d.expiry || "");
        if (!vaccine || vaccine.length > 80 || !lot || lot.length > 40) throw new ApiError(400, "Enter the product name and lot number");
        if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new ApiError(400, "Units must be a whole number from 1 to 100000");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new ApiError(400, "Choose an expiry date");
        const f = S.fridges[d.fridge];
        if (!f) throw new ApiError(400, "Choose a fridge");
        if (f.capacity - used(f.id) < qty) throw new ApiError(409, `${f.name} does not have room for ${qty} units`);
        const b = { id: ++S.ids.batches, publicId: randomHex(6), vaccine, lot, qty, expiry, fridge: f.id, exposure: 0, status: "SAFE", discardedAt: null, active: true };
        S.batches.push(b);
        S.moves.push({ batch: b.id, from: null, to: f.id, ts: S.now, by: actor(u), reason: "received" });
        audit(S, actor(u), "batch.created", { batch: b.id, vaccine, lot, qty, expiry, fridge: f.id });
        return b;
      },
      moveBatch(token, id, to) {
        const u = guard(token, "batch.move");
        const b = S.batches.find(x => x.id === id && x.active);
        if (!b) throw new ApiError(404, "Batch not found");
        moveBatch(u, b, to, "manual move");
        return { ok: true, name: fridgeName(to) };
      },
      removeBatch(token, id, reason) {
        const u = guard(token, "inventory.edit");
        const b = S.batches.find(x => x.id === id && x.active);
        if (!b) throw new ApiError(404, "Batch not found");
        b.active = false;
        S.moves.push({ batch: b.id, from: b.fridge, to: null, ts: S.now, by: actor(u), reason });
        audit(S, actor(u), "batch.removed", { batch: b.id, reason, status: b.status });
        return { ok: true };
      },
      publicBatch(publicId) {   // no token: public QR check
        const b = S.batches.find(x => x.publicId === publicId);
        if (!b) return null;
        const v = batchView(b);
        return { vaccine: b.vaccine, lot: b.lot, expiry: b.expiry, status: b.status, expired: v.expired, checked: S.now };
      },

      ackAlert(token, id) {
        const u = guard(token, "alert.ack");
        const a = S.alerts.find(x => x.id === id);
        if (!a) throw new ApiError(404, "Alert not found");
        if (!a.ack) { a.ack = u.username; audit(S, actor(u), "alert.acknowledged", { alert: id, kind: a.kind }); }
        return { ok: true };
      },
      confirmRelocation(token, id) {
        const u = guard(token, "relocation.confirm");
        const r = S.relocations.find(x => x.id === id);
        if (!r) throw new ApiError(404, "Suggestion not found");
        if (r.status !== "PENDING") throw new ApiError(409, `This suggestion is already ${r.status.toLowerCase()}`);
        const applied = [], skipped = [];
        for (const m of r.plan.moves) {
          const b = S.batches.find(x => x.id === m.batch && x.active);
          try {
            if (!b || b.fridge !== r.plan.source) throw new ApiError(409, "no longer in the source fridge");
            moveBatch(u, b, m.to, `AI relocation #${id}`);
            applied.push(m);
          } catch (e) { skipped.push(Object.assign({}, m, { why: e.message })); }
        }
        r.status = "CONFIRMED"; r.decidedBy = u.username;
        audit(S, actor(u), "relocation.confirmed", { id, applied: applied.length, skipped: skipped.length });
        return { applied, skipped };
      },
      dismissRelocation(token, id) {
        const u = guard(token, "relocation.confirm");
        const r = S.relocations.find(x => x.id === id);
        if (!r || r.status !== "PENDING") throw new ApiError(409, "Nothing to dismiss");
        r.status = "DISMISSED"; r.decidedBy = u.username;
        audit(S, actor(u), "relocation.dismissed", { id });
        return { ok: true };
      },

      audit(token) { guard(token, "logs.view"); return S.audit.slice(-200).reverse(); },
      security(token) { guard(token, "security.view"); return S.security.slice().reverse(); },
      verify(token) {
        const u = guard(token, "logs.verify");
        const res = [chainVerify(S, "readings"), chainVerify(S, "audit")];
        const ok = res.every(r => r.ok);
        audit(S, actor(u), "integrity.verified", { ok, readings: res[0].checked, audit: res[1].checked });
        return { ok, chains: res };
      },

      ai(token) { guard(token, "ai.view"); return Object.values(S.fridges); },
      resetLed(token, fid) {
        const u = guard(token, "device.reset_led");
        const f = S.fridges[fid];
        if (!f) throw new ApiError(404, "Unknown fridge");
        const was = f.ledLatch;
        f.ledLatch = false; f.lastLedCmd = 0;
        audit(S, actor(u), "device.discard_led_reset", { fridge: fid, was_latched: was });
        return { ok: true };
      },
      users(token) { guard(token, "users.manage"); return S.users.map(u => ({ id: u.id, username: u.username, role: u.role, active: u.active })); },
      setUserActive(token, id, active) {
        const u = guard(token, "users.manage");
        const t = S.users.find(x => x.id === id);
        if (!t) throw new ApiError(404, "User not found");
        if (t.role === "admin" && !active && S.users.filter(x => x.role === "admin" && x.active).length <= 1)
          throw new ApiError(400, "You cannot disable the last admin");
        t.active = active;
        audit(S, actor(u), "user.updated", { user: t.username, active });
        return { ok: true };
      },
      addUser(token, username, password, role) {
        const u = guard(token, "users.manage");
        username = String(username || "").trim();
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new ApiError(400, "Username: 3–32 letters, digits, dot, dash or underscore");
        if (S.users.some(x => x.username === username)) throw new ApiError(409, "That username is taken");
        if (String(password).length < 8) throw new ApiError(400, "Password must be at least 8 characters");
        if (!["admin", "pharmacist", "inspector"].includes(role)) throw new ApiError(400, "Choose a role");
        const salt = randomHex(8);
        S.users.push({ id: ++S.ids.users, username, role, salt, hash: hashPw(salt, password), active: true });
        audit(S, actor(u), "user.created", { username, role });
        return { ok: true };
      },
      security_view_allowed: token => { try { guard(token, "security.view"); return true; } catch (e) { return false; } },
    };
  }

  /* ------------------------------------------------------------ fresh state */
  function freshState(now) {
    const S = {
      version: 3, now, events: [],
      jwtSecret: randomHex(24), sealKey: randomHex(24),
      ids: { readings: 0, audit: 0, alerts: 0, batches: 0, users: 0, relocations: 0 },
      anchors: { readings: GENESIS, audit: GENESIS }, archived: { readings: 0, audit: 0 },
      readings: [], audit: [], security: [], alerts: [], batches: [], moves: [], relocations: [], predictions: {}, nonces: {},
      devices: {}, fridges: {}, users: [],
    };
    for (const [id, name] of [["FRIDGE-A", "Fridge A"], ["FRIDGE-B", "Fridge B"]]) {
      S.devices[id] = { key: randomHex(24), fridge: id, boot: null, lastSeq: 0, accepted: 0, duplicates: 0, gaps: 0, rejected: 0 };
      S.fridges[id] = { id, name, device: id, capacity: 500, online: false, lastSeen: null, stateTs: null, temp: null, state: null,
        door: 0, doorOpenSince: null, doorAlertFor: null, comp: 0, power: "MAINS", batt: 100, ledLatch: false, ledReported: 0,
        backlog: 0, breachSince: null, procTs: null, procTemp: null, lastLedCmd: 0,
        pred: null, predUpper: null, predWarn: false, predNote: "Collecting 30 minutes of data", health: null, healthBase: null, healthNote: "Learning" };
      audit(S, "system", "device.registered", { device: id });
    }
    for (const [username, pw, role] of [["admin", "Admin@123", "admin"], ["pharmacist", "Pharma@123", "pharmacist"], ["inspector", "Inspect@123", "inspector"]]) {
      const salt = randomHex(8);
      S.users.push({ id: ++S.ids.users, username, role, salt, hash: hashPw(salt, pw), active: true });
    }
    return S;
  }

  CC.server = { freshState, makeApi, ingest, watchdog, audit, alert, chainVerify, ApiError, can, statusFor, remainingPct, BUDGET_MIN };
})();
