# Changes

## Unreleased

* The variable difficulty is remembered per address and worker across reconnects (`poolServer.diffMemoryMinutes`, default 15): a miner whose connection is cut or renewed every half minute no longer restarts from the start difficulty each time.
* Website: block links can use the block hash (`var blockExplorerId = "hash";` in `config.js`; the default stays the height). The Veil explorer opens a block by hash,
  a height gave an empty page ("block not found"). Set in `config_examples`-based sites of Veil.

## 1.0.2

* **Fix: unlocker read the reward as 0 for a coinbase that is not mature.** `gettransaction` reports `amount` 0 for an immature coinbase (the credit is in
  `details`, category `immature`, later `generate`); the unlocker now sums the wallet's credit from `details`. Checked on a real Veil block.
* The website shows the block hash and the finder's address shortened (full value in the tooltip), so a block row fits on the page.
* The log lines of a found block name the worker.

## 1.0.1

* **Fix: block rewards could not be split.** With slush mining the round scores were written to `<coin>:scores:roundCurrent`, while a found block moves and
  reads `<coin>:scores:prop:roundCurrent`: the block candidate got a score total of 0 and nobody would have been credited. Scores are now written to
  `<coin>:scores:<prop|solo>:roundCurrent`; the pool test checks that the round scores are kept for the block and the candidate has a positive total.
  Found on the first real block of the live pool. If you run 1.0.0: stop the pool, rebuild the block's `<coin>:scores:prop:round<height>` from
  `<coin>:shares_actual:prop:round<height>`, put the total into the last field of the candidate (`<coin>:blocks:candidates`), move the old
  `<coin>:scores:roundCurrent` to `<coin>:scores:prop:roundCurrent`, and start 1.0.1 (do this before the block is unlocked).

## 1.0.0

First release of the Veil adaptation of [cryptonote-nodejs-pool](https://github.com/dvandal/cryptonote-nodejs-pool) 1.4.1 (GPL-2.0), derived from
[epic-nodejs-pool](https://github.com/newsmoneymaker/epic-nodejs-pool).

* Stratum: XMRig protocol with `algo: rx/veil`, jobs from `getblocktemplate {"algo":"randomx"}`, per-miner nonce start, vardiff, share checking with
  the `veilhash` helper (RandomX over SHA-256d of the header), block submission with `rxrpcsb`, stale template protection, TLS ports, per-IP limits,
  optional IP allow list, banning.
* Accounts are bech32 basecoin addresses (`bv1q...`).
* Block unlocker for Veil (coinbase maturity 100): reward from the wallet's coinbase transaction, orphan detection.
* Payment processor: one `sendmany` transaction per round, crash-safe bookkeeping, dry run, whitelist, emergency stop file.
* Developer donation (`blockUnlocker.donations`, default 0.5%), included in the pool fee shown on the website and in the API.
* Website: dashboard, blocks, payments, top miners, worker statistics, Getting started page with a config generator, public API page.
* `deployment/` (systemd units, Redis and Apache examples), `docs/INSTALL.md`, tests with a simulated node and wallet.

Removed: everything specific to Epic Cash (node stratum proxy, Owner API wallet client, epicbox accounts and deposit notes) and to CryptoNote coins.
