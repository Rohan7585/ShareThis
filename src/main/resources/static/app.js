'use strict';
/*
 * ShareThis frontend.
 *
 * Two connections are involved:
 *  - A WebSocket to the Spring Boot server ("signaling"): presence, transfer requests and the
 *    WebRTC handshake messages. Small JSON only.
 *  - An RTCDataChannel directly between the two browsers, which carries the file bytes.
 *
 * The WebRTC handshake in short: each side creates an RTCPeerConnection. The sender creates an
 * "offer" (an SDP text blob describing the session: here, one data channel plus encryption keys)
 * and the receiver replies with an "answer". Meanwhile each side discovers "ICE candidates", which
 * are addresses it might be reachable at ("host" = its LAN IP, "srflx" = its public IP as seen by a
 * STUN server), and trickles them to the other side as they are found. The browsers then test
 * candidate pairs and use the first one that works. On the same Wi-Fi that is normally host ↔ host,
 * so the bytes go straight across the router.
 */

const CHUNK_MAX = 64 * 1024;
const HIGH_WATER_MARK = 4 * 1024 * 1024; // pause sending above this much queued data...
const LOW_WATER_MARK = 1024 * 1024;      // ...and resume once it drains below this
const CONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 2000;
const PROGRESS_INTERVAL_MS = 100;

// STUN only matters when devices are on different networks. Offline it just fails silently and the
// LAN (host) candidates still work. No TURN on purpose: file data must never be relayed by a server.
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  me: null,          // { id, name } from the latest "welcome"
  mode: 'idle',      // last mode we told the server; re-sent after a reconnect
  files: [],         // File objects picked in the Upload view
  receivers: [],     // [{ id, name }] devices currently in Download mode
  outgoing: null,    // { peerId, peerName }: our request, waiting for an answer
  incoming: null,    // { peerId, peerName, files }: request shown to us
  session: null,     // the active or last transfer, see createSession()
  objectUrls: [],    // blob: URLs behind Save links, revoked when going home
};

// ---------------------------------------------------------------- helpers

function formatBytes(n) {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  return `${m} min ${Math.round(seconds - m * 60)} s`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const totalSize = (files) => files.reduce((sum, f) => sum + f.size, 0);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // always textContent: names come from other devices
  return node;
}

/** A file row: name, a meta line (size / status) and a slot for actions such as a Save link. */
function fileRow(file) {
  const li = el('li', 'file');
  const info = el('div', 'file-info');
  const meta = el('span', 'file-meta', formatBytes(file.size));
  info.append(el('span', 'file-name', file.name), meta);
  const actions = el('div', 'file-actions');
  li.append(info, actions);
  return { li, meta, actions };
}

let toastTimer;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

function showView(name) {
  for (const view of ['home', 'upload', 'download', 'transfer']) {
    $(`view-${view}`).hidden = view !== name;
  }
  // Move focus to the new view's heading so keyboard and screen reader users follow along.
  $(`view-${name}`).querySelector('h2').focus();
}

function setMode(mode) {
  state.mode = mode;
  wsSend({ type: 'set-mode', mode });
}

function goHome() {
  const s = state.session;
  if (s && !s.closed) closeSession(s, 'You disconnected.', { notify: true });
  state.session = null;
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls = [];
  $('transfer-files').replaceChildren();
  state.files = [];
  $('file-input').value = '';
  setMode('idle');
  showView('home');
}

// ---------------------------------------------------------------- signaling (WebSocket)

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  state.ws = ws;
  setConnStatus('Connecting…', false);

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleServerMessage(msg);
  };
  // "error" is always followed by "close", so all cleanup lives here.
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    onServerLost();
    setTimeout(connect, RECONNECT_DELAY_MS);
  };
}

