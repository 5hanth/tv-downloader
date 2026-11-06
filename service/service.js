// TV Downloader - TizenBrew service.
// Runs inside TizenBrew's Node service (Node 4.4.3 on Tizen 4): ES5 + Node built-ins only
// (no Buffer.from, no ES6 syntax).
//
// Two HTTP servers, on purpose:
//   LAN   0.0.0.0:80 (falls back to 8090) - "add link" web page for phones and laptops. It can only add, list and remove links.
//   LOCAL 127.0.0.1:8091 - the TV UI's API: start/stop downloads, list/serve/delete files. Not reachable from the LAN.
// Plus an mDNS responder that answers for tv-dl.local.
'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var os = require('os');
var dgram = require('dgram');
var urlLib = require('url');
var querystring = require('querystring');

var env = (typeof process !== 'undefined' && process.env) || {};
var MEDIA_ROOT = env.TVDL_MEDIA_ROOT || '/opt/media';
var LAN_PORTS = (env.TVDL_LAN_PORTS || '80,8090').split(',').map(Number);
var LOCAL_PORT = Number(env.TVDL_LOCAL_PORT || 8091);
var LAN_HOST = env.TVDL_LAN_HOST || '0.0.0.0';   // dev overrides to 127.0.0.1
var MDNS_ENABLED = env.TVDL_NO_MDNS !== '1';
var MDNS_NAME = 'tv-dl.local';
var CA_URL = env.TVDL_CA_URL || 'https://cdn.jsdelivr.net/gh/5hanth/tv-downloader@main/service/cacert.pem';
var FAT32_MAX = 4294967295;
var UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 4.0) TVDownloader/0.1';

// ------------------------------------------------------------------ state
var S = {
  links: [],            // {id,url,name,addedAt,status,fileName,file,bytes,total,error,acceptRanges,contentType,insecureTLS}
  active: null,         // id of the link currently downloading
  queue: [],
  lan: { ip: null, port: null, error: null },
  mdns: { status: 'starting' },
  ca: null,             // array of PEM strings, if loaded
  storeDir: null
};
var current = null;     // { req, out, link }

function log(m) { try { console.log('[tv-dl] ' + m); } catch (e) {} }
function now() { return Date.now(); }
function newId() { return now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ------------------------------------------------------------------ drive helpers
function listDrives() {
  try {
    return fs.readdirSync(MEDIA_ROOT).filter(function (n) {
      try { return fs.statSync(path.join(MEDIA_ROOT, n)).isDirectory(); } catch (e) { return false; }
    }).sort();
  } catch (e) { return []; }
}

function mountInfo(p) {
  try {
    var lines = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i].split(' ');
      if (f[1] === p) return { fs: f[2], opts: f[3] };
    }
  } catch (e) {}
  return null;
}

function drive() {
  var d = listDrives();
  if (!d.length) return null;
  var p = path.join(MEDIA_ROOT, d[0]);
  var m = mountInfo(p);
  return { name: d[0], path: p, fs: m ? m.fs : null, downloads: path.join(p, 'Downloads') };
}

