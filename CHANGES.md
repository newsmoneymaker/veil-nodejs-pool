# Changes

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