function wsSend(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function setConnStatus(text, offline) {
  const status = $('conn-status');
  status.textContent = text;
  status.classList.toggle('offline', offline);
}

function setMyName(name) {
  document.querySelectorAll('.my-name').forEach((node) => { node.textContent = name; });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      state.me = { id: msg.id, name: msg.name };
      setMyName(msg.name);
      setConnStatus('', false);
      // A reconnect gives us a new id/name and the server has forgotten our mode, so restore it.
      if (state.mode !== 'idle') setMode(state.mode);
      break;
    case 'peers':
      state.receivers = Array.isArray(msg.peers) ? msg.peers : [];
      renderReceivers();
      break;
    case 'transfer-request': onTransferRequest(msg); break;
    case 'transfer-response': onTransferResponse(msg); break;
    case 'signal': onSignal(msg); break;
    case 'cancel': onCancel(msg); break;
    case 'peer-left': onPeerLeft(msg.id); break;
  }
}

function onServerLost() {
  setConnStatus('· offline, reconnecting…', true);
  setMyName('…');
  state.me = null;
  state.receivers = [];
  renderReceivers();
  if (state.outgoing) {
    state.outgoing = null;
    renderWaiting();
    toast('Lost connection to the server. Your request was cancelled.');
  }
  if (state.incoming) {
    hideIncoming();
    toast('Lost connection to the server. The request was dropped.');
  }
  // An open data channel doesn't need the server, so a running transfer carries on.
  const s = state.session;
  if (s && !s.closed && !s.channelOpen) {
    failSession(s, 'Lost connection to the server before the devices could connect.');
  }
}

function onCancel(msg) {
  const name = msg.fromName || 'The other device';
  if (state.incoming && state.incoming.peerId === msg.from) {
    hideIncoming();
    toast(`${name} cancelled the request.`);
  }
  if (state.outgoing && state.outgoing.peerId === msg.from) {
    state.outgoing = null;
    renderWaiting();
    toast(`${name} cancelled.`);
  }
  const s = state.session;
  if (s && !s.closed && s.peerId === msg.from) {
    closeSession(s, `${s.peerName} closed the connection.`);
  }
}

function onPeerLeft(id) {
  state.receivers = state.receivers.filter((p) => p.id !== id);
  renderReceivers();
  if (state.incoming && state.incoming.peerId === id) {
    toast(`${state.incoming.peerName} left.`);
    hideIncoming();
  }
  if (state.outgoing && state.outgoing.peerId === id) {
    toast(`${state.outgoing.peerName} left.`);
    state.outgoing = null;
    renderWaiting();
  }
  // Once the data channel is open we don't care about the peer's WebSocket; a real disconnect
  // closes the channel too and is handled there.
  const s = state.session;
  if (s && !s.closed && s.peerId === id && !s.channelOpen) {
    failSession(s, `${s.peerName} left before the devices could connect.`);
  }
}

// ---------------------------------------------------------------- Upload view (sender)

function renderSelectedFiles() {
  $('selected-files').replaceChildren(...state.files.map((f) => fileRow(f).li));
  $('selected-summary').textContent = state.files.length
    ? `${plural(state.files.length, 'file')} · ${formatBytes(totalSize(state.files))}`
    : 'No files chosen yet.';
}

function renderReceivers() {
  const list = $('receivers');
  const focusedId = document.activeElement && document.activeElement.dataset.peerId;
  const canSend = state.files.length > 0 && !state.outgoing;

  list.replaceChildren(...state.receivers.map((peer) => {
    const li = el('li');
    const button = el('button', 'peer', peer.name);
    button.type = 'button';
    button.dataset.peerId = peer.id;
    button.disabled = !canSend;
    button.addEventListener('click', () => sendRequest(peer));
    li.append(button);
    return li;
  }));

  // Rebuilding the list would otherwise drop keyboard focus.
  if (focusedId) {
    const again = list.querySelector(`[data-peer-id="${CSS.escape(focusedId)}"]`);
    if (again && !again.disabled) again.focus();
  }
  $('receivers-empty').hidden = state.receivers.length > 0;
  $('receivers-hint').hidden = state.files.length > 0 || state.receivers.length === 0;
}