function mkdirp(p) {
  try { fs.mkdirSync(p); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

// ------------------------------------------------------------------ persistence
// Links live on the USB drive (.tvdl/links.json) so they travel with it; fall back to the app's home dir.
function storeDir() {
  var d = drive();
  var cands = [];
  if (d) cands.push(path.join(d.path, '.tvdl'));
  cands.push(path.join(env.HOME || '/home/owner', '.tvdl'));
  for (var i = 0; i < cands.length; i++) {
    try { mkdirp(cands[i]); fs.accessSync ? fs.accessSync(cands[i], fs.W_OK) : 0; return cands[i]; } catch (e) {}
  }
  return null;
}

function load() {
  var dir = storeDir();
  S.storeDir = dir;
  if (!dir) return;
  try {
    var data = JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8'));
    S.links = (data.links || []).map(function (l) {
      if (l.status === 'downloading' || l.status === 'queued') l.status = 'stopped';
      return l;
    });
  } catch (e) {}
}

var saveTimer = null;
function save(soon) {
  if (soon) { if (!saveTimer) saveTimer = setTimeout(function () { saveTimer = null; save(); }, 4000); return; }
  var dir = storeDir();
  if (dir && dir !== S.storeDir) {
    // drive appeared/changed: merge links stored there
    var prev = S.links; S.storeDir = dir;
    try {
      var other = JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8')).links || [];
      var seen = {}; prev.forEach(function (l) { seen[l.id] = 1; });
      other.forEach(function (l) { if (!seen[l.id]) prev.push(l); });
    } catch (e) {}
  }
  if (!dir) return;
  try {
    fs.writeFileSync(path.join(dir, 'links.json.tmp'), JSON.stringify({ links: S.links }, null, 1));
    fs.renameSync(path.join(dir, 'links.json.tmp'), path.join(dir, 'links.json'));
  } catch (e) { log('save failed: ' + e.message); }
}

function findLink(id) { for (var i = 0; i < S.links.length; i++) if (S.links[i].id === id) return S.links[i]; return null; }

// ------------------------------------------------------------------ HTTP client (redirects, CA bundle, TLS fallback)
var TLS_ERRORS = /CERT|UNABLE_TO_VERIFY|SELF_SIGNED|UNABLE_TO_GET_ISSUER|DEPTH_ZERO/;

function request(url, opts, cb, state) {
  state = state || { redirects: 8, insecure: false };
  var u = urlLib.parse(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb(new Error('Only http/https links are supported'));
  var lib = u.protocol === 'https:' ? https : http;
  var headers = { 'User-Agent': UA, 'Accept': '*/*' };
  for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
  var o = { hostname: u.hostname, port: u.port, path: u.path, method: opts.method || 'GET', headers: headers };
  if (u.protocol === 'https:') {
    if (state.insecure) o.rejectUnauthorized = false;
    else if (S.ca) o.ca = S.ca;
  }
  var done = false;
  var req = lib.request(o, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (state.redirects <= 0) return finish(new Error('Too many redirects'));
      state.redirects--;
      return request(urlLib.resolve(url, res.headers.location), opts, cb, state);
    }
    res.finalUrl = url;
    res.insecureTLS = state.insecure;
    finish(null, res, req);
  });
  function finish(err, res, r) { if (done) return; done = true; cb(err, res, r); }
  req.setTimeout(30000, function () { req.abort(); finish(new Error('Connection timed out')); });
  req.on('error', function (e) {
    if (done) return;
    if (!state.insecure && TLS_ERRORS.test(e.code || e.message)) {
      log('TLS verify failed for ' + u.hostname + ' (' + (e.code || e.message) + '), retrying without verification');
      done = true;
      state.insecure = true;
      return request(url, opts, cb, state);
    }
    finish(e);
  });
  req.end();
  return req;
}

function loadCA() {
  request(CA_URL, {}, function (err, res) {
    if (err || res.statusCode !== 200) { log('CA bundle not loaded, using built-in roots'); if (res) res.resume(); return; }
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var pem = Buffer.concat(chunks).toString('utf8');
      var certs = pem.split('-----END CERTIFICATE-----').map(function (s) {
        var i = s.indexOf('-----BEGIN CERTIFICATE-----');
        return i >= 0 ? s.slice(i) + '-----END CERTIFICATE-----\n' : null;
      }).filter(Boolean);
      if (certs.length > 50) { S.ca = certs; log('CA bundle loaded: ' + certs.length + ' roots'); }
    });
  });
}

// ------------------------------------------------------------------ filenames
function sanitize(name) {
  name = String(name || '').replace(/[\\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  if (name.length > 180) {
    var ext = path.extname(name);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name || 'download';
}

function nameFromHeaders(res, url) {
  var cd = res.headers['content-disposition'] || '';
  var m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch (e) {} }
  m = /filename\s*=\s*"([^"]+)"/.exec(cd) || /filename\s*=\s*([^;]+)/.exec(cd);
  if (m) return m[1].trim();
  var p = urlLib.parse(url).pathname || '';
  var base = p.split('/').pop();
  try { base = decodeURIComponent(base); } catch (e) {}
  return base || '';
}

