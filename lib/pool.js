/**
 * Veil Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 *
 * Stratum server for Veil's RandomX ("rx/veil", XMRig style JSON-RPC over TCP/TLS).
 *
 *   node --getblocktemplate {"algo":"randomx"}--> job manager --job--> miners
 *   miners --submit--> share check (helper: RandomX(SHA256d(blob))) --> redis (shares.js)
 *   a share that meets the network target is sent to the node with rxrpcsb.
 *
 * Veil's RandomX block: blob = 148 byte header (nonce = 4 bytes at offset 140), hash = RandomX(SHA256d(blob)) with the
 * key block hash as RandomX key; a hash is compared as a big endian number. Job target: 64 bit, little endian hex, the
 * miner compares the first 8 bytes of its hash (big endian) with it.
 **/

let net = require('net');
let tls = require('tls');
let fs = require('fs');
let crypto = require('crypto');

let utils = require('./utils.js');
let shares = require('./shares.js');
let rpc = require('./veilRpc.js');
let hasher = require('./hasher.js');

let logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

let poolConfig = config.poolServer;
let varDiffConfig = Object.assign({startDiff: 20000, minDiff: 2000, maxDiff: 5000000, targetTime: 20, retargetTime: 60, variancePercent: 30, maxJump: 100}, poolConfig.varDiff || {});
let JOB_REFRESH = poolConfig.jobRefresh || 1000;
let ALGO_NAME = 'rx/veil';

let banningEnabled = poolConfig.banning && poolConfig.banning.enabled;
let bannedIPs = {};
let perIPStats = {};

const MAX_CLIENT_LINE = 16 * 1024;
const MAX_WORKERNAME = 32;
const NONCE_OFFSET_HEX = 280;      // byte 140 of the blob
const HEADER_HEX_LENGTH = 296;     // 148 bytes
const TWO_64 = 18446744073709551616n;
const TWO_256 = 1n << 256n;

/**
 * Split a byte stream into lines
 **/
function lineSplitter (maxLength, onLine, onOverflow) {
	let buffer = '';
	return function (data) {
		buffer += data;
		let idx;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			let line = buffer.slice(0, idx).replace(/\r$/, '');
			buffer = buffer.slice(idx + 1);
			if (line.length) onLine(line);
		}
		if (buffer.length > maxLength) {
			buffer = '';
			onOverflow();
		}
	};
}

function reverseHex (hex) {
	return Buffer.from(hex, 'hex').reverse().toString('hex');
}

/** nBits (compact) to the 256 bit target */
function compactToTarget (bits) {
	let exponent = bits >>> 24;
	let mantissa = BigInt(bits & 0x007fffff);
	if (bits & 0x00800000) return 0n;
	return exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3));
}

/** 64 bit target (little endian hex, 16 chars) for a share of `hashes` expected hashes */
function targetHex (hashes) {
	let t = TWO_64 / BigInt(Math.max(1, Math.round(hashes)));
	if (t >= TWO_64) t = TWO_64 - 1n;
	let buf = Buffer.alloc(8);
	buf.writeBigUInt64LE(t);
	return {hex: buf.toString('hex'), value: t};
}

/**
 * Parse the stratum login: [prop:|solo:]<bv1 address>[+workername]
 * Returns {address, workerName, rewardType} or {error}
 **/
function parseLogin (login, pass) {
	if (typeof login !== 'string' || !login.length || login.length > 200) return {error: 'Invalid login'};

	let rewardData = utils.determineRewardData(login);
	let rest = rewardData.address;
	let workerName = null;

	let plus = rest.indexOf('+');
	if (plus === -1) plus = rest.indexOf('.');
	if (plus !== -1) {
		workerName = utils.cleanupSpecialChars(rest.substr(plus + 1)).substr(0, MAX_WORKERNAME) || null;
		rest = rest.substr(0, plus);
	}
	if (!workerName && typeof pass === 'string' && pass !== 'x' && pass.length) {
		workerName = utils.cleanupSpecialChars(pass).substr(0, MAX_WORKERNAME) || null;
	}

	let address = utils.canonicalMinerAddress(rest);
	if (!address) return {error: 'Invalid Veil address (expected a basecoin address: bv1q..., 42 characters)'};

	return {address: address, workerName: workerName, rewardType: rewardData.rewardType};
}

