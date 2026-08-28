// Minimal raw WebSocket client (client frames must be masked per RFC 6455).
// Deliberately hand-rolled: it keeps `npm test` dependency-free, and it doubles
// as an executable spec of what the relay has to accept.
import net from 'node:net';
import crypto from 'node:crypto';

export function wsClient({ port, path = '/ws?room=lobby', host = '127.0.0.1' }) {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, host);
    const q = [];
    let handshook = false;
    let buf = Buffer.alloc(0);
    const waiters = [];

    const push = (m) => {
        const w = waiters.shift();
        if (w) w(m); else q.push(m);
    };

    const parse = () => {
        for (;;) {
            if (buf.length < 2) return;
            const opcode = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            if (buf.length < off + len) return;
            const payload = buf.subarray(off, off + len);
            buf = buf.subarray(off + len);
            if (opcode === 0x1) push(JSON.parse(payload.toString('utf8')));
            else if (opcode === 0x2) push(payload);
        }
    };

    sock.on('data', (d) => {
        if (!handshook) {
            const idx = d.indexOf('\r\n\r\n');
            if (idx < 0) return;
            const head = d.subarray(0, idx).toString();
            if (!/101/.test(head)) { sock.destroy(new Error('handshake failed: ' + head.split('\r\n')[0])); return; }
            handshook = true;
            buf = d.subarray(idx + 4);
            parse();
            return;
        }
        buf = Buffer.concat([buf, d]);
        parse();
    });
    sock.on('close', () => { while (waiters.length) waiters.shift()(null); });

    sock.on('connect', () => {
        sock.write([
            `GET ${path} HTTP/1.1`,
            `Host: ${host}:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '\r\n',
        ].join('\r\n'));
    });

    const frame = (opcode, payload) => {
        const len = payload.length;
        let header;
        if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
        else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
        else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
        header[0] = 0x80 | opcode;
        const mask = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
        sock.write(Buffer.concat([header, mask, masked]));
    };

    return {
        sock,
        send(obj) { frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); },
        sendBin(buf2) { frame(0x2, Buffer.from(buf2)); },
        next(timeout = 1500) {
            if (q.length) return Promise.resolve(q.shift());
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error('timeout waiting for a message')); }, timeout);
                const w = (m) => { clearTimeout(t); resolve(m); };
                waiters.push(w);
            });
        },
        /** Resolve with the next message matching pred, skipping the rest. */
        async until(pred, timeout = 2500) {
            const end = Date.now() + timeout;
            for (;;) {
                const left = end - Date.now();
                if (left <= 0) throw new Error('no matching message');
                const m = await this.next(left);
                if (m && pred(m)) return m;
            }
        },
        /** Resolves with the relay's `welcome` message (the handshake we care about). */
        join(timeout = 3000) { return this.until((m) => m.t === 'welcome' || m.t === 'err', timeout); },
        close() { sock.destroy(); },
    };
}