function extFor(type) {
  type = (type || '').split(';')[0].trim();
  return { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a', 'video/quicktime': '.mov', 'application/pdf': '.pdf' }[type] || '';
}

function finalName(link) {
  var server = link.serverName || '';
  var ext = path.extname(server) || extFor(link.contentType);
  var base = link.name ? link.name : (server || 'download');
  if (link.name && ext && path.extname(base).toLowerCase() !== ext.toLowerCase()) base += ext;
  if (!path.extname(base) && ext) base += ext;
  return sanitize(base);
}

function uniquePath(dir, name) {
  var ext = path.extname(name), stem = name.slice(0, name.length - ext.length), p = path.join(dir, name), n = 1;
  while (fs.existsSync(p)) p = path.join(dir, stem + ' (' + (n++) + ')' + ext);
  return p;
}

// ------------------------------------------------------------------ link inspection (size/type/name) when added
function inspect(link) {
  link.status = 'checking';
  request(link.url, { headers: { 'Range': 'bytes=0-0' } }, function (err, res, req) {
    if (err) { link.status = 'new'; link.error = 'Check failed: ' + err.message; save(true); return; }
    var total = null;
    if (res.statusCode === 206) {
      var m = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
      if (m) total = Number(m[1]);
      link.acceptRanges = true;
    } else if (res.statusCode === 200) {
      total = res.headers['content-length'] ? Number(res.headers['content-length']) : null;
      link.acceptRanges = /bytes/.test(res.headers['accept-ranges'] || '');
    } else {
      link.status = 'new'; link.error = 'Server replied HTTP ' + res.statusCode;
      try { req.abort(); } catch (e) {} res.resume(); save(true); return;
    }
    link.total = total;
    link.contentType = res.headers['content-type'] || '';
    link.serverName = nameFromHeaders(res, res.finalUrl);
    link.insecureTLS = res.insecureTLS || undefined;
    link.error = null;
    if (/text\/html/i.test(link.contentType)) link.warning = 'This looks like a web page, not a file. Paste the direct file link.';
    link.status = 'new';
    try { req.abort(); } catch (e) {}
    res.resume();
    save(true);
  });
}

// ------------------------------------------------------------------ downloads
function enqueue(link) {
  if (S.active === link.id || S.queue.indexOf(link.id) >= 0) return;
  link.error = null;
  link.status = 'queued';
  S.queue.push(link.id);
  pump();
}

function pump() {
  if (S.active) return;
  var id = S.queue.shift();
  if (!id) return;
  var link = findLink(id);
  if (!link) return pump();
  run(link, 0);
}

function fail(link, msg) {
  link.status = 'error';
  link.error = msg;
  link.speed = 0;
  if (S.active === link.id) { S.active = null; current = null; }
  save();
  setTimeout(pump, 500);
}

function run(link, attempt) {
  var d = drive();
  if (!d) return fail(link, 'No USB drive connected');
  try { mkdirp(d.downloads); } catch (e) { return fail(link, 'Cannot create Downloads folder: ' + (e.code || e.message)); }
  S.active = link.id;
  link.status = 'downloading';
  link.speed = 0;
  var part = path.join(d.downloads, '.tvdl-' + link.id + '.part');
  var have = 0;
  try { have = fs.statSync(part).size; } catch (e) {}
  var headers = have > 0 ? { 'Range': 'bytes=' + have + '-' } : {};

  var req = request(link.url, { headers: headers }, function (err, res, r) {
    if (err) return retryOrFail(err.message);
    if (S.active !== link.id) { res.resume(); return; } // stopped meanwhile
    var append = false;
    if (res.statusCode === 206 && have > 0) {
      append = true;
      var m = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
      if (m) link.total = Number(m[1]);
    } else if (res.statusCode === 200) {
      have = 0;
      link.total = res.headers['content-length'] ? Number(res.headers['content-length']) : link.total || null;
    } else if (res.statusCode === 416 && have > 0 && link.total && have >= link.total) {
      res.resume();
      return complete(link, part, d);
    } else {
      res.resume();
      return fail(link, 'Server replied HTTP ' + res.statusCode);
    }
    link.contentType = res.headers['content-type'] || link.contentType;
    if (!link.serverName || res.statusCode === 200) link.serverName = nameFromHeaders(res, res.finalUrl) || link.serverName;
    if (res.insecureTLS) link.insecureTLS = true;
    if (/text\/html/i.test(link.contentType) && !append) {
      res.resume();
      return fail(link, 'The link returned a web page, not a file. Use the direct download link.');
    }
    if (d.fs === 'vfat' && link.total && link.total > FAT32_MAX) {
      res.resume();
      return fail(link, 'File is ' + gb(link.total) + ' but the USB drive is FAT32 (max 4 GB per file). Use an exFAT drive.');
    }

    var out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    current = { req: r, res: res, out: out, link: link };
    link.bytes = have;
    var lastBytes = have, lastT = now();
    var ticker = setInterval(function () {
      var t = now();
      link.speed = Math.round((link.bytes - lastBytes) * 1000 / Math.max(1, t - lastT));
      lastBytes = link.bytes; lastT = t;
      save(true);
    }, 1000);
    var ended = false;
    res.on('data', function (c) { link.bytes += c.length; });
    res.on('error', function (e) { clearInterval(ticker); if (!ended) { ended = true; out.end(); retryOrFail(e.message); } });
    res.on('aborted', function () { clearInterval(ticker); if (!ended && S.active === link.id) { ended = true; out.end(function () { retryOrFail('Connection dropped'); }); } });
    out.on('error', function (e) {
      clearInterval(ticker); ended = true;
      try { r.abort(); } catch (x) {}
      fail(link, 'Write failed: ' + (e.code || e.message) + (e.code === 'ENOSPC' ? ' (USB drive is full)' : ''));
    });
    out.on('finish', function () {
      clearInterval(ticker);
      if (ended || S.active !== link.id) return;
      ended = true;
      if (link.total && link.bytes < link.total) return retryOrFail('Download ended early');
      complete(link, part, d);
    });
    res.pipe(out);
  });

  function retryOrFail(msg) {
    if (S.active !== link.id) return;
    if (attempt < 3) {
      link.status = 'retrying';
      link.error = msg + ' - retrying (' + (attempt + 1) + '/3)';
      current = null;
      setTimeout(function () { if (S.active === link.id) run(link, attempt + 1); }, 5000);
    } else fail(link, msg);
  }
}

function complete(link, part, d) {
  try {
    var dest = uniquePath(d.downloads, finalName(link));
    fs.renameSync(part, dest);
    link.file = path.basename(dest);
    link.status = 'done';
    link.error = null;
    link.speed = 0;
    link.completedAt = now();
    try { link.bytes = link.total = fs.statSync(dest).size; } catch (e) {}
  } catch (e) {
    link.status = 'error';
    link.error = 'Could not finish file: ' + (e.code || e.message);
  }
  S.active = null;
  current = null;
  save();
  pump();
}

function stop(link) {
  var qi = S.queue.indexOf(link.id);
  if (qi >= 0) S.queue.splice(qi, 1);
  if (S.active === link.id) {
    S.active = null;
    if (current) {
      try { current.req.abort(); } catch (e) {}
      try { current.out.end(); } catch (e) {}
    }
    current = null;
  }
  if (link.status !== 'done') link.status = 'stopped';
  link.speed = 0;
  save();
  pump();
}

function removeLink(id) {
  var link = findLink(id);
  if (!link) return false;
  stop(link);
  var d = drive();
  if (d) { try { fs.unlinkSync(path.join(d.downloads, '.tvdl-' + id + '.part')); } catch (e) {} }
  S.links = S.links.filter(function (l) { return l.id !== id; });
  save();
  return true;
}

function addLinks(text, name) {
  var lines = String(text || '').split(/[\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  var added = [], errors = [];
  lines.forEach(function (u) {
    if (!/^https?:\/\/[^\s]+$/i.test(u) || u.length > 4000) { errors.push(u.slice(0, 80) + ': not a valid http(s) link'); return; }
    var link = { id: newId(), url: u, name: lines.length === 1 && name ? String(name).slice(0, 180) : '', addedAt: now(), status: 'new', bytes: 0, total: null };
    S.links.unshift(link);
    added.push(link);
    inspect(link);
  });
  save();
  return { added: added.length, errors: errors };
}

function gb(n) { return (n / 1073741824).toFixed(2) + ' GB'; }

// ------------------------------------------------------------------ files on the drive
function listFiles() {
  var d = drive();
  if (!d) return [];
  try {
    return fs.readdirSync(d.downloads).filter(function (n) { return n.charAt(0) !== '.'; }).map(function (n) {
      var s = fs.statSync(path.join(d.downloads, n));
      return { name: n, size: s.size, mtime: s.mtime.getTime(), dir: s.isDirectory() };
    }).filter(function (f) { return !f.dir; }).sort(function (a, b) { return b.mtime - a.mtime; });
  } catch (e) { return []; }
}

function safeFile(name) {
  var d = drive();
  if (!d || !name || /[\/\\]/.test(name) || name === '..' || name.charAt(0) === '.') return null;
  return path.join(d.downloads, name);
}

var MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ts': 'video/mp2t', '.jpg': 'image/jpeg', '.png': 'image/png' };

function serveFile(req, res, p) {
  fs.stat(p, function (err, st) {
    if (err) { res.writeHead(404, cors()); return res.end(); }
    var h = cors({ 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' });
    var m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      var start = m[1] ? parseInt(m[1], 10) : Math.max(0, st.size - parseInt(m[2], 10));
      var end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size) { h['Content-Range'] = 'bytes */' + st.size; res.writeHead(416, h); return res.end(); }
      end = Math.min(end, st.size - 1);
      h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      h['Content-Length'] = end - start + 1;
      res.writeHead(206, h);
      fs.createReadStream(p, { start: start, end: end }).pipe(res);
    } else {
      h['Content-Length'] = st.size;
      res.writeHead(200, h);
      fs.createReadStream(p).pipe(res);
    }
  });
}

// ------------------------------------------------------------------ network info + mDNS
function lanIP() {
  var ifs = os.networkInterfaces(), best = null;
  Object.keys(ifs).forEach(function (n) {
    ifs[n].forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) {
        if (!best || /^(wlan|eth|en)/.test(n)) best = a.address;
      }
    });
  });
  return best;
}