/**
 * Banning
 **/
let allowIPs = (poolConfig.allowIPs || []).map(String);

function isAllowedIp (ip) {
	if (!allowIPs.length) return true;
	let plain = ip.replace(/^::ffff:/, '');
	return allowIPs.indexOf(plain) !== -1 || allowIPs.indexOf(ip) !== -1;
}

function IsBannedIp (ip) {
	if (!banningEnabled || !bannedIPs[ip]) return false;
	let timeLeft = poolConfig.banning.time * 1000 - (Date.now() - bannedIPs[ip]);
	if (timeLeft > 0) return true;
	delete bannedIPs[ip];
	log('info', logSystem, 'Ban dropped for %s', [ip]);
	return false;
}

function checkBan (miner, validShare) {
	if (!banningEnabled) return;

	let stats = perIPStats[miner.ip];
	if (!stats) stats = perIPStats[miner.ip] = {validShares: 0, invalidShares: 0};
	if (validShare) stats.validShares++; else stats.invalidShares++;

	let total = stats.validShares + stats.invalidShares;
	if (total >= poolConfig.banning.checkThreshold) {
		let percent = stats.invalidShares / total * 100;
		if (percent >= poolConfig.banning.invalidPercent) {
			log('warn', logSystem, 'Banned %s@%s: %d%% invalid shares', [miner.address, miner.ip, Math.round(percent)]);
			bannedIPs[miner.ip] = Date.now();
			miner.destroy();
		}
		delete perIPStats[miner.ip];
	}
}

setInterval(function () {
	let now = Date.now();
	for (let ip in bannedIPs) {
		if (now - bannedIPs[ip] > poolConfig.banning.time * 1000) delete bannedIPs[ip];
	}
	perIPStats = {};
}, 60 * 1000);

/**
 * Limits against connection floods: per IP (total and not yet logged in), a login deadline, in total.
 * Settings in poolServer: maxConnectionsPerIp, maxUnauthenticatedPerIp, loginTimeout (s), maxConnections.
 **/
let MAX_PER_IP = poolConfig.maxConnectionsPerIp || 100;
let MAX_UNAUTH_PER_IP = poolConfig.maxUnauthenticatedPerIp || 10;
let LOGIN_TIMEOUT = (poolConfig.loginTimeout || 20) * 1000;
let MAX_TOTAL = poolConfig.maxConnections || 3000;
let connectionsByIp = {};
let totalConnections = 0;
let limitLogged = {};

function limitReason (ip) {
	let c = connectionsByIp[ip];
	if (totalConnections >= MAX_TOTAL) return 'the pool is full (' + MAX_TOTAL + ' connections)';
	if (c && c.total >= MAX_PER_IP) return 'more than ' + MAX_PER_IP + ' connections from one address';
	if (c && c.unauth >= MAX_UNAUTH_PER_IP) return 'more than ' + MAX_UNAUTH_PER_IP + ' connections from one address that did not log in';
	return null;
}

/**
 * Job manager: polls the node for a block template, keeps recent jobs.
 **/
let jobs = new Map();          // job id -> job
let currentJob = null;
let currentKeyRaw = null;      // RandomX key in use by the hasher (raw bytes, hex)
let keyReady = false;
let jobCounter = 0;
let miners = new Set();
let refreshing = false;
let lastStaleLog = 0;
let lastTemplateError = null;
let lastTemplateErrorTime = 0;

function newJobFromTemplate (t) {
	let header = t.rxrpcheader;
	if (typeof header !== 'string' || header.length !== HEADER_HEX_LENGTH || !/^[0-9a-f]+$/.test(header)) {
		throw new Error('unexpected rxrpcheader (is -miningaddress set on the node?)');
	}
	let target = compactToTarget(parseInt(t.bits, 16));
	if (target <= 0n) throw new Error('bad bits ' + t.bits);
	// the node may keep serving an old header for up to a minute: do not mine on a block that is not the tip
	let headerPrev = reverseHex(header.substr(8, 64));
	if (t.previousblockhash && headerPrev !== t.previousblockhash) {
		let err = new Error('stale template (header builds on ' + headerPrev.substr(0, 12) + ', tip is ' + String(t.previousblockhash).substr(0, 12) + ')');
		err.stale = true;
		throw err;
	}
	return {
		id: null,
		height: t.height,
		header: header,
		keyRaw: reverseHex(t.rxrpcseed),
		target: target,
		blockHashes: Number(TWO_256 / target),
		created: Date.now(),
	};
}

