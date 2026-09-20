// Checks the hashing method of the pool (RandomX over SHA-256d of the 148 byte header, key = block hash at ((height-64)/2048)*2048)
// against real Veil mainnet blocks: the hash must equal the `randomxproofofworkhash` reported by veild and meet the block's target.
// Needs the helper: make -C hasher RANDOMX=...   Run: node test/test-real-blocks.js
const {spawn} = require('child_process');
const path = require('path');
const data = require('./real-blocks.json');
const helper = spawn(path.join(__dirname, '..', 'hasher', 'veilhash'), ['--threads', '1', '--light'], {stdio: ['pipe', 'pipe', 'inherit']});
helper.stdout.setEncoding('utf8');
let buf = '', waiting = null;
helper.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (waiting) { const w = waiting; waiting = null; w(line.split(' ')); } } });
const ask = line => new Promise(res => { waiting = res; helper.stdin.write(line + '\n'); });
const compactToTarget = bits => { const e = bits >>> 24, m = BigInt(bits & 0x7fffff); return e <= 3 ? m >> BigInt(8 * (3 - e)) : m << BigInt(8 * (e - 3)); };
(async () => {
	let failed = 0, key = null;
	for (const b of data.blocks) {
		const keyRaw = Buffer.from(b.key_block_hash, 'hex').reverse().toString('hex');
		if (keyRaw !== key) { key = keyRaw; await ask('K ' + keyRaw); }
		const r = await ask('H x ' + b.randomx_input_hex);
		const hash = r[2];
		const meets = BigInt('0x' + hash) <= compactToTarget(parseInt(b.bits, 16));
		const ok = hash === b.randomxproofofworkhash && meets;
		if (!ok) failed++;
		console.log((ok ? 'PASS  ' : 'FAIL  ') + 'block ' + b.height + ' hash ' + hash.slice(0, 16) + '... equals the node\'s and meets the target');
	}
	helper.stdin.write('Q\n');
	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})();