function encodeName(name) {
  var parts = name.split('.'), bufs = [];
  parts.forEach(function (p) { var b = new Buffer(p, 'utf8'); var l = new Buffer(1); l[0] = b.length; bufs.push(l, b); });
  bufs.push(new Buffer([0]));
  return Buffer.concat(bufs);
}

function readName(buf, off) {
  var labels = [], jumped = false, end = off, guard = 0;
  while (guard++ < 64) {
    var len = buf[off];
    if (len === undefined) return null;
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    if (len === 0) { if (!jumped) end = off + 1; break; }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), end: end };
}

function aRecord(ip, flush) {
  var name = encodeName(MDNS_NAME);
  var rr = new Buffer(10);
  rr.writeUInt16BE(1, 0);                       // type A
  rr.writeUInt16BE(flush ? 0x8001 : 0x0001, 2); // class IN (+cache-flush)
  rr.writeUInt32BE(120, 4);                     // TTL
  rr.writeUInt16BE(4, 8);
  var ipb = new Buffer(ip.split('.').map(Number));
  return Buffer.concat([name, rr, ipb]);
}

function startMDNS() {
  var sock;
  try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
  catch (e) { S.mdns = { status: 'unavailable: ' + e.message }; return; }
  sock.on('error', function (e) { S.mdns = { status: 'failed: ' + (e.code || e.message) }; log('mDNS ' + S.mdns.status); try { sock.close(); } catch (x) {} });
  sock.on('message', function (msg, rinfo) {
    try {
      if (msg.length < 12 || (msg.readUInt16BE(2) & 0x8000)) return; // ignore responses
      var qd = msg.readUInt16BE(4), off = 12;
      for (var i = 0; i < qd; i++) {
        var q = readName(msg, off);
        if (!q) return;
        var qtype = msg.readUInt16BE(q.end), qclass = msg.readUInt16BE(q.end + 2);
        var qStart = off;
        off = q.end + 4;
        if (q.name !== MDNS_NAME || (qtype !== 1 && qtype !== 255)) continue;
        var ip = lanIP();
        if (!ip) return;
        var legacy = rinfo.port !== 5353;
        var hdr = new Buffer(12);
        hdr.fill(0);
        if (legacy) hdr.writeUInt16BE(msg.readUInt16BE(0), 0);
        hdr.writeUInt16BE(0x8400, 2);
        hdr.writeUInt16BE(legacy ? 1 : 0, 4);
        hdr.writeUInt16BE(1, 6);
        var parts = [hdr];
        if (legacy) parts.push(msg.slice(qStart, off));
        parts.push(aRecord(ip, !legacy));
        var pkt = Buffer.concat(parts);
        if (legacy) sock.send(pkt, 0, pkt.length, rinfo.port, rinfo.address);
        else if (qclass & 0x8000) sock.send(pkt, 0, pkt.length, rinfo.port, rinfo.address);   // QU: unicast reply
        else sock.send(pkt, 0, pkt.length, 5353, '224.0.0.251');
        S.mdns.lastQuery = now();
      }
    } catch (e) { /* malformed packet */ }
  });
  sock.bind(5353, function () {
    try {
      sock.addMembership('224.0.0.251');
      sock.setMulticastTTL(255);
      S.mdns = { status: 'ok' };
      announce(sock);
      setTimeout(function () { announce(sock); }, 1000);
      setInterval(function () { announce(sock); }, 60000);
    } catch (e) { S.mdns = { status: 'failed: ' + e.message }; }
  });
}