function refreshTemplate () {
	if (refreshing) return;
	refreshing = true;
	rpc.call('getblocktemplate', [{algo: 'randomx', rules: ['segwit']}], function (err, t) {
		refreshing = false;
		if (err) {
			// the node is loading or not synchronised: one line per 30 seconds, not one per poll
			let text = err.message || JSON.stringify(err);
			if (text !== lastTemplateError || Date.now() - lastTemplateErrorTime > 30000) {
				lastTemplateError = text;
				lastTemplateErrorTime = Date.now();
				log('error', logSystem, 'getblocktemplate failed: %s', [text]);
			}
			return;
		}
		let job;
		try {
			job = newJobFromTemplate(t);
		} catch (e) {
			if (e.stale) {
				if (Date.now() - lastStaleLog > 30000) {
					lastStaleLog = Date.now();
					log('warn', logSystem, 'Skipped the template: %s', [e.message]);
				}
			} else {
				log('error', logSystem, 'Bad block template: %s', [e.message]);
			}
			return;
		}
		if (currentJob && currentJob.header === job.header) return;

		if (job.keyRaw !== currentKeyRaw) {
			// a new RandomX key (every 2048 blocks): the helper rebuilds its dataset, jobs start when it is ready
			log('info', logSystem, 'New RandomX key %s, initialising the hasher', [job.keyRaw.substr(0, 16)]);
			currentKeyRaw = job.keyRaw;
			keyReady = false;
			hasher.setKey(job.keyRaw, function (keyErr) {
				if (keyErr) {
					log('error', logSystem, 'Hasher could not set the key: %s', [keyErr.message]);
					currentKeyRaw = null;
					return;
				}
				keyReady = true;
				log('info', logSystem, 'Hasher is ready');
				refreshTemplate();
			});
			return;
		}
		if (!keyReady) return;

		job.id = String(++jobCounter);
		jobs.set(job.id, job);
		let previous = currentJob;
		currentJob = job;
		// forget jobs of earlier blocks and old ones of this block
		jobs.forEach(function (j, id) {
			if (j.height < job.height || job.created - j.created > 10 * 60 * 1000 || Number(id) < jobCounter - 20) jobs.delete(id);
		});

		if (!previous || previous.height !== job.height) {
			log('info', logSystem, 'New block to mine: height %d, network difficulty %s hashes', [job.height, Math.round(job.blockHashes)]);
			publishNetwork(job);
		}
		miners.forEach(function (miner) { miner.sendJob(); });
	});
}

let lastPublished = {height: null, time: 0};

function publishNetwork (job) {
	let now = Date.now();
	if (lastPublished.height === job.height && now - lastPublished.time < 30000) return;
	lastPublished = {height: job.height, time: now};
	redisClient.hmset(config.coin + ':network', {
		height: job.height,
		algorithm: 'randomx',
		difficulties: JSON.stringify({randomx: job.blockHashes}),
		updated: now
	}, function (err) {
		if (err) log('error', logSystem, 'Failed to publish network data: %j', [err]);
	});
}

/**
 * One miner connection
 **/