function sendRequest(peer) {
  if (state.outgoing || state.files.length === 0) return;
  const files = state.files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
  if (!wsSend({ type: 'transfer-request', to: peer.id, files })) {
    toast('Not connected to the server yet. Try again in a moment.');
    return;
  }
  state.outgoing = { peerId: peer.id, peerName: peer.name };
  renderWaiting();
}

function renderWaiting() {
  const o = state.outgoing;
  $('waiting').hidden = !o;
  $('file-input').disabled = !!o;
  if (o) $('waiting-text').textContent = `Waiting for ${o.peerName} to accept…`;
  renderReceivers();
  if (o) $('btn-cancel-request').focus();
}

function cancelOutgoing() {
  if (!state.outgoing) return;
  wsSend({ type: 'cancel', to: state.outgoing.peerId });
  state.outgoing = null;
  renderWaiting();
}

function onTransferResponse(msg) {
  const o = state.outgoing;
  if (!o || o.peerId !== msg.from) {
    // A late answer to a request we already cancelled: make sure the other side lets go too.
    if (msg.accepted) wsSend({ type: 'cancel', to: msg.from });
    return;
  }
  state.outgoing = null;
  renderWaiting();
  if (msg.accepted) {
    startSending(o.peerId, o.peerName);
    return;
  }
  const reasons = {
    rejected: `${o.peerName} declined.`,
    busy: `${o.peerName} is busy with another transfer.`,
    'not-receiving': `${o.peerName} is no longer receiving.`,
  };
  toast(reasons[msg.reason] || `${o.peerName} couldn't accept.`);
}

// ---------------------------------------------------------------- Download view (receiver)

function onTransferRequest(msg) {
  const files = sanitizeFiles(msg.files);
  const reply = (reason) => wsSend({ type: 'transfer-response', to: msg.from, accepted: false, reason });
  if (!files) return reply('rejected');
  if (state.incoming || (state.session && !state.session.closed)) return reply('busy');
  if (state.mode !== 'receive') return reply('not-receiving');

  state.incoming = { peerId: msg.from, peerName: String(msg.fromName), files };
  $('incoming-title').textContent =
    `${state.incoming.peerName} wants to send you ${plural(files.length, 'file')} (${formatBytes(totalSize(files))})`;
  $('incoming-files').replaceChildren(...files.map((f) => fileRow(f).li));
  $('incoming').hidden = false;
  $('download-idle').hidden = true;
  $('btn-accept').focus();
  if (navigator.vibrate) navigator.vibrate(200);
}

/** Validates the file list another device sent us; returns null if it looks malformed. */
function sanitizeFiles(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const files = [];
  for (const f of list) {
    if (!f || typeof f.name !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0) return null;
    files.push({ name: f.name.slice(0, 255) || 'file', size: f.size, type: typeof f.type === 'string' ? f.type : '' });
  }
  return files;
}

function hideIncoming() {
  state.incoming = null;
  $('incoming').hidden = true;
  $('download-idle').hidden = false;
}

function declineIncoming() {
  if (!state.incoming) return;
  wsSend({ type: 'transfer-response', to: state.incoming.peerId, accepted: false, reason: 'rejected' });
  hideIncoming();
}

function acceptIncoming() {
  const request = state.incoming;
  if (!request) return;
  hideIncoming();
  // Create our peer connection *before* saying yes, so it is ready when the offer arrives.
  startReceiving(request);
  wsSend({ type: 'transfer-response', to: request.peerId, accepted: true });
}

// ---------------------------------------------------------------- WebRTC session

const FILE_STATES = {
  waiting: 'Waiting',
  sending: 'Sending…',
  sent: 'Sent',
  receiving: 'Receiving…',
  received: 'Received',
  cancelled: 'Not completed',
};