function announce(sock) {
  var ip = lanIP();
  if (!ip) return;
  var hdr = new Buffer(12);
  hdr.fill(0);
  hdr.writeUInt16BE(0x8400, 2);
  hdr.writeUInt16BE(1, 6);
  var pkt = Buffer.concat([hdr, aRecord(ip, true)]);
  try { sock.send(pkt, 0, pkt.length, 5353, '224.0.0.251'); } catch (e) {}
}

// ------------------------------------------------------------------ HTTP servers
function cors(h) { h = h || {}; h['Access-Control-Allow-Origin'] = '*'; return h; }
function json(res, code, obj) { res.writeHead(code, cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })); res.end(JSON.stringify(obj)); }

function readBody(req, cb) {
  var chunks = [], size = 0;
  req.on('data', function (c) { size += c.length; if (size > 65536) { req.destroy(); return; } chunks.push(c); });
  req.on('end', function () {
    var raw = Buffer.concat(chunks).toString('utf8');
    var ct = req.headers['content-type'] || '';
    if (/json/.test(ct)) { try { return cb(JSON.parse(raw)); } catch (e) { return cb({}); } }
    cb(querystring.parse(raw));
  });
}

function publicLink(l) {
  return { id: l.id, url: l.url, name: l.name, addedAt: l.addedAt, status: l.status, total: l.total, bytes: l.bytes,
    speed: l.speed, error: l.error, warning: l.warning, file: l.file, serverName: l.serverName, contentType: l.contentType,
    acceptRanges: l.acceptRanges, insecureTLS: l.insecureTLS };
}

