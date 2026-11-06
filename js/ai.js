/* ColdChain web demo — AI breach prediction, compressor health and relocation.
 *
 * Runs every 30 s of simulated time, like backend/app/engine.py.
 *  - Forecast: fits this fridge's own warming and cooling rates from its recent
 *    readings, then rolls the fridge forward 30 minutes with the real compressor
 *    rule. The upper bound adds the fit's error, so "may exceed 8 °C" is a warning
 *    rather than a certainty. (The FastAPI backend runs the trained
 *    gradient-boosting model; a browser demo has no Python, so it uses this
 *    physics-based forecaster with the same inputs.)
 *  - Health: compressor capacity = warming rate with it OFF minus cooling rate
 *    with it ON, compared with the fridge's own first measurement (0–100).
 *  - Relocation: if a fridge may become unsafe, move its batches (least budget
 *    left first) to a safe fridge with room; a pharmacist confirms with one click.
 */
"use strict";
window.CC = window.CC || {};

(function () {
  const LIMIT = 8;

  // Readings -> one value per minute (forward-filled gaps)
  function minutes(rows) {
    if (!rows.length) return [];
    const m0 = Math.floor(rows[0].ts / 60), m1 = Math.floor(rows[rows.length - 1].ts / 60);
    const bins = Array.from({ length: m1 - m0 + 1 }, () => ({ t: 0, n: 0, comp: 0, door: 0, cnt: 0, mains: 1 }));
    for (const r of rows) {
      const b = bins[Math.floor(r.ts / 60) - m0];
      if (r.temp !== null) { b.t += r.temp; b.n++; }
      b.comp += r.comp; b.door += r.door; b.cnt++;
      if (r.power === "BATTERY") b.mains = 0;
    }
    let last = null;
    return bins.map(b => {
      const out = b.cnt ? { temp: b.n ? b.t / b.n : last?.temp, comp: b.comp / b.cnt, door: b.door / b.cnt, mains: b.mains } : Object.assign({}, last);
      if (out.temp !== undefined && out.temp !== null) last = out;
      return out;
    }).filter(x => x.temp !== undefined && x.temp !== null);
  }

  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  // Learn leak (k), room temperature (Ta) and cooling power (c) from clean minutes
  function fit(M) {
    const off = [], on = [];
    // Skip the first two minutes after the compressor switches: the probe still lags behind the air
    const steady = (j, test) => j >= 2 && test(M[j - 2].comp) && test(M[j - 1].comp) && test(M[j].comp) && test(M[j + 1].comp);
    const isOff = c => c <= 0.01, isOn = c => c >= 0.99;
    for (let j = 0; j < M.length - 1; j++) {
      const a = M[j], b = M[j + 1];
      if (a.door > 0 || b.door > 0 || M[j - 1]?.door > 0 || a.temp < 1 || a.temp > 15) continue;
      const d = b.temp - a.temp;
      if (steady(j, isOff)) off.push([a.temp, d]);
      else if (steady(j, isOn) && a.mains && b.mains) on.push([a.temp, d]);
    }
    let k = 0.010, Ta = 30;
    if (off.length >= 8) {
      const n = off.length, mx = off.reduce((s, p) => s + p[0], 0) / n, my = off.reduce((s, p) => s + p[1], 0) / n;
      let sxy = 0, sxx = 0;
      off.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
      const slope = sxx > 1e-6 ? sxy / sxx : 0;
      if (slope < -0.002) { k = Math.min(0.05, -slope); Ta = Math.max(15, Math.min(45, mx + my / k)); }
      else { k = Math.max(0.004, my / Math.max(1, 30 - mx)); }
    }
    const c = on.length >= 4 ? Math.max(0.05, median(on.map(([x, y]) => k * (Ta - x) - y))) : 0.7;
    const resid = off.map(([x, y]) => y - k * (Ta - x));
    const sd = resid.length ? Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / resid.length) : 0.08;
    // Health uses only steady minutes inside 2–8.5 °C, like backend/app/ai/health.py
    const offH = off.filter(p => p[0] >= 2 && p[0] <= 8.5), onH = on.filter(p => p[0] >= 2 && p[0] <= 8.5);
    const capacity = offH.length >= 8 && onH.length >= 8 ? Math.max(0, median(offH.map(p => p[1])) - median(onH.map(p => p[1]))) : null;
    return { k, Ta, c, sd, capacity, nOff: off.length, nOn: on.length };
  }

  function forecast(M, f) {
    if (M.length < 30) return { ok: false, note: `Collecting data (${M.length} of 30 minutes)` };
    const p = fit(M);
    const last = M[M.length - 1];
    let T = last.temp, comp = last.comp >= 0.5, offFor = comp ? 0 : 120, peak = T;
    const mains = f.power !== "BATTERY";
    for (let s = 0; s < 180; s++) {   // 30 min in 10 s steps
      if (!mains) comp = false;
      else if (comp && T <= 3) { comp = false; offFor = 0; }
      else if (!comp && T >= 7 && offFor >= 60) comp = true;
      if (!comp) offFor += 10;
      T += (p.k * (p.Ta - T) - (comp ? p.c : 0)) * 10 / 60;
      peak = Math.max(peak, T);
    }
    // Upper bound: the warmest point of the rollout plus the fit's error over 30 min
    // (about the 80th percentile), plus extra while the door is open right now.
    const margin = Math.min(1.2, 1.28 * p.sd * Math.sqrt(30)) + (f.door ? 1.2 : 0);
    const pred = Math.round(T * 10) / 10;
    const upper = Math.round((Math.max(pred, peak) + margin) * 10) / 10;
    const warn = upper > LIMIT;
    const note = pred > LIMIT ? `Likely above 8 °C in 30 min (forecast ${pred.toFixed(1)} °C)`
      : warn ? `May exceed 8 °C in the next 30 min (upper bound ${upper.toFixed(1)} °C)`
      : `Expected ${pred.toFixed(1)} °C in 30 min`;
    return { ok: true, pred, upper, warn, note, fit: p };
  }

  function healthNote(s) {
    if (s >= 80) return "Healthy";
    if (s >= 60) return "Slight wear: schedule a check";
    if (s >= 40) return "Weakening: service soon";
    return "Failing: move stock and service now";
  }

  function riskReasons(f) {
    const r = [];
    if (f.state === "BREACH" && f.breachSince && f.stateTs - f.breachSince >= 300)
      r.push(`out of range for ${Math.floor((f.stateTs - f.breachSince) / 60)} min, now ${f.temp.toFixed(1)} °C`);
    if (f.predWarn && f.pred > 8) r.push(`forecast ${f.pred.toFixed(1)} °C in 30 min`);
    if (f.power === "BATTERY") r.push("on battery, so the compressor cannot run");
    if (f.health !== null && f.health < 40) r.push(`compressor health ${Math.round(f.health)}/100`);
    return r;
  }

  function plan(S, src) {
    const reasons = riskReasons(src);
    if (!reasons.length) return null;
    const batches = S.batches.filter(b => b.active && b.fridge === src.id && b.status !== "DISCARD")
      .sort((a, b) => (a.exposure === b.exposure ? a.expiry.localeCompare(b.expiry) : b.exposure - a.exposure));
    if (!batches.length) return null;
    const used = fid => S.batches.filter(b => b.active && b.fridge === fid && b.status !== "DISCARD").reduce((a, b) => a + b.qty, 0);
    const targets = Object.values(S.fridges).filter(f => f.id !== src.id && f.online && f.power === "MAINS" && !riskReasons(f).length
      && (f.predUpper === null || f.predUpper <= 7.5) && (f.health === null || f.health >= 50));
    const free = Object.fromEntries(targets.map(f => [f.id, f.capacity - used(f.id)]));
    const moves = [], unplaced = [];
    for (const b of batches) {
      const item = { batch: b.id, vaccine: b.vaccine, lot: b.lot, qty: b.qty, remaining: CC.server.remainingPct(b.exposure) };
      const t = targets.find(x => free[x.id] >= b.qty);
      if (t) { free[t.id] -= b.qty; moves.push(Object.assign(item, { to: t.id, toName: t.name })); }
      else unplaced.push(item);
    }
    return { source: src.id, sourceName: src.name, reasons, moves, unplaced,
      advice: moves.length ? "Move the listed batches now, most urgent first." : "No safe fridge has room. Use a validated cold box with ice packs and call the supervisor." };
  }

  function cycle(S) {
    const { alert, audit } = CC.server;
    for (const f of Object.values(S.fridges)) {
      const rows = S.readings.filter(r => r.fridge === f.id && r.ts >= S.now - 6 * 3600);
      if (!rows.length || S.now - rows[rows.length - 1].ts > 120) {
        f.predNote = f.online ? "Collecting data" : "No recent data from the node";
        f.predWarn = false;
        continue;
      }
      const M = minutes(rows);
      const fc = forecast(M, f);
      const wasWarn = f.predWarn;
      if (fc.ok) {
        Object.assign(f, { pred: fc.pred, predUpper: fc.upper, predWarn: fc.warn, predNote: fc.note });
        (S.predictions[f.id] = S.predictions[f.id] || []).push({ ts: S.now + 1800, pred: fc.pred, upper: fc.upper });
        if (S.predictions[f.id].length > 400) S.predictions[f.id].shift();
        if (fc.warn && !wasWarn) {
          alert(S, f.id, "predicted_breach", "warning", `${f.name}: ${fc.note}`, 900);
          audit(S, "ai", "ai.predicted_breach", { fridge: f.id, pred: fc.pred, upper: fc.upper });
        }
        const cap = fc.fit.capacity;
        if (cap !== null && cap > 0) {
          if (f.healthBase === null) { f.healthBase = cap; audit(S, "ai", "ai.health_calibrated", { fridge: f.id }); }
          const before = f.health;
          // smooth the score so one odd cycle does not swing it
          const raw = Math.max(0, Math.min(100, cap / f.healthBase * 100));
          f.health = before === null ? raw : Math.round((before * 0.7 + raw * 0.3) * 10) / 10;
          f.healthNote = healthNote(f.health);
          if (before !== null && before >= 50 && f.health < 50) {
            alert(S, f.id, "compressor_weak", "warning", `${f.name} compressor health dropped to ${Math.round(f.health)}/100`, 3600);
          }
        } else if (f.health === null) {
          f.healthNote = `Learning (${fc.fit.nOn} of 8 cooling minutes)`;
        }
      } else {
        f.predNote = fc.note; f.predWarn = false;
      }
    }
    for (const f of Object.values(S.fridges)) {
      const pending = S.relocations.find(r => r.source === f.id && r.status === "PENDING");
      const p = plan(S, f);
      if (p) {
        if (pending) { pending.plan = p; pending.updated = S.now; }
        else {
          const r = { id: ++S.ids.relocations, created: S.now, updated: S.now, source: f.id, plan: p, status: "PENDING" };
          S.relocations.push(r);
          audit(S, "ai", "relocation.suggested", { id: r.id, moves: p.moves.length });
          alert(S, f.id, "relocation_suggested", "warning",
            `${f.name} may become unsafe (${p.reasons[0]}). Suggested: move ${p.moves.length} batch${p.moves.length === 1 ? "" : "es"}. A pharmacist must confirm.`);
        }
      } else if (pending && S.now - pending.created >= 120) {
        pending.status = "EXPIRED";
        audit(S, "ai", "relocation.expired", { id: pending.id });
      }
    }
  }

  CC.ai = { cycle, forecast, minutes, riskReasons };
})();