function createSession(role, peerId, peerName, files) {
  const s = {
    role, peerId, peerName,
    files,                    // [{ name, size, type }]
    fileObjs: null,           // sender only: the File objects
    pc: null,
    channel: null,
    channelOpen: false,
    closed: false,
    finished: false,          // all files delivered (sender got "ack" / receiver got "done")
    pendingCandidates: [],    // ICE candidates that arrived before the remote description
    signalQueue: Promise.resolve(),
    totalBytes: totalSize(files),
    bytes: 0,                 // sender: bytes handed to send(); receiver: bytes received
    fileEnds: [],             // sender: value of `bytes` right after file i was fully queued
    current: null,            // receiver: { i, chunks } for the file being received
    fileState: files.map(() => 'waiting'),
    rows: [],
    connectTimer: null,
    progressTimer: null,
    wakeSender: null,         // resolves a pending waitForDrain()
    startTime: 0,
    speed: { value: 0, lastBytes: 0, lastTime: 0 },
  };
  state.session = s;
  setMode('busy'); // disappear from other senders' lists while we're occupied
  renderTransferView(s);
  showView('transfer');

  s.pc = createPeerConnection(s);
  s.connectTimer = setTimeout(() => {
    if (!s.channelOpen) failSession(s, cannotConnectMessage(s));
  }, CONNECT_TIMEOUT_MS);
  return s;
}

function cannotConnectMessage(s) {
  return `Couldn't connect directly to ${s.peerName}. Check that both devices are on the same Wi-Fi ` +
    'and that the network allows devices to talk to each other (guest and office networks often block this).';
}

function createPeerConnection(s) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  // Send each candidate to the other side as soon as it's discovered ("trickle ICE").
  // A null candidate just means gathering is finished.
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal(s, { candidate: event.candidate.toJSON() });
  };
  // "failed" = every candidate pair was tried and none worked.
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' && !s.channelOpen) failSession(s, cannotConnectMessage(s));
  };
  return pc;
}

function sendSignal(s, data) {
  if (!s.closed) wsSend({ type: 'signal', to: s.peerId, data });
}

async function startSending(peerId, peerName) {
  const fileObjs = state.files.slice();
  const meta = fileObjs.map((f) => ({ name: f.name, size: f.size, type: f.type }));
  const s = createSession('send', peerId, peerName, meta);
  s.fileObjs = fileObjs;

  // The offering side creates the channel; the other side gets it via the "datachannel" event.
  // ordered: true gives reliable, in-order delivery (like TCP), which is what file data needs.
  setupChannel(s, s.pc.createDataChannel('files', { ordered: true }));
  try {
    await s.pc.setLocalDescription(await s.pc.createOffer());
    sendSignal(s, { sdp: s.pc.localDescription });
  } catch (err) {
    failSession(s, `Could not start the connection: ${err.message}`);
  }
}

function startReceiving(request) {
  const s = createSession('receive', request.peerId, request.peerName, request.files);
  s.pc.ondatachannel = (event) => setupChannel(s, event.channel);
}

function onSignal(msg) {
  const s = state.session;
  if (!s || s.closed || s.peerId !== msg.from || !msg.data) return;
  // Apply signals strictly in arrival order; each step is async and must finish before the next.
  s.signalQueue = s.signalQueue
    .then(() => applySignal(s, msg.data))
    .catch((err) => failSession(s, `Connection setup failed: ${err.message}`));
}

async function applySignal(s, data) {
  if (s.closed) return;
  const pc = s.pc;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal(s, { sdp: pc.localDescription });
    }
    // Candidates can only be added once the remote description is set; flush the early ones.
    const queued = s.pendingCandidates;
    s.pendingCandidates = [];
    for (const candidate of queued) await addCandidate(pc, candidate);
  } else if (data.candidate) {
    if (pc.remoteDescription) await addCandidate(pc, data.candidate);
    else s.pendingCandidates.push(data.candidate);
  }
}

async function addCandidate(pc, candidate) {
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    // One bad candidate (e.g. a ".local" mDNS name this device can't resolve) must not stop the rest.
    console.debug('Ignoring ICE candidate:', err.message);
  }
}

function setupChannel(s, channel) {
  s.channel = channel;
  channel.binaryType = 'arraybuffer';
  // The "bufferedamountlow" event fires when queued data drops below this; used for backpressure.
  channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
  channel.onopen = () => onChannelOpen(s);
  channel.onmessage = (event) => onChannelMessage(s, event.data);
  channel.onclose = () => {
    if (s.finished) closeSession(s, `Connection to ${s.peerName} closed.`);
    else failSession(s, `Connection to ${s.peerName} was lost.`);
  };
  if (channel.readyState === 'open') onChannelOpen(s);
}

