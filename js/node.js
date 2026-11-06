/* ColdChain web demo — simulated fridge hardware.
 *
 * CC.Fridge : physics of one fridge (Newton cooling + door leak + compressor),
 *             the same model as ml/physics.py in the main project.
 * CC.Node   : a twin of firmware/fridge_node — same rules and protocol:
 *             compressor ON at 7 °C / OFF at 3 °C with a 60 s minimum off-time,
 *             publish every 5 s and on door changes, 60-min outbox with ACKs,
 *             door alarm after 60 s, power-fail button, signed messages.
 */
"use strict";
window.CC = window.CC || {};

(function () {
  const { hmac, safeEqual, randomHex } = CC.crypto;

  const CFG = {
    T_ON: 7.0, T_OFF: 3.0, MIN_OFF_S: 60,
    PUBLISH_S: 5, DOOR_ALARM_S: 60,
    OUTBOX: 720,          // 720 x 5 s = 60 min (brief asks for >= 30 min)
    SEND_WINDOW: 40, ACK_TIMEOUT_S: 8, TS_WINDOW_S: 120,
  };
  CC.CFG = CFG;

  // Small seeded random generator so a reset demo replays the same way
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  function classify(t) {
    if (t === null || t === undefined || Number.isNaN(t)) return "FAULT";
    if (t > 8 || t < 2) return "BREACH";
    if (t >= 7 || t < 3) return "WARNING";
    return "SAFE";
  }
  CC.classify = classify;

  /* ------------------------------------------------------------ physics */
  class Fridge {
    constructor(p) {
      this.p = Object.assign({ ambient: 30, kLeak: 0.010, kDoor: 0.12, coolRate: 0.9, health: 1.0, noise: 0.03 }, p.params);
      this.temp = p.temp ?? 5;      // air temperature
      this.sensed = p.sensed ?? this.temp;  // probe lags the air (~30 s)
      this.seed = p.seed ?? 1;
      this.r = rng(this.seed + Math.floor(this.temp * 1000));
    }
    step(dt, comp, door) {
      const p = this.p;
      let dTdt = p.kLeak * (p.ambient - this.temp);
      if (door) dTdt += p.kDoor * (p.ambient - this.temp);
      if (comp) dTdt -= p.coolRate * p.health * Math.max(0.6, 1 - 0.012 * (p.ambient - 25));
      this.temp += dTdt * dt / 60;
      this.sensed += (this.temp - this.sensed) * dt / (30 + dt);
    }
    measure() {   // DS18B20: 0.0625 °C steps plus a little noise
      return Math.round((this.sensed + gauss(this.r) * this.p.noise) / 0.0625) * 0.0625;
    }
    toJSON() { return { params: this.p, temp: this.temp, sensed: this.sensed, seed: this.seed }; }
  }

  /* ------------------------------------------------------------ firmware twin */
  class Node {
    constructor(o) {
      this.dev = o.dev;
      this.key = o.key;
      this.fridge = new Fridge(o.fridge || {});
      this.boot = o.boot || randomHex(4);
      this.seq = o.seq || 0;
      this.outbox = o.outbox || [];
      this.dropped = o.dropped || 0;
      this.sendIdx = 0;
      this.lastAckProgress = o.lastAckProgress || 0;
      this.wifi = o.wifi ?? true;
      this.mains = o.mains ?? true;
      this.door = o.door ?? false;
      this.doorSince = o.doorSince ?? null;
      this.doorAlarm = o.doorAlarm ?? false;
      this.comp = o.comp ?? false;
      this.compOffSince = o.compOffSince ?? -1e12;
      this.ledLatch = o.ledLatch ?? false;      // stored in flash on the real node
      this.override = o.override ?? null;       // "warm the probe" control
      this.batt = o.batt ?? 100;
      this.battTick = o.battTick || 0;
      this.lastPub = o.lastPub ?? -1e12;
      this.temp = o.temp ?? null;
      this.rejected = o.rejected || 0;
      this.seen = o.seen || [];
      this.sent = o.sent || [];   // last few sent envelopes (used by the attack demo)
      if (!o.outbox) this.push("boot", o.now || 0);
    }

    // ---------------- what a person does to the fridge
    setDoor(open, now) {
      if (open === this.door) return;
      this.door = open;
      if (open) { this.doorSince = now; this.push("door", now); }
      else {
        const was = this.doorAlarm;
        this.doorAlarm = false; this.doorSince = null;
        this.push(was ? "door_closed_after_alarm" : "door", now);
      }
    }
    togglePower(now) { this.mains = !this.mains; this.push("power", now); }
    setWifi(up, now) {
      if (up && !this.wifi) { this.sendIdx = 0; this.lastAckProgress = now; }
      this.wifi = up;
    }

    // ---------------- firmware loop (dt seconds of simulated time)
    tick(dt, now) {
      this.fridge.step(dt, this.comp, this.door);
      const t = this.override !== null ? this.override : this.fridge.measure();
      this.temp = t;
      // Compressor rule (control.cpp): runs on mains only
      if (!this.mains) { if (this.comp) { this.comp = false; this.compOffSince = now; } }
      else if (this.comp && t <= CFG.T_OFF) { this.comp = false; this.compOffSince = now; }
      else if (!this.comp && t >= CFG.T_ON && now - this.compOffSince >= CFG.MIN_OFF_S) this.comp = true;
      // Door alarm (buzzer on the node, alert on the server)
      if (this.door && !this.doorAlarm && this.doorSince !== null && now - this.doorSince > CFG.DOOR_ALARM_S) {
        this.doorAlarm = true;
        this.push("door_alarm", now);
      }
      // Simulated battery: about 1 h on battery, slow recharge on mains
      if (now - this.battTick >= (this.mains ? 30 : 36)) {
        this.battTick = now;
        this.batt = Math.max(0, Math.min(100, this.batt + (this.mains ? 1 : -1)));
      }
      if (now - this.lastPub >= CFG.PUBLISH_S) { this.lastPub = now; this.push("periodic", now); }
    }

    push(reason, now) {
      this.seq += 1;
      const t = this.temp ?? this.fridge.measure();
      const r = {
        seq: this.seq, boot: this.boot, t: Math.floor(now), temp: Math.round(t * 100) / 100,
        door: this.door ? 1 : 0, comp: this.comp ? 1 : 0, power: this.mains ? "MAINS" : "BATTERY",
        batt: this.batt, state: classify(t), reason, led: this.ledLatch ? 1 : 0,
      };
      if (this.outbox.length >= CFG.OUTBOX) { this.outbox.shift(); this.dropped++; this.sendIdx = Math.max(0, this.sendIdx - 1); }
      this.outbox.push(r);
    }

    // ---------------- network side: signed envelopes, oldest first
    outgoing(now, maxN) {
      if (!this.wifi) return [];
      if (this.sendIdx > 0 && now - this.lastAckProgress > CFG.ACK_TIMEOUT_S) { this.sendIdx = 0; this.lastAckProgress = now; }
      const out = [];
      while (this.sendIdx < this.outbox.length && this.sendIdx < CFG.SEND_WINDOW && out.length < maxN) {
        if (this.sendIdx === 0) this.lastAckProgress = now;
        const body = JSON.stringify(Object.assign({}, this.outbox[this.sendIdx],
          { backlog: this.outbox.length, drop: this.dropped, rej: this.rejected }));
        out.push(signEnvelope(this.dev, this.key, Math.floor(now), body));
        this.sendIdx++;
      }
      if (out.length) { this.sent.push(out[out.length - 1]); if (this.sent.length > 3) this.sent.shift(); }
      return out;
    }

    // Verify a command from the server exactly like protocol.cpp verifyEnvelope()
    receive(payload, now) {
      let env;
      try { env = JSON.parse(payload); } catch (e) { this.rejected++; return "bad_json"; }
      if (env.dev !== this.dev) { this.rejected++; return "wrong_device"; }
      if (Math.abs(now - env.ts) > CFG.TS_WINDOW_S) { this.rejected++; return "stale_timestamp"; }
      const sig = hmac(this.key, `${env.dev}|${env.ts}|${env.nonce}|${env.body}`);
      if (!safeEqual(sig, env.sig)) { this.rejected++; return "bad_signature"; }
      if (this.seen.includes(env.nonce)) { this.rejected++; return "replayed_nonce"; }
      this.seen.push(env.nonce); if (this.seen.length > 32) this.seen.shift();
      const cmd = JSON.parse(env.body);
      if (cmd.cmd === "ack" && cmd.boot === this.boot) {
        let removed = 0;
        while (this.outbox.length && this.outbox[0].seq <= cmd.seq) { this.outbox.shift(); removed++; }
        this.sendIdx = Math.max(0, this.sendIdx - removed);
        if (removed) this.lastAckProgress = now;
      } else if (cmd.cmd === "led_latch") {
        this.ledLatch = !!cmd.on;
      }
      return "ok";
    }

    // What the 0.96" OLED shows
    oled() {
      const st = classify(this.temp);
      const link = this.outbox.length > 1 ? (this.wifi ? `SYNC ${this.outbox.length}` : `BUF ${this.outbox.length}`)
        : (this.wifi ? "ONLINE" : "OFFLINE");
      return {
        dev: this.dev, link, temp: this.temp, state: this.ledLatch ? "DISCARD" : st,
        door: this.door ? (this.doorAlarm ? "DOOR!" : "Open") : "Shut",
        comp: this.comp ? "C:ON" : "C:off", power: this.mains ? "AC" : "BAT", batt: this.batt,
        leds: { green: st === "SAFE" && !this.ledLatch, yellow: st === "WARNING" || st === "FAULT", red: this.ledLatch || st === "BREACH" },
        buzzer: this.doorAlarm,
      };
    }

    toJSON() {
      const o = {};
      for (const k of ["dev", "key", "boot", "seq", "outbox", "dropped", "lastAckProgress", "wifi", "mains", "door",
        "doorSince", "doorAlarm", "comp", "compOffSince", "ledLatch", "override", "batt", "battTick", "lastPub",
        "temp", "rejected", "seen", "sent"]) o[k] = this[k];
      o.fridge = this.fridge.toJSON();
      return o;
    }
  }

  function signEnvelope(dev, key, ts, body) {
    const nonce = randomHex(16);
    return JSON.stringify({ dev, ts, nonce, body, sig: hmac(key, `${dev}|${ts}|${nonce}|${body}`) });
  }

  CC.Fridge = Fridge;
  CC.Node = Node;
  CC.signEnvelope = signEnvelope;
})();
