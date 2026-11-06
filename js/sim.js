/* ColdChain web demo — the simulated world.
 * Owns the two fridge nodes and the in-browser server, moves time forward,
 * delivers messages over the "network", saves the demo to localStorage and
 * provides the demo actions (door, power, Wi-Fi, warm probe, attacks, tamper).
 */
"use strict";
window.CC = window.CC || {};

(function () {
  const KEY = "coldchain-demo-v3";
  const { server } = CC;
  const W = { S: null, nodes: {}, api: null, speed: 10, lastAi: 0, listeners: [] };

  const FRIDGE_SETUP = {
    "FRIDGE-A": { params: { ambient: 31, kLeak: 0.012, kDoor: 0.12, coolRate: 0.85, health: 1 }, temp: 5.2, seed: 11 },
    "FRIDGE-B": { params: { ambient: 30, kLeak: 0.009, kDoor: 0.12, coolRate: 0.9, health: 1 }, temp: 4.6, seed: 23 },
  };
  const SEED_BATCHES = [
    ["BCG", "BCG-2611-A", 60, "2027-03-31", "FRIDGE-A", 0],
    ["Pentavalent (DTP-HepB-Hib)", "PV-2609-14", 80, "2027-08-15", "FRIDGE-A", 6],
    ["Insulin Glargine", "INS-GL-551", 40, "2027-01-20", "FRIDGE-A", 44],
    ["Measles-Rubella", "MR-2610-03", 50, "2027-05-30", "FRIDGE-B", 2],
    ["Hepatitis B", "HB-2607-22", 70, "2027-11-10", "FRIDGE-B", 0],
    ["Insulin Aspart", "INS-AS-208", 30, "2026-12-15", "FRIDGE-B", 0],
  ];

  function emit() { W.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

  /* ------------------------------------------------------------ network */
  function deliver(node, maxN) {
    const replies = [];
    for (const env of node.outgoing(W.S.now, maxN)) {
      for (const r of server.ingest(W.S, node.dev, env)) replies.push(r);
    }
    replies.forEach(r => node.receive(r, W.S.now));
  }

  // Advance simulated time by `secs` in 1 s physics steps
  function advance(secs) {
    const S = W.S;
    for (let i = 0; i < secs; i++) {
      S.now += 1;
      for (const n of Object.values(W.nodes)) n.tick(1, S.now);
      for (const n of Object.values(W.nodes)) deliver(n, 25);
      if (S.now % 5 === 0) server.watchdog(S);
      if (S.now - W.lastAi >= 30) { W.lastAi = S.now; CC.ai.cycle(S); }
    }
  }

  /* ------------------------------------------------------------ setup / persistence */
  function create() {
    const now = Math.floor(Date.now() / 1000) - 100 * 60;   // start 100 min ago, then fast-forward to now
    W.S = server.freshState(now);
    W.nodes = {};
    for (const [dev, cfg] of Object.entries(FRIDGE_SETUP)) {
      W.nodes[dev] = new CC.Node({ dev, key: W.S.devices[dev].key, fridge: cfg, now });
    }
    W.api = server.makeApi(W.S);
    // receive the demo stock (as the pharmacist would on day one)
    const admin = W.api.login("admin", "Admin@123").token;
    for (const [vaccine, lot, qty, expiry, fridge, exposure] of SEED_BATCHES) {
      const b = W.api.addBatch(admin, { vaccine, lot, qty, expiry, fridge });
      b.exposure = exposure;   // some stock has seen heat before (e.g. during delivery)
      b.status = server.statusFor(exposure);
    }
    W.lastAi = now;
    // 100 minutes of history so charts and the AI have data, with one door opening on B
    for (let m = 0; m < 100; m++) {
      if (m === 42) W.nodes["FRIDGE-B"].setDoor(true, W.S.now);
      if (m === 43) W.nodes["FRIDGE-B"].setDoor(false, W.S.now);
      advance(60);
    }
    W.S.events = [];
    W.S.alerts.forEach(a => { a.ack = "history"; });
    save();
  }

  function save() {
    try {
      const data = { S: Object.assign({}, W.S, { events: [] }), nodes: Object.fromEntries(Object.entries(W.nodes).map(([k, n]) => [k, n.toJSON()])),
        speed: W.speed, lastAi: W.lastAi };
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) { /* private window or full storage: the demo still runs, it just won't survive a reload */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d.S || d.S.version !== 3) return false;
      W.S = d.S; W.speed = d.speed || 10; W.lastAi = d.lastAi || d.S.now;
      W.nodes = {};
      for (const [k, n] of Object.entries(d.nodes)) W.nodes[k] = new CC.Node(n);
      W.api = server.makeApi(W.S);
      // catch up on the time the tab was closed (capped at 20 minutes, at 1x)
      const gap = Math.min(1200, Math.max(0, Math.floor(Date.now() / 1000) - W.S.now));
      if (gap > 0 && W.S.now < Date.now() / 1000) advance(gap);
      return true;
    } catch (e) { return false; }
  }

  function init() {
    if (!load()) create();
    let acc = 0, lastReal = performance.now(), lastSave = 0, lastEmit = 0;
    setInterval(() => {
      const t = performance.now();
      acc += (t - lastReal) / 1000 * W.speed;
      lastReal = t;
      const step = Math.min(600, Math.floor(acc));
      if (step >= 1) { acc -= step; advance(step); }
      if (t - lastEmit > 900) { lastEmit = t; emit(); }
      if (t - lastSave > 8000) { lastSave = t; save(); }
    }, 250);
    window.addEventListener("pagehide", save);
  }

  /* ------------------------------------------------------------ demo actions */
  const act = {
    door(dev, open) { W.nodes[dev].setDoor(open, W.S.now); emit(); },
    power(dev) { W.nodes[dev].togglePower(W.S.now); emit(); },
    wifi(dev, up) { W.nodes[dev].setWifi(up, W.S.now); emit(); },
    wear(dev, health) { W.nodes[dev].fridge.p.health = health; emit(); },
    setSpeed(x) { W.speed = x; save(); emit(); },
    reset() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } create(); emit(); },

    // A captured genuine message sent again: rejected as replayed
    replay(dev) {
      const env = W.nodes[dev].sent[W.nodes[dev].sent.length - 1];
      if (!env) return "Wait a few seconds for the node to send a message first";
      server.ingest(W.S, dev, env); emit();
      return "Replayed a captured message: rejected as replayed_nonce";
    },
    // Attacker changes the temperature in a captured message: signature no longer matches
    tamper(dev) {
      const env = JSON.parse(W.nodes[dev].sent[W.nodes[dev].sent.length - 1] || "null");
      if (!env) return "Wait a few seconds for the node to send a message first";
      const body = JSON.parse(env.body);
      body.temp = 4.0; body.state = "SAFE"; body.seq += 1000;
      env.body = JSON.stringify(body); env.nonce = CC.crypto.randomHex(16); env.ts = Math.floor(W.S.now);
      server.ingest(W.S, dev, JSON.stringify(env)); emit();
      return "Sent a message with the temperature changed: rejected as bad_signature";
    },
    // Message signed with a guessed key
    forge(dev) {
      const body = JSON.stringify({ seq: 999999, boot: "evil", t: Math.floor(W.S.now), temp: 4, door: 0, comp: 0, power: "MAINS", batt: 100, state: "SAFE", reason: "periodic", led: 0 });
      server.ingest(W.S, dev, CC.signEnvelope(dev, "guessed-key", Math.floor(W.S.now), body)); emit();
      return "Sent a message signed with a guessed key: rejected as bad_signature";
    },
    stale(dev) {
      const body = JSON.stringify({ seq: 999998, boot: "evil", t: Math.floor(W.S.now) - 900, temp: 4, door: 0, comp: 0, power: "MAINS", batt: 100, state: "SAFE", reason: "periodic", led: 0 });
      server.ingest(W.S, dev, CC.signEnvelope(dev, W.S.devices[dev].key, Math.floor(W.S.now) - 900, body)); emit();
      return "Sent a 15-minute-old message: rejected as stale_timestamp";
    },
    // An insider edits a stored reading directly in the database
    tamperLog() {
      const rows = W.S.readings;
      if (rows.length < 30) return null;
      const row = rows[rows.length - 25];
      W.S.tampered = { id: row.id, temp: row.temp };
      row.temp = Math.round((row.temp - 3) * 100) / 100;
      emit();
      return row.id;
    },
    restoreLog() {
      const t = W.S.tampered;
      if (!t) return false;
      const row = W.S.readings.find(r => r.id === t.id);
      if (row) row.temp = t.temp;
      W.S.tampered = null; emit();
      return true;
    },
  };

  CC.world = W;
  CC.sim = { init, act, onChange: fn => W.listeners.push(fn), save };
})();
