// Integration test: mock veild + the pool (module pool) + a miner client that really mines (RandomX).
// Needs a throwaway redis as in test/config.test.json (it is flushed!). Run: node test/test-veil-pool.js
const {spawn} = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const http = require('http');
const redis = require(path.join(__dirname, '../node_modules/redis'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test.json'), 'utf8'));

const ADDRESS = process.env.TEST_ADDRESS;         // a valid bv1q... address
if (!ADDRESS) { console.log('set TEST_ADDRESS to a valid Veil basecoin address'); process.exit(1); }
const HARD = '1d00ffff', EASY = '2000da74';       // network target 2^32 hashes (no block) / ~300 hashes
const HASHER = path.join(__dirname, '..', 'hasher', 'veilhash');
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + extra : '')); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
const cleanup = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', cleanup);

function rpc (method, params) {
	return new Promise(resolve => {
		const body = JSON.stringify({method, params: params || [], id: 1});
		const req = http.request({host: '127.0.0.1', port: cfg.node.port, method: 'POST', headers: {'Content-Length': Buffer.byteLength(body)}}, res => {
			let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d).result));
		});
		req.end(body);
	});
}

// the miner's own hasher
const mh = spawn(HASHER, ['--threads', '2', '--light'], {stdio: ['pipe', 'pipe', 'inherit']}); procs.push(mh);
mh.stdout.setEncoding('utf8');
let mbuf = '', mwait = {}, mkey = null, mid = 0;
mh.stdout.on('data', d => { mbuf += d; let i; while ((i = mbuf.indexOf('\n')) !== -1) { const p = mbuf.slice(0, i).split(' '); mbuf = mbuf.slice(i + 1); if (p[0] === 'K' && mkey) mkey(); else if (p[0] === 'H' && mwait[p[1]]) { mwait[p[1]](p[2]); delete mwait[p[1]]; } } });
const setKey = raw => new Promise(res => { mkey = res; mh.stdin.write('K ' + raw + '\n'); });
const hashBlob = hex => new Promise(res => { const id = 'c' + (++mid); mwait[id] = res; mh.stdin.write('H ' + id + ' ' + hex + '\n'); });

function client () {
	const sock = net.connect(cfg.poolServer.ports[0].port, '127.0.0.1');
	sock.setEncoding('utf8');
	let buf = '';
	const waiting = {}; const jobs = [];
	sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); if (m.method === 'job') jobs.push(m.params); else if (waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } } });
	let n = 0;
	return {
		jobs, sock,
		call: (method, params) => new Promise(res => { const id = ++n; waiting[id] = res; sock.write(JSON.stringify({id, jsonrpc: '2.0', method, params}) + '\n'); }),
		closed: new Promise(res => sock.on('close', res))
	};
}

async function mine (c, job, wantShares, wantBlocks) {
	// scan nonces from the given start until enough shares were accepted
	let accepted = 0, blocks = 0, tried = 0;
	const start = Buffer.from(job.blob.substr(280, 8), 'hex').readUInt32LE(0);
	const target = Buffer.from(job.target, 'hex').readBigUInt64LE(0);
	for (let base = 0; accepted < wantShares && tried < 20000; base += 64) {
		const batch = [];
		for (let k = 0; k < 64; k++) {
			const nb = Buffer.alloc(4); nb.writeUInt32LE((start + base + k) >>> 0);
			const blob = job.blob.slice(0, 280) + nb.toString('hex') + job.blob.slice(288);
			batch.push(hashBlob(blob).then(h => ({nonce: nb.toString('hex'), hash: h})));
		}
		for (const r of await Promise.all(batch)) {
			tried++;
			if (Buffer.from(r.hash, 'hex').readBigUInt64BE(0) < target) {
				const reply = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: r.nonce, result: r.hash});
				if (reply.result && reply.result.status === 'OK') accepted++;
				else return {accepted, tried, error: reply.error, expired: reply.error && /expired/i.test(reply.error.message)};
				if (accepted >= wantShares) break;
			}
		}
	}
	return {accepted, tried};
}

