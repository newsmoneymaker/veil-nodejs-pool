// Mock of veild for the pool tests: JSON-RPC over HTTP with getblocktemplate {"algo":"randomx"}, rxrpcsb and getblockhash.
// Blocks are verified with the real RandomX helper, so a solution has to be real.
// node mock-veil-node.js <port> <bits hex> [hasherPath]
const http = require('http');
const crypto = require('crypto');
const {spawn} = require('child_process');
const path = require('path');

const PORT = parseInt(process.argv[2] || '25556');
let BITS = parseInt(process.argv[3] || '1f00ffff', 16);
const HASHER = process.argv[4] || path.join(__dirname, '..', 'hasher', 'veilhash');
const KEY_DISPLAY = crypto.createHash('sha256').update('veil-test-key').digest('hex');   // rxrpcseed as the node prints it
const KEY_RAW = Buffer.from(KEY_DISPLAY, 'hex').reverse().toString('hex');

function compactToTarget (bits) {
	let exponent = bits >>> 24, mantissa = BigInt(bits & 0x007fffff);
	return exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3));
}
let TARGET = compactToTarget(BITS);

let height = 4000000;
let tip = crypto.randomBytes(32).toString('hex');           // display order
const templates = new Map();
const blocks = [];
let submitted = 0;

// verification helper
const hasher = spawn(HASHER, ['--threads', '1', '--light']);
hasher.stdout.setEncoding('utf8');
let hbuf = '', hwait = {}, keyOk = false, keyWaiters = [];
hasher.stdout.on('data', function (d) {
	hbuf += d; let i;
	while ((i = hbuf.indexOf('\n')) !== -1) {
		const parts = hbuf.slice(0, i).split(' '); hbuf = hbuf.slice(i + 1);
		if (parts[0] === 'K') { keyOk = true; keyWaiters.forEach(f => f()); keyWaiters = []; }
		else if (parts[0] === 'H' && hwait[parts[1]]) { hwait[parts[1]](parts[2]); delete hwait[parts[1]]; }
	}
});
hasher.stdin.write('K ' + KEY_RAW + '\n');
let hid = 0;
function hashBlob (hex, cb) {
	const start = () => { const id = 'm' + (++hid); hwait[id] = cb; hasher.stdin.write('H ' + id + ' ' + hex + '\n'); };
	keyOk ? start() : keyWaiters.push(start);
}

function makeHeader () {
	const b = Buffer.alloc(148);
	b.writeUInt32LE(0x20000000 | (1 << 25), 0);                          // version with the RandomX flag
	Buffer.from(tip, 'hex').reverse().copy(b, 4);                       // hashPrevBlock (internal order)
	crypto.randomBytes(32).copy(b, 36);                                 // merkle root
	crypto.randomBytes(32).copy(b, 68);                                 // witness merkle root
	crypto.randomBytes(32).copy(b, 100);                                // accumulators
	b.writeUInt32LE(Math.floor(Date.now() / 1000), 132);                // time
	b.writeUInt32LE(BITS, 136);                                         // bits
	b.writeUInt32LE(0, 140);                                            // nonce
	b.writeUInt32LE(height + 1, 144);                                   // height
	return b.toString('hex');
}

let currentHeader = makeHeader();

function handle (method, params, cb) {
	if (method === 'getblocktemplate') {
		if (!templates.has(currentHeader)) templates.set(currentHeader, {height: height + 1, tip});
		return cb(null, {
			rxrpcheader: currentHeader, rxrpcseed: KEY_DISPLAY, height: height + 1,
			bits: BITS.toString(16).padStart(8, '0'), previousblockhash: tip,
			target: TARGET.toString(16).padStart(64, '0'), mining_disabled: false
		});
	}
	if (method === 'rxrpcsb') {
		const [header, , nonceHex] = params;
		const tpl = templates.get(header);
		if (!tpl) return cb({code: -8, message: 'Block header not found in block data'});
		const nonce = parseInt(nonceHex, 16);
		const b = Buffer.from(header, 'hex'); b.writeUInt32LE(nonce >>> 0, 140);
		submitted++;
		return hashBlob(b.toString('hex'), function (hashHex) {
			if (BigInt('0x' + hashHex) > TARGET) return cb({code: -25, message: 'Block does not solve the boundary'});
			if (tpl.height !== height + 1) return cb(null, 'inconclusive');
			height = tpl.height;
			tip = crypto.createHash('sha256').update(b).digest('hex');
			blocks.push({height, hash: tip, header, nonce});
			currentHeader = makeHeader();
			cb(null, true);
		});
	}
	if (method === 'getblockcount') return cb(null, height);
	if (method === 'getbestblockhash') return cb(null, tip);
	if (method === 'getblockheader') return cb(null, {hash: tip, height, time: Math.floor(Date.now() / 1000) - 30, difficulty: 1234.5});
	if (method === 'getblockhash') {
		const b = blocks.find(x => x.height === params[0]);
		return b ? cb(null, b.hash) : cb({code: -8, message: 'Block height out of range'});
	}
	if (method === 'mock_setbits') {           // change the network difficulty (a new header at the same height)
		BITS = parseInt(params[0], 16); TARGET = compactToTarget(BITS); currentHeader = makeHeader();
		return cb(null, true);
	}
	if (method === 'mock_state') return cb(null, {height, tip, blocks: blocks.length, submitted});
	cb({code: -32601, message: 'Method not found'});
}

http.createServer(function (req, res) {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', function () {
		let msg; try { msg = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
		handle(msg.method, msg.params || [], function (err, result) {
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end(JSON.stringify({result: err ? null : result, error: err || null, id: msg.id}));
		});
	});
}).listen(PORT, '127.0.0.1', () => console.log('mock veild on', PORT, 'bits', BITS.toString(16), 'target hashes ~', Number((1n << 256n) / TARGET)));
