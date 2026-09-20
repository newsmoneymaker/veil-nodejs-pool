// Unlocker + payment processor against a mock wallet/node (JSON-RPC). Needs the throwaway redis of test/config.test.json (flushed!).
// Run: node test/test-veil-payments.js
const {spawn} = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const redis = require(path.join(__dirname, '../node_modules/redis'));
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test.json'), 'utf8'));
const utils = (() => { global.config = {}; return require('../lib/utils.js'); })();

const PORT = 25557;
const A1 = process.env.TEST_ADDRESS, DEV = process.env.TEST_DEV_ADDRESS, A2 = process.env.TEST_ADDRESS2;
if (!A1 || !DEV || !A2) { console.log('set TEST_ADDRESS, TEST_ADDRESS2, TEST_DEV_ADDRESS (valid bv1q addresses)'); process.exit(1); }
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + extra : '')); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const coins = a => a / 1e8;

// ---- mock node + wallet
const M = {
	tip: 1000, hashes: {}, coinbase: {}, txs: {}, calls: [], balance: 50, mode: 'normal'
};
for (let h = 900; h <= 1000; h++) M.hashes[h] = 'h' + h;
function rpcHandle (method, p, reply, fail, res) {
	M.calls.push(method);
	switch (method) {
		case 'getblockcount': return reply(M.tip);
		case 'getblockhash': return M.hashes[p[0]] ? reply(M.hashes[p[0]]) : fail(-8, 'out of range');
		case 'getblock': {
			const h = parseInt(p[0].slice(1));
			if (p[0].startsWith('T')) { return reply({hash: p[0], height: 990, confirmations: 20}); }
			return reply({hash: p[0], height: h, confirmations: 1000 - h, tx: ['cb' + h]});
		}
		case 'gettransaction': {
			if (p[0].startsWith('cb')) { const v = M.coinbase[p[0]]; return v === undefined ? fail(-5, 'Invalid or non-wallet transaction id') : reply({amount: v, confirmations: 100}); }
			const t = M.txs[p[0]]; return t ? reply({txid: t.txid, confirmations: t.confirmations, fee: -0.002, blockhash: 'T' + t.txid}) : fail(-5, 'Invalid or non-wallet transaction id');
		}
		case 'getbalance': return reply(M.balance);
		case 'listtransactions': return reply(Object.values(M.txs).map(t => ({txid: t.txid, category: 'send', comment: t.comment, amount: -t.total})));
		case 'abandontransaction': return reply(null);
		case 'sendmany': {
			if (M.mode === 'refuse') return fail(-6, 'Insufficient funds');
			const txid = 'tx' + (Object.keys(M.txs).length + 1);
			M.txs[txid] = {txid, confirmations: 0, comment: p[3], amounts: p[1], subtract: p[4], total: Object.values(p[1]).reduce((a, b) => a + b, 0)};
			M.sent = (M.sent || 0) + 1;
			if (M.mode === 'lost') { res.socket.destroy(); return; }       // the tx exists, but the answer never arrives
			return reply(txid);
		}
	}
	fail(-32601, 'Method not found: ' + method);
}
http.createServer((req, res) => {
	let b = ''; req.on('data', d => b += d);
	req.on('end', () => {
		const m = JSON.parse(b);
		const reply = r => { res.writeHead(200); res.end(JSON.stringify({result: r, error: null, id: m.id})); };
		const fail = (code, message) => { res.writeHead(200); res.end(JSON.stringify({result: null, error: {code, message}, id: m.id})); };
		rpcHandle(m.method, m.params || [], reply, fail, res);
	});
}).listen(PORT, '127.0.0.1');

// ---- redis
const R = redis.createClient(base.redis.port, base.redis.host, {auth_pass: base.redis.auth, db: base.redis.db || 0});
const rc = (cmd, ...a) => new Promise((res, rej) => R[cmd](...a, (e, v) => e ? rej(e) : res(v)));

