/* Public QR check (no login).
 * The link carries the batch id and a snapshot of its status: #id=<public id>&s=<snapshot>.
 * If this browser also runs the demo, the live status is read from it instead.
 * (In the FastAPI version the page asks the server for the live status by id.)
 */
"use strict";
(function () {
  const card = document.getElementById("card");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const id = params.get("id") || "";
  let data = null, source = "";

  // 1. live status, if this browser runs the demo
  try {
    const raw = localStorage.getItem("coldchain-demo-v3");
    if (raw && /^[0-9a-f]{12}$/.test(id)) {
      const S = JSON.parse(raw).S;
      const b = S.batches.find(x => x.publicId === id);
      if (b) { data = { v: b.vaccine, l: b.lot, e: b.expiry, s: b.status, t: S.now }; source = "live"; }
    }
  } catch (e) { /* storage blocked: fall back to the snapshot */ }

  // 2. otherwise the snapshot printed into the QR code
  if (!data && params.get("s")) {
    try { data = JSON.parse(CC.crypto.unb64url(params.get("s"))); source = "snapshot"; } catch (e) { data = null; }
  }

  if (!data || !data.v || !["SAFE", "AT_RISK", "DISCARD"].includes(data.s)) {
    card.innerHTML = `<div class="band MISSING"><div class="big">Not found</div><p>This code does not match a batch. Ask the pharmacist to print a new label.</p></div>`;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const expired = data.e < today;
  const key = expired ? "EXPIRED" : data.s;
  const word = expired ? "Expired" : { SAFE: "Safe", AT_RISK: "At risk", DISCARD: "Discard" }[data.s];
  const advice = expired ? "This batch is past its expiry date. Do not use it."
    : { SAFE: "Stored within 2–8 °C limits. Fine to use before expiry.",
        AT_RISK: "It has used most of its heat allowance. Ask the pharmacist before use.",
        DISCARD: "It was exposed to too much heat. Do not use it." }[data.s];
  const when = new Date(data.t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  card.innerHTML = `<div class="band ${key}"><div class="big">${esc(word)}</div><p>${esc(advice)}</p></div>
    <dl>
      <dt>Product</dt><dd>${esc(data.v)}</dd>
      <dt>Lot</dt><dd>${esc(data.l)}</dd>
      <dt>Expiry</dt><dd>${esc(new Date(data.e + "T00:00:00").toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }))}</dd>
    </dl>
    <footer>${source === "live" ? `Live status as of ${esc(when)}.` : `Status when this code was printed: ${esc(when)}.`} ColdChain storage monitor.</footer>`;
  document.title = `${word}: ${data.v}`;
})();
