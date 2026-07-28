// legacy-uploader.js — uploads render artifacts to the asset store.
// Runs in the Electron main process. Called from ~40 sites.
/* eslint-disable */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var https = require('https');
var EventEmitter = require('events').EventEmitter;

var UPLOAD_HOST = process.env.ASSET_HOST || 'assets.internal';
var activeUploads = {};
var uploadCounter = 0;
var globalRetryDelay = 500;

function Uploader(opts) {
  EventEmitter.call(this);
  opts = opts || {};
  this.concurrency = opts.concurrency || 3;
  this.queue = [];
  this.running = 0;
  this.tokenProvider = opts.tokenProvider; // may be undefined; then we read token.txt
  this.tmpDir = opts.tmpDir || path.join(process.cwd(), '.upload-tmp');
  if (!fs.existsSync(this.tmpDir)) fs.mkdirSync(this.tmpDir);
}
Uploader.prototype = Object.create(EventEmitter.prototype);

// Public API. Callback style: cb(err, result). Some call sites pass no cb.
Uploader.prototype.upload = function (filePath, meta, cb) {
  if (typeof meta === 'function') { cb = meta; meta = {}; }
  var self = this;
  var id = 'u' + (++uploadCounter);
  activeUploads[id] = { file: filePath, started: Date.now() };
  var job = function (done) {
    self._readToken(function (err, token) {
      if (err) { delete activeUploads[id]; if (cb) cb(err); return done(); }
      var stat;
      try { stat = fs.statSync(filePath); } catch (e) {
        delete activeUploads[id]; if (cb) cb(e); return done();
      }
      // files over 64MB get chunked through a temp copy, others buffered whole
      if (stat.size > 64 * 1024 * 1024) {
        var tmp = path.join(self.tmpDir, id + '.part');
        fs.copyFileSync(filePath, tmp);
        self._sendChunked(tmp, stat.size, token, meta, function (err2, res) {
          try { fs.unlinkSync(tmp); } catch (e) {}
          delete activeUploads[id];
          self.emit('done', id, err2);
          if (cb) cb(err2, res);
          done();
        });
      } else {
        var body = fs.readFileSync(filePath);
        self._send(body, token, meta, function (err2, res) {
          delete activeUploads[id];
          self.emit('done', id, err2);
          if (err2 && err2.code === 429) {
            globalRetryDelay = globalRetryDelay * 2;
            setTimeout(function () {
              self.upload(filePath, meta, cb); // re-enqueue from scratch
            }, globalRetryDelay);
            return done();
          }
          if (cb) cb(err2, res);
          done();
        });
      }
    });
  };
  this.queue.push(job);
  this._drain();
  return id; // callers use this with cancel(), see below
};

Uploader.prototype.cancel = function (id) {
  // best-effort: only removes from bookkeeping; in-flight requests finish
  delete activeUploads[id];
};

Uploader.prototype._drain = function () {
  var self = this;
  while (self.running < self.concurrency && self.queue.length) {
    var job = self.queue.shift();
    self.running++;
    job(function () {
      self.running--;
      setImmediate(function () { self._drain(); });
    });
  }
};

Uploader.prototype._readToken = function (cb) {
  if (this.tokenProvider) return this.tokenProvider(cb);
  fs.readFile(path.join(process.cwd(), 'token.txt'), 'utf8', function (err, t) {
    if (err) return cb(err);
    cb(null, t.trim());
  });
};

Uploader.prototype._send = function (body, token, meta, cb) {
  var digest = crypto.createHash('md5').update(body).digest('hex');
  var req = https.request({
    host: UPLOAD_HOST, method: 'POST', path: '/v2/assets',
    headers: {
      'authorization': 'Bearer ' + token,
      'x-digest': digest,
      'x-meta': JSON.stringify(meta || {}),
      'content-length': body.length
    }
  }, function (res) {
    var out = '';
    res.on('data', function (d) { out += d; });
    res.on('end', function () {
      if (res.statusCode === 429) { var e = new Error('rate limited'); e.code = 429; return cb(e); }
      if (res.statusCode >= 300) return cb(new Error('upload failed: ' + res.statusCode + ' ' + out));
      var parsed;
      try { parsed = JSON.parse(out); } catch (e) { parsed = { raw: out }; }
      cb(null, parsed);
    });
  });
  req.on('error', cb);
  req.end(body);
};

Uploader.prototype._sendChunked = function (tmpPath, size, token, meta, cb) {
  // 8MB chunks, sequential; server assembles by x-upload-id
  var CHUNK = 8 * 1024 * 1024;
  var uploadId = crypto.randomBytes(8).toString('hex');
  var offset = 0;
  var self = this;
  function next() {
    if (offset >= size) return cb(null, { uploadId: uploadId, size: size });
    var len = Math.min(CHUNK, size - offset);
    var buf = Buffer.alloc(len);
    var fd = fs.openSync(tmpPath, 'r');
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    self._send(buf, token, Object.assign({}, meta, {
      uploadId: uploadId, offset: offset, total: size
    }), function (err) {
      if (err) return cb(err);
      offset += len;
      next();
    });
  }
  next();
};

// module-level convenience used by most call sites
var defaultUploader = null;
module.exports = {
  Uploader: Uploader,
  getUploader: function (opts) {
    if (!defaultUploader) defaultUploader = new Uploader(opts);
    return defaultUploader; // NOTE: opts of later callers silently ignored
  },
  activeUploads: activeUploads,
  _resetForTests: function () { defaultUploader = null; }
};
