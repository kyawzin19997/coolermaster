"use strict";

const BLOCK = 512 * 1024;
const MAX_FILE = 300 * 1024 * 1024;
const $ = (selector) => document.querySelector(selector);
const status = $("#status");
const code = $("#code");
const picker = $("#picker");
const files = $("#files");
const drop = $("#drop");
const queue = [];
const hex = (numbers) => Array.from(numbers, (n) => n.toString(16).padStart(2, "0")).join("");
const get = (key) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const put = (key, value) => { try { sessionStorage.setItem(key, value); } catch {} };
const client = get("masterdeck-client") || hex(crypto.getRandomValues(new Uint8Array(16)));
put("masterdeck-client", client);
const token = location.hash.slice(1);
let ticket = token ? "" : get("masterdeck-ticket") || "";
let approved = false;
let sending = false;
let permanent = false;

async function request(path, method = "GET", content, credential = ticket, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 12_000);
  try {
    const result = await fetch(path, { method, body: content, headers: { Authorization: `Bearer ${credential}` }, cache: "no-store", redirect: "error", signal: controller.signal });
    const value = await result.json().catch(() => null);
    if (!result.ok) throw Object.assign(new Error(value?.error || "The desktop rejected this request."), { status: result.status });
    if (!value) throw new Error("The desktop did not return an upload response.");
    return value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function heartbeat() {
  if (permanent) return;
  try {
    if (!ticket) {
      if (!/^[a-f0-9]{64}$/.test(token)) throw Object.assign(new Error("Scan the QR code in MasterDeck to start."), { status: 410 });
      const pair = await request("/pair", "POST", JSON.stringify(client), token);
      ticket = pair.ticket;
      put("masterdeck-ticket", ticket);
      history.replaceState(null, "", location.pathname);
    }
    const phone = await request("/status");
    if (phone.status === "denied") throw Object.assign(new Error("Pairing was declined. Open a new upload session on your desktop."), { status: 410 });
    code.hidden = phone.status !== "pending";
    code.textContent = phone.status === "pending" ? phone.code : "";
    approved = phone.status === "approved";
    picker.hidden = !approved;
    status.textContent = approved ? phone.mode === "internet" ? "Connected over HTTPS" : "Connected over local Wi-Fi" : "Match this code and approve on your desktop";
    if (approved) {
      for (const entry of queue) if (entry.state === "cancelled") void cancel(entry);
      void sendNext();
    }
  } catch (error) {
    approved = false;
    if ([401, 409, 410].includes(error.status)) {
      permanent = true;
      picker.hidden = true;
      code.hidden = true;
      status.textContent = error.message;
    } else status.textContent = "Connection interrupted. Reconnecting…";
  }
  if (!permanent) setTimeout(heartbeat, 1800);
}

function makeRow(file) {
  const row = document.createElement("li");
  const name = document.createElement("strong");
  name.textContent = file.name;
  const progress = document.createElement("progress");
  progress.max = Math.max(1, file.size);
  progress.value = 0;
  progress.setAttribute("aria-label", `Progress for ${file.name}`);
  const line = document.createElement("div");
  line.className = "row";
  const detail = document.createElement("span");
  detail.className = "detail";
  detail.textContent = "Waiting";
  const button = document.createElement("button");
  button.textContent = "Cancel";
  const entry = { file, progress, detail, button, controller: new AbortController(), state: "waiting", digest: "", serverId: "" };
  button.onclick = () => {
    if (entry.state === "failed") {
      entry.state = "waiting";
      entry.controller = new AbortController();
      button.textContent = "Cancel";
      button.className = "";
      void sendNext();
    } else {
      entry.state = "cancelled";
      entry.controller.abort();
      button.hidden = true;
      detail.textContent = "Cancelled";
      void cancel(entry);
    }
  };
  line.append(detail, button);
  row.append(name, progress, line);
  $("#queue").append(row);
  return entry;
}

function add(list) {
  if (!approved) return;
  for (const file of list) {
    const row = makeRow(file);
    if (!file.size || file.size > MAX_FILE) {
      row.state = "cancelled";
      row.detail.textContent = "Choose a nonempty file below 300 MB.";
      row.button.hidden = true;
    } else queue.push(row);
  }
  void sendNext();
}

async function cancel(entry) {
  if (!entry.serverId || !approved) return;
  try { await request(`/files/${entry.serverId}`, "DELETE"); entry.serverId = ""; }
  catch (error) { if (error.status === 409 || error.status === 404) entry.serverId = ""; }
}

function progress(entry, result) {
  entry.progress.value = result.bytes;
  const percent = Math.floor(result.bytes * 100 / entry.file.size);
  const speed = result.speed > 1024 * 1024 ? `${(result.speed / (1024 * 1024)).toFixed(1)} MB/s` : `${Math.round(result.speed / 1024)} KB/s`;
  entry.detail.textContent = result.complete ? "Received and verified" : `${percent}% · ${speed}`;
}

async function sendNext() {
  if (sending || !approved) return;
  const entry = queue.find((item) => item.state === "waiting");
  if (!entry) return;
  sending = true;
  entry.state = "sending";
  const signal = entry.controller.signal;
  try {
    if (!entry.digest) {
      entry.detail.textContent = "Checking file…";
      entry.digest = await hashFile(entry.file, signal);
    }
    const wasStarted = !!entry.serverId;
    const info = JSON.stringify({ name: entry.file.name, size: entry.file.size, digest: entry.digest });
    let result = await request("/files", "POST", info, ticket, signal);
    entry.serverId = result.id;
    if (signal.aborted) { await cancel(entry); return; }
    progress(entry, result);
    if (result.complete && !wasStarted) entry.detail.textContent = "Already received";
    while (!result.complete) {
      if (signal.aborted) return;
      const bytes = entry.file.slice(result.bytes, result.bytes + BLOCK);
      result = await request(`/files/${entry.serverId}?offset=${result.bytes}`, "PUT", bytes, ticket, signal);
      progress(entry, result);
    }
    entry.state = "done";
    entry.button.hidden = true;
  } catch (error) {
    if (entry.state === "cancelled") return;
    if (!error.status || [408, 409, 429].includes(error.status) || (error.status >= 500 && error.status !== 507)) {
      entry.state = "waiting";
      approved = false;
      entry.detail.textContent = "Waiting to reconnect. Uploaded bytes are saved.";
    } else {
      entry.state = "failed";
      entry.detail.textContent = error.message;
      entry.button.textContent = "Retry";
      entry.button.className = "retry";
    }
  } finally {
    sending = false;
    if (approved) void sendNext();
  }
}

files.addEventListener("change", () => { add(files.files); files.value = ""; });
for (const event of ["dragover", "dragleave", "drop"]) drop.addEventListener(event, (e) => {
  e.preventDefault();
  drop.classList.toggle("drag", event === "dragover");
  if (event === "drop") add(e.dataTransfer.files);
});
window.addEventListener("online", () => { if (!permanent) for (const entry of queue) if (entry.state === "cancelled") void cancel(entry); });

// HTTP on an offline LAN lacks Web Crypto. Calculate the same incremental SHA-256 on both modes
// so even large phone uploads are checked without holding the file in memory.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));

async function hashFile(file, signal) {
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const schedule = new Uint32Array(64);
  const block = (data, start) => {
    for (let j = 0; j < 16; j++) schedule[j] = data.getUint32(start + j * 4);
    for (let j = 16; j < 64; j++) {
      const x = schedule[j - 15], y = schedule[j - 2];
      schedule[j] = schedule[j - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + schedule[j - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let j = 0; j < 64; j++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[j] + schedule[j]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const result = [a,b,c,d,e,f,g,h];
    for (let j = 0; j < 8; j++) state[j] += result[j];
  };
  let tail = new Uint8Array();
  for (let offset = 0; offset < file.size; offset += BLOCK) {
    if (signal.aborted) throw new Error("Cancelled");
    const chunk = await file.slice(offset, offset + BLOCK).arrayBuffer();
    const data = new DataView(chunk);
    const whole = chunk.byteLength - chunk.byteLength % 64;
    for (let at = 0; at < whole; at += 64) block(data, at);
    if (whole < chunk.byteLength) tail = new Uint8Array(chunk, whole);
  }
  const end = new Uint8Array(tail.length < 56 ? 64 : 128);
  end.set(tail);
  end[tail.length] = 128;
  const last = new DataView(end.buffer);
  last.setUint32(end.length - 8, Math.floor(file.size * 8 / 0x100000000));
  last.setUint32(end.length - 4, (file.size * 8) >>> 0);
  for (let at = 0; at < end.length; at += 64) block(last, at);
  return Array.from(state, (value) => value.toString(16).padStart(8, "0")).join("");
}

void heartbeat();