const procs = [];
function startModule (name, patch) {
	const cfg = JSON.parse(JSON.stringify(base));
	cfg.node = {host: '127.0.0.1', port: PORT, user: 'test', password: 'test'};
	cfg.poolServer.slushMining = {enabled: false};
	cfg.blockUnlocker = Object.assign({enabled: true, interval: 1, depth: 3, poolFee: 1, donations: {[DEV]: 0.5}}, patch.blockUnlocker || {});
	cfg.payments = Object.assign({enabled: true, interval: 1, minPayment: 50000000, maxTransactionAmount: 5000000000, maxPaymentsPerRound: 50, minConfirmations: 2, pendingTimeoutHours: 48, reserve: 1000000, dryRun: false, minerPayFee: true, unknownAfterSeconds: 2, onlyAccounts: [], stopFile: path.join(os.tmpdir(), 'veil-test-stop')}, patch.payments || {});
	const file = path.join(os.tmpdir(), 'veil-test-' + name + '.json');
	fs.writeFileSync(file, JSON.stringify(cfg));
	const p = spawn('node', [path.join(__dirname, '..', 'init.js'), '-config=' + file, '-module=' + name], {cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']});
	p.log = ''; p.stdout.on('data', d => p.log += d); p.stderr.on('data', d => p.log += d);
	procs.push(p);
	return p;
}
const stop = p => new Promise(res => { p.once('exit', res); p.kill(); });
process.on('exit', () => procs.forEach(p => { try { p.kill(); } catch (e) {} }));
const key = (...a) => ['Veil'].concat(a).join(':');
const bal = async acc => parseInt((await rc('hget', key('workers', acc), 'balance')) || 0);

(async () => {
	await rc('flushdb');
	try { fs.unlinkSync(path.join(os.tmpdir(), 'veil-test-stop')); } catch (e) {}

	// ===== unlocker
	// block 950: reward 10 VEIL to the wallet, found by A1; A1 has score 3, A2 score 1. block 951: orphaned (other hash). block 999: not mature yet.
	M.coinbase.cb950 = 10;
	await rc('zadd', key('blocks', 'candidates'), 950, ['prop', A1, 'h950', 111, 1e9, 4, 4].join(':'));
	await rc('zadd', key('blocks', 'candidates'), 951, ['prop', A1, 'OTHER', 111, 1e9, 4, 4].join(':'));
	await rc('zadd', key('blocks', 'candidates'), 999, ['prop', A1, 'h999', 111, 1e9, 4, 4].join(':'));
	await rc('hset', key('scores', 'prop', 'round950'), A1, 3); await rc('hset', key('scores', 'prop', 'round950'), A2, 1);
	await rc('hset', key('scores', 'prop', 'round951'), A1, 1);
	let un = startModule('unlocker', {});
	await sleep(4000);
	const b1 = await bal(A1), b2 = await bal(A2), bd = await bal(DEV);
	// reward 10, fee 1% + donation 0.5%: miners share 9.85 in 3:1 -> 7.3875 / 2.4625; dev gets 0.05
	check('donation credited to the developer address', bd === 5000000, coins(bd));
	check('miner A1 (score 3 of 4) credited', b1 === 738750000, coins(b1));
	check('miner A2 (score 1 of 4) credited', b2 === 246250000, coins(b2));
	check('the mature block moved to matured, the orphan too', (await rc('zcard', key('blocks', 'matured'))) === 2);
	check('the block that is not mature stays a candidate', (await rc('zcard', key('blocks', 'candidates'))) === 1);
	const matured = await rc('zrange', key('blocks', 'matured'), 0, -1);
	check('orphan is marked', matured.some(m => m.indexOf('OTHER') !== -1 && m.split(':')[6] === '1'));
	await stop(un);

	// ===== payments: dry run
	await rc('hset', key('workers', 'X'), 'balance', 1);   // junk account (invalid address) must never be paid
	let pay = startModule('payments', {payments: {dryRun: true}});
	await sleep(2500);
	check('dry run: nothing sent', !M.sent && /dry run/.test(pay.log));
	check('dry run: balances untouched', (await bal(A1)) === b1);
	await stop(pay);

	// ===== payments: refusal by the wallet -> refund
	M.mode = 'refuse';
	pay = startModule('payments', {});
	await sleep(3000);
	check('wallet refusal: balances are back', (await bal(A1)) === b1 && (await bal(A2)) === b2 && (await rc('hlen', key('payments', 'pending'))) === 0);
	await stop(pay);

	// ===== payments: normal batch in one transaction
	M.mode = 'normal';
	pay = startModule('payments', {});
	await sleep(3000);
	const tx = M.txs.tx1;
	check('one sendmany for both miners', M.sent === 1, 'sendmany calls: ' + M.sent);
	check('batch has A1 and A2; the developer (0.05, below the minimum) waits', tx && tx.amounts[A1] === 7.3875 && tx.amounts[A2] === 2.4625 && tx.amounts[DEV] === undefined, JSON.stringify(tx && tx.amounts));
	check('the fee is subtracted from the paid miners', tx && tx.subtract.length === 2 && tx.subtract.indexOf(A1) !== -1);
	check('comment identifies the batch', tx && /^pool-payout:[0-9a-f]{12}$/.test(tx.comment));
	check('balances debited, pending set', (await bal(A1)) === 0 && parseInt(await rc('hget', key('workers', A1), 'pending')) === 738750000);
	check('junk account not paid', !(tx && tx.amounts.X));
	M.txs.tx1.confirmations = 5;
	await sleep(2500);
	check('confirmed: paid recorded', parseInt(await rc('hget', key('workers', A1), 'paid')) === 738750000 && parseInt(await rc('hget', key('workers', A1), 'pending')) === 0);
	check('payment history written', (await rc('zcard', key('payments', 'all'))) === 2 && (await rc('zcard', key('payments', A1))) === 1);
	check('no open payouts left', (await rc('hlen', key('payments', 'pending'))) === 0);
	check('no second transaction was sent', M.sent === 1, 'sendmany calls: ' + M.sent);
	await stop(pay);

	// ===== payments: the answer of sendmany is lost -> found by comment, no double payment
	await rc('hincrby', key('workers', A1), 'balance', 100000000);
	M.mode = 'lost'; M.sent = 0;
	pay = startModule('payments', {});
	await sleep(5000);
	const lost = Object.values(M.txs).filter(t => t.txid !== 'tx1');
	check('lost answer: the tx exists in the wallet once', lost.length === 1 && M.sent === 1, 'sent ' + M.sent);
	M.mode = 'normal';
	await sleep(3500);
	const entryRaw = await rc('hgetall', key('payments', 'pending'));
	const entry = entryRaw && Object.values(entryRaw).map(JSON.parse)[0];
	check('the record was reconciled with the wallet log (txid known)', entry && entry.state === 'sent' && entry.txid === lost[0].txid, entry && entry.state);
	check('and it was still sent only once', M.sent === 1);
	lost[0].confirmations = 3;
	await sleep(2500);
	check('lost answer: paid after confirmation', parseInt(await rc('hget', key('workers', A1), 'paid')) === 738750000 + 100000000);
	await stop(pay);

	// ===== emergency brake
	await rc('hincrby', key('workers', A2), 'balance', 100000000);
	fs.writeFileSync(path.join(os.tmpdir(), 'veil-test-stop'), '');
	M.sent = 0;
	pay = startModule('payments', {});
	await sleep(3000);
	check('stop file: nothing sent', M.sent === 0 && /PAUSED/.test(pay.log));
	fs.unlinkSync(path.join(os.tmpdir(), 'veil-test-stop'));
	await sleep(2500);
	check('stop file removed: payout goes without a restart', M.sent === 1, 'sent ' + M.sent);
	await stop(pay);

	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(2); });