function lanURL() {
  var port = S.lan.port === 80 ? '' : ':' + S.lan.port;
  return { ip: S.lan.ip ? 'http://' + S.lan.ip + port + '/' : null, mdns: 'http://' + MDNS_NAME + port + '/' };
}

function state() {
  var d = drive();
  S.lan.ip = lanIP();
  return {
    drive: d ? { name: d.name, fs: d.fs } : null,
    lan: { port: S.lan.port, error: S.lan.error, urls: lanURL() },
    mdns: S.mdns,
    tls: S.ca ? 'bundle' : 'builtin',
    active: S.active,
    links: S.links.map(publicLink)
  };
}

// LAN server: add/list/remove links only.
function lanHandler(req, res) {
  var u = urlLib.parse(req.url, true);
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(WEB_PAGE);
  }
  if (req.method === 'GET' && u.pathname === '/api/links') {
    var d = drive();
    return json(res, 200, { drive: d ? { name: d.name, fs: d.fs } : null, links: S.links.map(publicLink) });
  }
  if (req.method === 'POST' && u.pathname === '/api/links') {
    return readBody(req, function (b) { json(res, 200, addLinks(b.url || b.urls, b.name)); });
  }
  var m = /^\/api\/links\/([a-z0-9]+)\/delete$/.exec(u.pathname || '');
  if (req.method === 'POST' && m) return json(res, removeLink(m[1]) ? 200 : 404, { ok: true });
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  json(res, 404, { error: 'not found' });
}