function onChannelOpen(s) {
  if (s.channelOpen || s.closed) return;
  s.channelOpen = true;
  clearTimeout(s.connectTimer);
  setStatus(s, s.role === 'send' ? `Sending to ${s.peerName}…` : `Receiving from ${s.peerName}…`);
  s.startTime = s.speed.lastTime = performance.now();
  s.progressTimer = setInterval(() => renderProgress(s), PROGRESS_INTERVAL_MS);
  showRoute(s);
  if (s.role === 'send') {
    runSender(s).catch((err) => {
      if (!s.closed) failSession(s, `Sending failed: ${err.message}`);
    });
  }
}

function sendControl(s, msg) {
  s.channel.send(JSON.stringify(msg));
}

async function runSender(s) {
  const channel = s.channel;
  // SCTP (the protocol under data channels) advertises the largest message the peer accepts.
  const maxMessage = s.pc.sctp && s.pc.sctp.maxMessageSize;
  const chunkSize = maxMessage > 0 ? Math.min(CHUNK_MAX, maxMessage) : CHUNK_MAX;

  for (let i = 0; i < s.fileObjs.length; i++) {
    const file = s.fileObjs[i];
    sendControl(s, { t: 'start', i });
    setFileState(s, i, 'sending');
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      // Backpressure: send() only queues data inside the browser. Without pausing, a large file
      // would be queued in memory all at once, and Chrome closes the channel when its queue overflows.
      if (channel.bufferedAmount > HIGH_WATER_MARK) await waitForDrain(s);
      if (s.closed) return;
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      if (s.closed) return;
      channel.send(chunk);
      s.bytes += chunk.byteLength;
    }
    sendControl(s, { t: 'end', i });
    s.fileEnds[i] = s.bytes;
  }
  sendControl(s, { t: 'done' });
  setStatus(s, `Waiting for ${s.peerName} to confirm…`);
}

function waitForDrain(s) {
  return new Promise((resolve) => {
    const channel = s.channel;
    const wake = () => {
      channel.removeEventListener('bufferedamountlow', wake);
      channel.removeEventListener('close', wake);
      s.wakeSender = null;
      resolve();
    };
    channel.addEventListener('bufferedamountlow', wake);
    channel.addEventListener('close', wake);
    s.wakeSender = wake; // closeSession() calls this so the sender loop stops immediately
  });
}

function onChannelMessage(s, data) {
  if (s.closed) return;
  if (typeof data !== 'string') {
    // Binary = a chunk of the current file.
    if (s.current) {
      s.current.chunks.push(data);
      s.bytes += data.byteLength;
    }
    return;
  }

  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  const validIndex = Number.isInteger(msg.i) && msg.i >= 0 && msg.i < s.files.length;
  switch (msg.t) {
    case 'start':
      if (s.role === 'receive' && validIndex) {
        s.current = { i: msg.i, chunks: [] };
        setFileState(s, msg.i, 'receiving');
      }
      break;
    case 'end':
      if (s.current && s.current.i === msg.i) finishFile(s);
      break;
    case 'done':
      if (s.role === 'receive' && !s.finished) {
        s.finished = true;
        sendControl(s, { t: 'ack' });
        finishTransfer(s, `Received ${plural(s.files.length, 'file')} from ${s.peerName}. Tap Save to keep them.`);
      }
      break;
    case 'ack':
      if (s.role === 'send' && !s.finished) {
        s.finished = true;
        s.files.forEach((_, i) => setFileState(s, i, 'sent'));
        finishTransfer(s, `Sent. ${s.peerName} received all files.`);
      }
      break;
    case 'cancel':
      closeSession(s, `${s.peerName} closed the connection.`);
      break;
  }
}

// Types a browser might render (and run scripts in) if a blob: URL were opened as a page.
const UNSAFE_TYPE = /html|xml|javascript|ecmascript/i;