(async () => {
	const R = redis.createClient(cfg.redis.port, cfg.redis.host, {auth_pass: cfg.redis.auth, db: cfg.redis.db || 0});
	const rcall = (cmd, ...a) => new Promise((res, rej) => R[cmd](...a, (e, v) => e ? rej(e) : res(v)));
	await rcall('flushdb');

	const mock = spawn('node', [path.join(__dirname, 'mock-veil-node.js'), String(cfg.node.port), HARD], {stdio: 'inherit'}); procs.push(mock);
	await sleep(1500);
	const pool = spawn('node', [path.join(__dirname, '..', 'init.js'), '-config=' + path.join(__dirname, 'config.test.json'), '-module=pool'], {cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']}); procs.push(pool);
	let poolLog = ''; pool.stdout.on('data', d => poolLog += d); pool.stderr.on('data', d => poolLog += d);
	await sleep(500);

	// 1. logins
	let c = client(); await sleep(300);
	let bad = await c.call('login', {login: 'notanaddress', pass: 'x', agent: 'test'});
	check('invalid address is refused', !!bad.error && /Invalid Veil address/.test(bad.error.message), bad.error && bad.error.message);
	// wait for the pool: template + hasher init (dataset, ~10 s)
	let login;
	for (let i = 0; i < 60; i++) {
		c = client(); await sleep(200);
		login = await c.call('login', {login: ADDRESS + '+rig1', pass: 'x', agent: 'test/1.0'});
		if (login.result) break;
		c.sock.destroy(); await sleep(1000);
	}
	check('login accepted after the pool is ready', !!(login && login.result && login.result.job), login && login.error && login.error.message);
	const job = login.result.job; c.minerId = login.result.id;
	check('job has a 148 byte blob, rx/veil, seed and 64 bit target', job.blob.length === 296 && job.algo === 'rx/veil' && job.seed_hash.length === 64 && job.target.length === 16 && job.height === 4000001);
	check('extensions announced', login.result.extensions.indexOf('algo') !== -1);
	await setKey(job.seed_hash);

	// 2. bad shares
	const nb = Buffer.alloc(4); nb.writeUInt32LE(12345);
	const blob = job.blob.slice(0, 280) + nb.toString('hex') + job.blob.slice(288);
	const hash = await hashBlob(blob);
	let r = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: nb.toString('hex'), result: '00'.repeat(32)});
	check('wrong hash is rejected', !!r.error && /Bad hash/.test(r.error.message), r.error && r.error.message);
	r = await c.call('submit', {id: c.minerId, job_id: 'nope', nonce: nb.toString('hex'), result: hash});
	check('unknown job is rejected', !!r.error && /expired/i.test(r.error.message), r.error && r.error.message);
	r = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: 'zz', result: hash});
	check('malformed nonce is rejected', !!r.error && /Invalid nonce/.test(r.error.message));
	const tv = Buffer.from(job.target, 'hex').readBigUInt64LE(0);
	if (Buffer.from(hash, 'hex').readBigUInt64BE(0) >= tv) {
		r = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: nb.toString('hex'), result: hash});
		check('a hash above the share target is rejected', !!r.error && /Low difficulty/.test(r.error.message), r.error && r.error.message);
	}

	// 3. real mining: shares first (the network target is out of reach), then a block
	const res = await mine(c, job, 12, 1);
	check('real shares are accepted', res.accepted >= 12, JSON.stringify(res));
	r = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: Buffer.from(job.blob.substr(280, 8), 'hex').toString('hex'), result: '00'.repeat(32)});
	let st = await rpc('mock_state');
	check('no block yet', st.blocks === 0);
	await rpc('mock_setbits', [EASY]);
	for (let i = 0; i < 50 && !c.jobs.length; i++) await sleep(200);
	check('the pool pushed a job for the new template', c.jobs.length >= 1);
	const job2 = c.jobs[c.jobs.length - 1];
	check('the new job is at the same height', job2 && job2.height === job.height);
	const res2 = await mine(c, job2, 400, 1);
	st = await rpc('mock_state');
	check('the node received and accepted a block', st.blocks >= 1, JSON.stringify(st));
	await sleep(1500);
	check('the pool sent a job for the next block', c.jobs.some(j => j.height > job.height), c.jobs.length + ' jobs pushed');

	// 4. redis
	const candidates = await rcall('zrange', 'Veil:blocks:candidates', 0, -1, 'WITHSCORES');
	check('block candidate stored', candidates.length >= 2 && candidates[0].split(':')[1] === ADDRESS, candidates[0] && candidates[0].split(':').slice(0, 3).join(':').slice(0, 60));
	// the round scores must be kept under the block's height, and the candidate must carry their total
	// (slush mining writes the scores of the current round: a wrong key here would leave the miners without their share of the block)
	const cand = candidates[0].split(':');
	const kept = await rcall('hgetall', 'Veil:scores:prop:round' + candidates[1]);
	check('round scores are kept for the block and the candidate has a positive score total', !!kept && parseFloat(kept[ADDRESS]) > 0 && parseFloat(cand[6]) > 0, 'score field ' + cand[6]);
	check('no stray scores of the current round in an untyped key', (await rcall('exists', 'Veil:scores:roundCurrent')) === 0);
	const workers = await rcall('hgetall', 'Veil:workers:' + ADDRESS);
	check('worker stats recorded', workers && parseInt(workers.hashes) > 0, JSON.stringify(workers));
	const uw = await rcall('hgetall', 'Veil:unique_workers:' + ADDRESS + '~rig1');
	check('worker name recorded', uw && parseInt(uw.hashes) > 0);
	const net = await rcall('hgetall', 'Veil:network');
	check('network data published', net && net.algorithm === 'randomx' && parseInt(net.height) >= 4000001, JSON.stringify(net));
	check('the pool log shows BLOCK FOUND', /BLOCK FOUND at height 400000\d by \S+ \(worker rig1\)/.test(poolLog));

	cleanup();
	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED\n' + poolLog.slice(-1500) : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); cleanup(); process.exit(2); });