// Local server: everything the TV UI needs.
function localHandler(req, res) {
  var u = urlLib.parse(req.url, true);
  var p = u.pathname || '';
  if (req.method === 'OPTIONS') { res.writeHead(204, cors({ 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' })); return res.end(); }
  if (p === '/state') return json(res, 200, state());
  if (p === '/files') return json(res, 200, { files: listFiles() });
  if (p === '/file') {
    var f = safeFile(u.query.name);
    if (!f) return json(res, 400, { error: 'bad name' });
    return serveFile(req, res, f);
  }
  if (req.method === 'POST' && p === '/files/delete') {
    var fd = safeFile(u.query.name);
    if (!fd) return json(res, 400, { error: 'bad name' });
    try { fs.unlinkSync(fd); } catch (e) { return json(res, 500, { error: e.code || e.message }); }
    S.links.forEach(function (l) { if (l.file === u.query.name) { l.file = null; l.status = 'deleted'; } });
    save();
    return json(res, 200, { ok: true });
  }
  var m = /^\/links\/([a-z0-9]+)\/(download|stop|delete)$/.exec(p);
  if (req.method === 'POST' && m) {
    var link = findLink(m[1]);
    if (!link) return json(res, 404, { error: 'no such link' });
    if (m[2] === 'download') { link.bytes = link.status === 'done' ? 0 : link.bytes; enqueue(link); }
    else if (m[2] === 'stop') stop(link);
    else removeLink(link.id);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'not found' });
}

function listenLAN(i) {
  if (i >= LAN_PORTS.length) { S.lan.error = 'no LAN port available'; return; }
  var srv = http.createServer(lanHandler);
  srv.on('error', function (e) {
    log('LAN port ' + LAN_PORTS[i] + ' failed: ' + e.code);
    if (e.code === 'EADDRINUSE' && S.lan.port) return;
    listenLAN(i + 1);
  });
  srv.listen(LAN_PORTS[i], LAN_HOST, function () { S.lan.port = LAN_PORTS[i]; S.lan.error = null; log('LAN page on port ' + S.lan.port); });
}

// ------------------------------------------------------------------ web page served to phones/laptops
var WEB_PAGE = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>TV Downloads</title><style>',
  'body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;background:#0f1418;color:#e6e6e6}',
  'main{max-width:760px;margin:0 auto;padding:20px}h1{font-size:22px;color:#f2b84b;margin:6px 0 4px}',
  '.sub{color:#8a959f;font-size:13px;margin-bottom:18px}',
  'textarea,input{width:100%;box-sizing:border-box;background:#182027;color:#eee;border:1px solid #2b3640;border-radius:8px;padding:10px;font:inherit}',
  'textarea{min-height:90px}label{display:block;font-size:13px;color:#9aa4ad;margin:12px 0 4px}',
  'button{background:#f2b84b;color:#111;border:0;border-radius:8px;padding:10px 18px;font-weight:600;font-size:15px;margin-top:12px;cursor:pointer}',
  '.msg{margin-top:10px;font-size:14px}.err{color:#ff8a80}.ok{color:#7fd17f}',
  'h2{font-size:17px;margin:28px 0 8px}.item{background:#182027;border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;gap:10px;align-items:flex-start}',
  '.item .main{flex:1;min-width:0}.name{font-weight:600;word-break:break-word}.url{font-size:12px;color:#8a959f;word-break:break-all;margin-top:2px}',
  '.meta{font-size:13px;margin-top:6px;color:#b9c2ca}.st{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;margin-right:6px;background:#2b3640}',
  '.st.done{background:#24502a}.st.downloading,.st.retrying{background:#5a4a1a}.st.error{background:#5a1f1f}',
  '.del{background:#2b3640;color:#ddd;margin:0;padding:6px 12px;font-size:13px}.bar{height:4px;background:#2b3640;border-radius:2px;margin-top:6px}',
  '.bar i{display:block;height:4px;background:#f2b84b;border-radius:2px}.warn{color:#ffcc80;font-size:13px;margin-top:4px}',
  '</style></head><body><main>',
  '<h1>TV Downloads</h1><div class="sub">Add direct download links here. Start downloads from the TV. Files go to the TV\'s USB drive.</div>',
  '<form id="f"><label>Link(s) - one per line</label><textarea id="urls" placeholder="https://example.org/video.mp4" required></textarea>',
  '<label>Name (optional, single link only)</label><input id="name" placeholder="My video">',
  '<button type="submit">Add to TV</button><div id="msg" class="msg"></div></form>',
  '<h2>Links on the TV <span id="drive" class="sub"></span></h2><div id="list"></div></main>',
  '<script>',
  'function fmt(n){if(n==null)return"?";var u=["B","KB","MB","GB"],i=0;while(n>=1024&&i<3){n/=1024;i++}return n.toFixed(i?1:0)+" "+u[i]}',
  'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
  'function load(){fetch("/api/links").then(function(r){return r.json()}).then(function(d){',
  ' document.getElementById("drive").textContent=d.drive?"· USB: "+d.drive.name+(d.drive.fs?" ("+d.drive.fs+")":""):"· no USB drive connected";',
  ' var h="";d.links.forEach(function(l){var pct=l.total?Math.min(100,Math.round(100*l.bytes/l.total)):0;',
  '  h+="<div class=item><div class=main><div class=name>"+esc(l.file||l.name||l.serverName||(l.status=="checking"?"(checking…)":l.url))+"</div><div class=url>"+esc(l.url)+"</div>"+',
  '  "<div class=meta><span class=\\"st "+l.status+"\\">"+l.status+"</span>"+(l.total?fmt(l.total):"size unknown")+(l.status=="downloading"?" · "+pct+"% · "+fmt(l.speed||0)+"/s":"")+"</div>"+',
  '  (l.status=="downloading"?"<div class=bar><i style=\\"width:"+pct+"%\\"></i></div>":"")+(l.error?"<div class=warn>"+esc(l.error)+"</div>":l.warning?"<div class=warn>"+esc(l.warning)+"</div>":"")+',
  '  "</div><button class=del data-id=\\""+l.id+"\\">Remove</button></div>"});',
  ' document.getElementById("list").innerHTML=h||"<div class=sub>No links yet.</div>"})}',
  'document.getElementById("list").onclick=function(e){var id=e.target.getAttribute("data-id");if(!id)return;if(!confirm("Remove this link from the TV list?"))return;',
  ' fetch("/api/links/"+id+"/delete",{method:"POST"}).then(load)};',
  'document.getElementById("f").onsubmit=function(e){e.preventDefault();var m=document.getElementById("msg");',
  ' fetch("/api/links",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({urls:document.getElementById("urls").value,name:document.getElementById("name").value})})',
  ' .then(function(r){return r.json()}).then(function(d){m.className="msg "+(d.errors.length?"err":"ok");m.textContent="Added "+d.added+(d.errors.length?" · "+d.errors.join("; "):"");',
  ' if(d.added){document.getElementById("urls").value="";document.getElementById("name").value=""}load()}).catch(function(){m.className="msg err";m.textContent="Could not reach the TV"})};',
  'load();setInterval(load,3000);',
  '</script></body></html>'
].join('\n');

// ------------------------------------------------------------------ start
load();
loadCA();
listenLAN(0);
http.createServer(localHandler).on('error', function (e) { log('local port failed: ' + e.code); }).listen(LOCAL_PORT, '127.0.0.1');
if (MDNS_ENABLED) startMDNS(); else S.mdns = { status: 'disabled' };
setInterval(function () { S.lan.ip = lanIP(); }, 30000);
log('service started');