function finishFile(s) {
  const { i, chunks } = s.current;
  s.current = null;
  const meta = s.files[i];
  const type = !meta.type || UNSAFE_TYPE.test(meta.type) ? 'application/octet-stream' : meta.type;
  const url = URL.createObjectURL(new Blob(chunks, { type }));
  state.objectUrls.push(url);

  const link = el('a', 'save', 'Save');
  link.href = url;
  link.download = meta.name;
  link.setAttribute('aria-label', `Save ${meta.name}`);
  s.rows[i].actions.append(link);
  setFileState(s, i, 'received');
}

function finishTransfer(s, message) {
  clearInterval(s.progressTimer);
  renderProgress(s);
  setStatus(s, message);
  // The transfer is over, but the connection stays open until someone taps Disconnect.
  setMode('idle');
}

/**
 * Ends the session. notify = tell the peer, over the data channel if it's open and over the
 * WebSocket in case it isn't (yet).
 */
function closeSession(s, message, { notify = false, error = false } = {}) {
  if (s.closed) return;
  s.closed = true;
  clearTimeout(s.connectTimer);
  clearInterval(s.progressTimer);

  if (notify) {
    try { if (s.channel && s.channel.readyState === 'open') sendControl(s, { t: 'cancel' }); } catch { /* closing anyway */ }
    wsSend({ type: 'cancel', to: s.peerId });
  }
  if (s.wakeSender) s.wakeSender();
  s.current = null; // drop a partly received file

  if (s.channel) {
    s.channel.onclose = null;
    s.channel.onmessage = null;
    try { s.channel.close(); } catch { /* already closed */ }
  }
  const pc = s.pc;
  if (pc) {
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    // Give a queued "cancel" a moment to go out before tearing the connection down.
    setTimeout(() => pc.close(), 500);
  }

  s.fileState.forEach((st, i) => {
    if (st !== 'sent' && st !== 'received') setFileState(s, i, 'cancelled');
  });
  if (s.channelOpen) renderProgress(s);
  setStatus(s, message, error);

  if (state.session === s) {
    $('btn-disconnect').hidden = true;
    $('btn-transfer-home').hidden = false;
    $('btn-transfer-home').focus();
    if (state.mode === 'busy') setMode('idle');
  }
}

function failSession(s, message) {
  closeSession(s, message, { notify: true, error: true });
}

/** Asks the browser which candidate pair it picked, to show whether the connection is really direct. */
async function showRoute(s) {
  // The selected pair may not be reported the instant the channel opens, so retry briefly.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (s.closed || state.session !== s) return;
    const text = await describeRoute(s.pc).catch(() => null);
    if (text) {
      if (state.session === s) $('transfer-route').textContent = text;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function describeRoute(pc) {
  const stats = await pc.getStats();
  let pair = null;
  // Chrome/Safari: the "transport" report points at the selected pair. Firefox: the pair has selected: true.
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.selected) pair = r; });
  if (!pair) return null;

  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (!local || !remote) return null;
  const kinds = [local.candidateType, remote.candidateType];
  const label = `${kinds[0]} ↔ ${kinds[1]}`;
  // host  = a LAN address.
  // prflx = an address learned during the connectivity checks. On a LAN this is still a direct
  //         path; it shows up when the other side hid its IP behind an mDNS ".local" name.
  // srflx = a public address found via STUN (the traffic hairpins through the router's NAT).
  // relay = a TURN server (we don't configure one, so this shouldn't happen).
  if (kinds.includes('relay')) return `Relayed connection (${label})`;
  if (kinds.includes('srflx')) return `Connected through the router's public address (${label})`;
  return `Direct device-to-device connection (${label})`;
}

// ---------------------------------------------------------------- Transfer view

