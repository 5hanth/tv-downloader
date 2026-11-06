// Local preview on the Mac. A fake /opt/media lives in dev/media/USBDriveA1.
//   node dev/serve.js   →  TV UI:    http://127.0.0.1:8092/app/index.html
//                          Web page: http://127.0.0.1:8090/  (LAN port; 80 is skipped in dev)
'use strict';
var http = require('http'), fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var media = process.env.TVDL_MEDIA_ROOT || path.join(__dirname, 'media');
fs.mkdirSync(path.join(media, 'USBDriveA1'), { recursive: true });
process.env.TVDL_MEDIA_ROOT = media;
process.env.TVDL_LAN_PORTS = process.env.TVDL_LAN_PORTS || '8090';
process.env.TVDL_LAN_HOST = process.env.TVDL_LAN_HOST || '127.0.0.1'; // don't expose the dev copy on the LAN
process.env.TVDL_NO_MDNS = process.env.TVDL_NO_MDNS || '1';          // don't announce tv-dl.local from the Mac
process.env.TVDL_CA_URL = process.env.TVDL_CA_URL || 'https://raw.githubusercontent.com/curl/curl/master/does-not-exist'; // use Node's own CAs in dev
require('../service/service.js');

http.createServer(function (req, res) {
  var file = path.join(root, path.normalize(decodeURIComponent(req.url.split('?')[0])));
  if (file.indexOf(root) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': /\.html$/.test(file) ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(data);
  });
}).listen(8092, '127.0.0.1', function () { console.log('TV UI: http://127.0.0.1:8092/app/index.html  ·  web page: http://127.0.0.1:8090/'); });