function handleConnection (socket, portData) {
	let ip = socket.remoteAddress;
	if (!ip) return socket.destroy();

	if (!isAllowedIp(ip)) {
		log('info', logSystem, 'Rejected connection from %s: not in poolServer.allowIPs', [ip]);
		return socket.destroy();
	}

	if (IsBannedIp(ip)) {
		log('info', logSystem, 'Rejected connection from banned IP %s', [ip]);
		return socket.destroy();
	}

	let limited = limitReason(ip);
	if (limited) {
		if (!limitLogged[ip] || Date.now() - limitLogged[ip] > 60000) {
			limitLogged[ip] = Date.now();
			log('warn', logSystem, 'Rejected connection from %s: %s', [ip, limited]);
		}
		return socket.destroy();
	}
	let counter = connectionsByIp[ip] || (connectionsByIp[ip] = {total: 0, unauth: 0});
	counter.total++;
	counter.unauth++;
	totalConnections++;
	let authenticated = false;

	socket.setEncoding('utf8');
	socket.setNoDelay(true);

	let closed = false;
	let connectedAt = Date.now();
	let diff = Math.min(Math.max(portData.diff || varDiffConfig.startDiff, varDiffConfig.minDiff), varDiffConfig.maxDiff);
	let miner = {
		id: crypto.randomBytes(8).toString('hex'),
		ip: ip,
		address: null,
		workerName: null,
		rewardType: 'prop',
		diff: diff,
		fixedDiff: !!portData.fixedDiff,
		sent: new Map(),               // job id -> {target, diff, nonceStart}
		shareTimes: [],
		lastRetarget: Date.now(),
		sendJob: function () { sendJob(false); },
		destroy: function () {
			if (closed) return;
			closed = true;
			clearTimeout(loginTimer);
			miners.delete(miner);
			counter.total--;
			if (!authenticated) counter.unauth--;
			totalConnections--;
			if (counter.total <= 0) delete connectionsByIp[ip];
			let caller = (new Error().stack.split('\n')[2] || '').trim();
			log('info', logSystem, 'Closing connection of %s@%s after %ds, closed by: %s', [miner.address, ip, Math.round((Date.now() - connectedAt) / 1000), caller]);
			socket.destroy();
		}
	};

	let loginTimer = setTimeout(function () {
		if (authenticated) return;
		log('info', logSystem, 'No login from %s within %ds, closing', [ip, LOGIN_TIMEOUT / 1000]);
		miner.destroy();
	}, LOGIN_TIMEOUT);

	log('info', logSystem, 'Miner connected from %s on port %d', [ip, portData.port]);

	if (poolConfig.minerTimeout) {
		socket.setTimeout(poolConfig.minerTimeout * 1000, function () {
			log('info', logSystem, 'Miner %s@%s timed out', [miner.address, ip]);
			miner.destroy();
		});
	}

	function send (obj) {
		if (!closed && socket.writable) socket.write(JSON.stringify(obj) + '\n');
	}

	function reply (id, result, error) {
		send({id: id, jsonrpc: '2.0', error: error ? {code: error.code || -1, message: error.message} : null, result: result});
	}

	/** the job for this miner: the block header with its own start nonce and its share target **/
	function buildJob () {
		if (!currentJob || !keyReady) return null;
		let job = currentJob;
		let nonceStart = crypto.randomBytes(4).toString('hex');
		let target = targetHex(miner.diff);
		// the same job can be sent again with another share difficulty (vardiff): keep the nonces already used and
		// still accept shares that were found for the previous target
		let before = miner.sent.get(job.id);
		miner.sent.set(job.id, {
			target: target.value,
			diff: miner.diff,
			prev: before ? {target: before.target, diff: before.diff} : null,
			nonces: before ? before.nonces : new Set(),           // accepted nonces of this miner on this job
			pendingNonces: before ? before.pendingNonces : new Set(),
			nonceStart: nonceStart
		});
		if (miner.sent.size > 30) miner.sent.delete(miner.sent.keys().next().value);
		return {
			blob: job.header.slice(0, NONCE_OFFSET_HEX) + nonceStart + job.header.slice(NONCE_OFFSET_HEX + 8),
			job_id: job.id,
			target: target.hex,
			height: job.height,
			seed_hash: job.keyRaw,
			algo: ALGO_NAME
		};
	}

	function sendJob () {
		let job = buildJob();
		if (job) send({jsonrpc: '2.0', method: 'job', params: job});
	}

	function onLine (line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			log('warn', logSystem, 'Malformed JSON from %s@%s', [miner.address, ip]);
			return miner.destroy();
		}
		if (!msg || typeof msg !== 'object') return miner.destroy();

		switch (msg.method) {
			case 'login':
				return onLogin(msg);
			case 'submit':
				return onSubmit(msg);
			case 'keepalived':
				return reply(msg.id, {status: 'KEEPALIVED'});
			default:
				return reply(msg.id, null, {code: -32601, message: 'Unknown method'});
		}
	}

	function onLogin (msg) {
		let params = msg.params || {};
		let parsed = parseLogin(params.login, params.pass);
		if (parsed.error) {
			log('warn', logSystem, 'Rejected login from %s: %s', [ip, parsed.error]);
			reply(msg.id, null, {code: -1, message: parsed.error});
			return setTimeout(miner.destroy, 100);
		}
		let job = buildJob();
		if (!job) {
			reply(msg.id, null, {code: -1, message: 'The pool is starting (no block template yet), try again in a minute'});
			return setTimeout(miner.destroy, 100);
		}

		if (!authenticated) {
			authenticated = true;
			counter.unauth--;
			clearTimeout(loginTimer);
		}
		miner.address = parsed.address;
		miner.workerName = parsed.workerName;
		miner.rewardType = parsed.rewardType;
		miners.add(miner);

		reply(msg.id, {id: miner.id, job: job, status: 'OK', extensions: ['algo', 'keepalive']});
		log('info', logSystem, 'Miner logged in: %s worker=%s type=%s ip=%s agent=%s', [parsed.address, parsed.workerName, parsed.rewardType, ip, String(params.agent || '').substr(0, 60)]);
	}

	function reject (msg, message, code, count) {
		if (count !== false) checkBan(miner, false);
		log('info', logSystem, 'Rejected share from %s@%s: %s', [miner.address, ip, message]);
		reply(msg.id, null, {code: code || -1, message: message});
	}

	function onSubmit (msg) {
		if (!miner.address) return reply(msg.id, null, {code: -1, message: 'Login required'});

		let params = msg.params || {};
		let sent = miner.sent.get(String(params.job_id));
		let job = jobs.get(String(params.job_id));
		if (!sent || !job || !currentJob || job.height !== currentJob.height || job.keyRaw !== currentKeyRaw) {
			return reject(msg, 'Job expired', -1, false);
		}
		let nonce = String(params.nonce || '').toLowerCase();
		if (!/^[0-9a-f]{8}$/.test(nonce)) return reject(msg, 'Invalid nonce');
		// a nonce counts once, but only a nonce that produced a valid share is remembered
		// (a wrong answer must not use up a nonce)
		if (sent.nonces.has(nonce) || sent.pendingNonces.has(nonce)) return reject(msg, 'Duplicate share');
		sent.pendingNonces.add(nonce);

		let blob = job.header.slice(0, NONCE_OFFSET_HEX) + nonce + job.header.slice(NONCE_OFFSET_HEX + 8);
		hasher.hash(blob, function (err, hashHex) {
			sent.pendingNonces.delete(nonce);
			if (err) {
				log('error', logSystem, 'Cannot check a share from %s: %s', [miner.address, err.message]);
				return reply(msg.id, null, {code: -1, message: 'Try again'});
			}
			if (params.result && String(params.result).toLowerCase() !== hashHex) {
				return reject(msg, 'Bad hash');
			}
			let value = Buffer.from(hashHex, 'hex').readBigUInt64BE(0);
			// the difficulty this share is credited with: the current one, or the previous one for a share found just before a retarget
			let credited = value < sent.target ? sent : (sent.prev && value < sent.prev.target ? sent.prev : null);
			if (!credited) return reject(msg, 'Low difficulty share');

			let hashValue = BigInt('0x' + hashHex);
			let isBlock = hashValue <= job.target;
			sent.nonces.add(nonce);
			checkBan(miner, true);
			reply(msg.id, {status: 'OK'});
			acceptShare(job, credited, nonce, hashHex, isBlock);
		});
	}

	function acceptShare (job, sent, nonce, hashHex, isBlock) {
		let weight = shares.shareWeight(sent.diff, job.blockHashes);

		let record = function (blockHash) {
			shares.record({
				login: miner.address,
				workerName: miner.workerName,
				ip: ip,
				rewardType: miner.rewardType,
				algo: 'randomx',
				height: job.height,
				rawDifficulty: sent.diff,
				weight: weight,
				blockCandidate: !!blockHash,
				hash: blockHash || null
			});
		};

		if (!isBlock) {
			record(null);
			retarget();
			return;
		}

		// full solution: the node wants the nonce as a hex number, the reverse of the bytes in the blob
		log('info', logSystem, 'Block solution at height %d from %s, submitting', [job.height, miner.address]);
		rpc.call('rxrpcsb', [job.header, hashHex, reverseHex(nonce)], function (err, result) {
			if (err) {
				log('error', logSystem, 'Node rejected the block at height %d: %s', [job.height, err.message || JSON.stringify(err)]);
				record(null);
				return;
			}
			if (result !== true) {
				log('warn', logSystem, 'Block at height %d not accepted: %j', [job.height, result]);
				record(null);
				return;
			}
			rpc.call('getblockhash', [job.height], function (hashErr, blockHash) {
				if (hashErr || typeof blockHash !== 'string') {
					log('error', logSystem, 'Block accepted but its hash is unknown at height %d: %s', [job.height, hashErr && (hashErr.message || JSON.stringify(hashErr))]);
					return record(null);
				}
				log('info', logSystem, 'BLOCK FOUND at height %d by %s, hash %s', [job.height, miner.address, blockHash]);
				record(blockHash);
				setTimeout(refreshTemplate, 100);
			});
		});
	}

	/** variable difficulty: aim at one share per targetTime seconds **/
	function retarget () {
		if (miner.fixedDiff) return;
		let now = Date.now();
		miner.shareTimes.push(now);
		if (miner.shareTimes.length > 30) miner.shareTimes.shift();
		if (now - miner.lastRetarget < varDiffConfig.retargetTime * 1000 || miner.shareTimes.length < 4) return;
		miner.lastRetarget = now;

		let span = (miner.shareTimes[miner.shareTimes.length - 1] - miner.shareTimes[0]) / 1000 / (miner.shareTimes.length - 1);
		if (!(span > 0)) span = 0.1;
		let ratio = varDiffConfig.targetTime / span;
		if (Math.abs(1 - ratio) * 100 < varDiffConfig.variancePercent) return;
		let newDiff = miner.diff * ratio;
		let jump = varDiffConfig.maxJump / 100;
		newDiff = Math.min(Math.max(newDiff, miner.diff * (1 - jump / (1 + jump))), miner.diff * (1 + jump));
		let cap = currentJob ? Math.min(varDiffConfig.maxDiff, currentJob.blockHashes / 4) : varDiffConfig.maxDiff;
		newDiff = Math.round(Math.min(Math.max(newDiff, varDiffConfig.minDiff), Math.max(cap, varDiffConfig.minDiff)));
		if (newDiff === miner.diff) return;
		log('info', logSystem, 'Difficulty of %s@%s: %d -> %d (a share every %ss)', [miner.address, ip, miner.diff, newDiff, span.toFixed(1)]);
		miner.diff = newDiff;
		miner.shareTimes = [];
		sendJob();
	}

	socket.on('data', lineSplitter(MAX_CLIENT_LINE, onLine, function () {
		log('warn', logSystem, 'Oversized line from %s@%s', [miner.address, ip]);
		miner.destroy();
	}));

	socket.on('error', function (err) {
		if (err.code !== 'ECONNRESET') log('warn', logSystem, 'Socket error from %s@%s: %s', [miner.address, ip, err]);
	});

	socket.on('close', function () {
		if (!closed) log('info', logSystem, 'Miner disconnected %s@%s', [miner.address, ip]);
		miner.destroy();
	});
}

