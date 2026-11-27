api/order.js

// Vercel serverless function: receives an order from the website and sends it
// to the owner by email (Resend) and WhatsApp (CallMeBot). Prices are re-checked
// here so a customer cannot change them in the browser.

const CATALOG = {
  "Chorus Mirror": 999,
  "Polo Mirror": 1149,
  "Mister Mirror": 999,
  "Prego ABS Bath Set": 2599,
  "Mister 5-Piece Bath Set": 999,
  "Polo 7-Piece Bath Set": 1249,
  "Marachi Center Push Flush Tank": 1949,
  "Side Push Flush Tank": 1699,
  "Porta Seat Cover": 1499,
  "Hand Shower Chrome": 895,
  "Flower Hand Shower": 849,
  "Hand Shower Colour (Plastic)": 699,
};

const hits = new Map(); // best-effort rate limit per IP
const money = (n) => "Rs. " + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function fail(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 5) return fail(res, 429, "Too many orders, please try again later");
  recent.push(now);
  hits.set(ip, recent);

  const b = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  if (b.website) return res.status(200).json({ ok: true, id: "PG-OK" }); // honeypot: pretend success

  const name = clean(b.cname, 80);
  const city = clean(b.city, 60);
  const addr = clean(b.addr, 300);
  const notes = clean(b.notes, 300);
  let phone = String(b.phone || "").replace(/\D/g, "");
  if (phone.startsWith("92")) phone = "0" + phone.slice(2);
  if (name.length < 2 || city.length < 2 || addr.length < 8 || !/^03\d{9}$/.test(phone))
    return fail(res, 400, "Please check your details");

  const items = [];
  let total = 0;
  let pieces = 0;
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 20) : []) {
    const price = CATALOG[it && it.n];
    const q = Math.floor(Number(it && it.q));
    if (!price || !(q >= 1 && q <= 50)) return fail(res, 400, "Invalid cart");
    items.push({ n: it.n, q, line: price * q });
    total += price * q;
    pieces += q;
  }
  if (!items.length) return fail(res, 400, "Cart is empty");

  const d = new Date();
  const id =
    "PG-" + d.toISOString().slice(2, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

  const lines = items.map((i) => `- ${i.n} x${i.q} = ${money(i.line)}`);
  const text =
    `*New order ${id} - PG Plastics Industry*\n` +
    `Name: ${name}\nPhone: ${phone}\nCity: ${city}\nAddress: ${addr}\n\n` +
    `Items:\n${lines.join("\n")}\nPieces: ${pieces}\nItems total: ${money(total)}\n` +
    `Payment: Cash on Delivery (COD)\nDelivery charges: to be confirmed` +
    (notes ? `\nNotes: ${notes}` : "");

  // last-resort copy of every order in the Vercel function logs
  console.log("ORDER", JSON.stringify({ id, name, phone, city, addr, notes, items, total }));

  const [mail, wa] = await Promise.allSettled([
    sendEmail(id, text, items, { name, phone, city, addr, notes, total, pieces }),
    sendWhatsApp(text),
  ]);
  if (mail.status === "rejected") console.error("EMAIL FAILED", mail.reason && mail.reason.message);
  if (wa.status === "rejected") console.error("WHATSAPP FAILED", wa.reason && wa.reason.message);

  if (mail.status === "rejected" && wa.status === "rejected") return fail(res, 502, "Could not deliver order");
  return res.status(200).json({ ok: true, id });
};

async function sendEmail(id, text, items, o) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const rows = items
    .map(
      (i) =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${esc(i.n)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${i.q}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">${money(i.line)}</td></tr>`
    )
    .join("");
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<h2 style="color:#8A5E43">New order ${esc(id)}</h2>` +
    `<p><b>Name:</b> ${esc(o.name)}<br><b>Phone:</b> <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a><br><b>City:</b> ${esc(o.city)}<br><b>Address:</b> ${esc(o.addr)}</p>` +
    `<table style="border-collapse:collapse;width:100%"><tr style="background:#FCEBDD"><th style="padding:6px 12px;text-align:left">Item</th><th>Qty</th><th style="text-align:right;padding:6px 12px">Amount</th></tr>${rows}</table>` +
    `<p><b>Items total: ${money(o.total)}</b> (${o.pieces} pieces)<br>Payment: Cash on Delivery. Delivery charges: to be confirmed.</p>` +
    (o.notes ? `<p><b>Notes:</b> ${esc(o.notes)}</p>` : "") +
    `</div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ORDER_EMAIL_FROM || "PG Plastics Orders <onboarding@resend.dev>",
      to: [process.env.ORDER_EMAIL_TO || "essa94732@gmail.com"],
      subject: `New order ${id} - ${o.name} - ${money(o.total)}`,
      html,
      text: text.replace(/\*/g, ""),
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("Resend " + r.status + " " + (await r.text()).slice(0, 200));
}

async function sendWhatsApp(text) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) throw new Error("CALLMEBOT_PHONE / CALLMEBOT_APIKEY missing");
  const url =
    "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(phone) +
    "&apikey=" + encodeURIComponent(apikey) + "&text=" + encodeURIComponent(text);
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("CallMeBot " + r.status);
}
