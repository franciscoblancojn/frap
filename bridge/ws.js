'use strict';
// WebSocket mínimo (RFC 6455) sin dependencias: frames de texto, ping/pong y close.
// Lo usa el bridge (lado servidor) y los tests (lado cliente).

const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

class WsConn extends EventEmitter {
  constructor(socket, { mask = false, head } = {}) {
    super();
    this.socket = socket;
    this.mask = mask; // los clientes enmascaran, el servidor no
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this._parse();
    });
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    if (this.buf.length) setImmediate(() => this._parse());
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._send(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', msg);
        }
      }
    }
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload, this.mask));
  }

  send(text) {
    this._send(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    if (this.closed) return;
    try { this._send(0x8, Buffer.alloc(0)); } catch (_) { /* ignore */ }
    this.socket.end();
    this._closed();
  }
}

// Completa el handshake del lado servidor. Devuelve WsConn.
function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  return new WsConn(socket, { mask: false, head });
}

// Cliente mínimo (para tests). Resuelve con WsConn o rechaza con el status HTTP.
function connect(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    socket.once('connect', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`
      );
    });
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onData);
      const head = buf.subarray(0, idx).toString();
      const status = Number(head.split(' ')[1]);
      if (status !== 101) {
        socket.destroy();
        reject(Object.assign(new Error(`HTTP ${status}`), { status }));
        return;
      }
      resolve(new WsConn(socket, { mask: true, head: buf.subarray(idx + 4) }));
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

module.exports = { upgrade, connect, acceptKey, encodeFrame, WsConn };