function renderTransferView(s) {
  $('transfer-title').textContent = s.role === 'send' ? `Sending to ${s.peerName}` : `Receiving from ${s.peerName}`;
  setStatus(s, 'Connecting directly…');
  $('transfer-route').textContent = '';
  $('transfer-progress').value = 0;
  $('transfer-stats').textContent = `0 B of ${formatBytes(s.totalBytes)}`;
  s.rows = s.files.map((f) => fileRow(f));
  s.files.forEach((_, i) => setFileState(s, i, 'waiting'));
  $('transfer-files').replaceChildren(...s.rows.map((row) => row.li));
  $('btn-disconnect').hidden = false;
  $('btn-transfer-home').hidden = true;
}

function setStatus(s, text, error = false) {
  if (state.session !== s) return;
  const status = $('transfer-status');
  status.textContent = text;
  status.classList.toggle('error', error);
}

function setFileState(s, i, fileState) {
  s.fileState[i] = fileState;
  const row = s.rows[i];
  row.li.dataset.state = fileState;
  row.meta.textContent = `${formatBytes(s.files[i].size)} · ${FILE_STATES[fileState]}`;
}

function renderProgress(s) {
  if (state.session !== s) return;
  const now = performance.now();
  let done = s.bytes;
  if (s.finished) {
    done = s.totalBytes;
  } else if (s.role === 'send' && !s.closed) {
    // Data still sitting in the browser's send queue hasn't actually left this device yet.
    done = Math.max(0, s.bytes - s.channel.bufferedAmount);
    s.fileEnds.forEach((end, i) => {
      if (end <= done && s.fileState[i] === 'sending') setFileState(s, i, 'sent');
    });
  }

  // Smoothed speed, sampled twice a second.
  const speed = s.speed;
  const dt = (now - speed.lastTime) / 1000;
  if (dt >= 0.5) {
    const instant = (done - speed.lastBytes) / dt;
    speed.value = speed.value ? speed.value * 0.6 + instant * 0.4 : instant;
    speed.lastBytes = done;
    speed.lastTime = now;
  }

  $('transfer-progress').value = s.totalBytes ? done / s.totalBytes : (s.finished ? 1 : 0);
  let text = `${formatBytes(done)} of ${formatBytes(s.totalBytes)}`;
  if (s.finished) {
    const seconds = (now - s.startTime) / 1000;
    text += ` · done in ${formatDuration(seconds)}`;
    if (seconds > 0.5) text += ` · avg ${formatBytes(s.totalBytes / seconds)}/s`;
  } else if (!s.closed && speed.value > 0) {
    text += ` · ${formatBytes(speed.value)}/s · about ${formatDuration((s.totalBytes - done) / speed.value)} left`;
  }
  $('transfer-stats').textContent = text;
}

// ---------------------------------------------------------------- wiring

function onLeavingPage() {
  const s = state.session;
  if (s && !s.closed) closeSession(s, 'Closed.', { notify: true });
  cancelOutgoing();
  declineIncoming();
}

function init() {
  if (!window.RTCPeerConnection) {
    $('home-actions').hidden = true;
    $('unsupported').hidden = false;
    return;
  }

  $('btn-upload').addEventListener('click', () => {
    showView('upload');
    setMode('send');
    renderSelectedFiles();
    renderWaiting();
  });
  $('btn-download').addEventListener('click', () => {
    hideIncoming();
    showView('download');
    setMode('receive');
  });
  $('file-input').addEventListener('change', (event) => {
    state.files = Array.from(event.target.files);
    renderSelectedFiles();
    renderReceivers();
  });
  $('btn-cancel-request').addEventListener('click', cancelOutgoing);
  $('upload-back').addEventListener('click', () => { cancelOutgoing(); goHome(); });
  $('download-back').addEventListener('click', () => { declineIncoming(); goHome(); });
  $('btn-accept').addEventListener('click', acceptIncoming);
  $('btn-decline').addEventListener('click', declineIncoming);
  $('btn-disconnect').addEventListener('click', () => {
    if (state.session) closeSession(state.session, 'You disconnected.', { notify: true });
  });
  $('btn-transfer-home').addEventListener('click', goHome);
  window.addEventListener('beforeunload', onLeavingPage);
  window.addEventListener('pagehide', onLeavingPage);

  connect();
}

init();