/**
 * Start
 **/
shares.init();
refreshTemplate();
setInterval(refreshTemplate, JOB_REFRESH);

poolConfig.ports.forEach(function (portData) {
	let onConnection = function (socket) {
		handleConnection(socket, portData);
	};

	let server;
	if (portData.tls) {
		// poolServer.sslCert = certificate chain, poolServer.sslKey = private key (PEM). Read at start: restart after renewing.
		let options;
		try {
			options = {
				cert: fs.readFileSync(poolConfig.sslCert),
				key: fs.readFileSync(poolConfig.sslKey),
				minVersion: 'TLSv1.2'
			};
		} catch (e) {
			log('error', logSystem, 'Cannot read the TLS certificate/key for port %d: %s', [portData.port, e.message]);
			return;
		}
		server = tls.createServer(options, onConnection);
		server.on('tlsClientError', function (err, socket) {
			log('info', logSystem, 'TLS handshake failed from %s: %s', [socket && socket.remoteAddress, err.message]);
		});
	} else {
		server = net.createServer(onConnection);
	}

	server.listen(portData.port, poolConfig.bindIp || '0.0.0.0', function (error) {
		if (error) {
			log('error', logSystem, 'Could not start server listening on port %d: %j', [portData.port, error]);
			return;
		}
		log('info', logSystem, 'Started %sserver listening on port %d (%s)', [portData.tls ? 'TLS ' : '', portData.port, portData.desc || '']);
	});
});
