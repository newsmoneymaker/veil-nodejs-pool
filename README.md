# veil-nodejs-pool

Mining pool software for **Veil (VEIL)** written in Node.js: a stratum server for Veil's RandomX with share checking, block accounting through
the pool wallet, and batch payouts. It is a fork of [cryptonote-nodejs-pool](https://github.com/dvandal/cryptonote-nodejs-pool) by Dvandal
(GNU GPL v2) and of its Epic Cash adaptation [epic-nodejs-pool](https://github.com/newsmoneymaker/epic-nodejs-pool), rewritten for Veil's
Bitcoin-style node and wallet RPC. Live example: <https://veil.pool-pay.com>.

## What it does

* **Stratum server** (plain TCP and TLS ports, XMRig protocol with the `algo` extension): the pool asks the node for a block template
  (`getblocktemplate {"algo":"randomx"}`), gives every miner the header with its own nonce start and a share target that follows the miner's
  hashrate (vardiff), and checks every share itself with a small C++ helper (`hasher/veilhash`): RandomX over the double SHA-256 of the
  148-byte header. A share that meets the network target is submitted to the node with `rxrpcsb`.
* **Accounts** are Veil basecoin addresses (`bv1q...`, 42 characters, bech32 checksum verified), optionally `+worker`, with a reward mode prefix
  `prop:` (shared, default) or `solo:`.
* **Rewards:** PROP with time weighting (slush) or SOLO.
* **Block unlocker:** a block is settled after `depth` blocks (Veil's coinbase maturity is 100). The reward is what the pool wallet received in
  the block's coinbase transaction (`gettransaction`); a block that is no longer on the chain is marked orphaned and nothing is credited.
* **Payment processor:** everyone who is due is paid in **one `sendmany` transaction per round** (the network fee is shared by the paid miners or paid
  by the pool). The balance is debited before sending; a batch whose outcome is unknown (crash, timeout) is found again in the wallet by its comment
  and never sent twice; refused or stuck batches go back to the balances. Dry-run mode, a whitelist for rehearsals and an emergency brake
  (`deployment/pause-payments.sh`).
* **Website and API:** a ready website (`website_example/`) with the dashboard, blocks, payments, top miners, worker statistics, a "Getting started"
  page with a config generator, and the public read-only JSON API.
* **Protection against connection floods:** limits per IP, a login deadline, an optional IP allow list, banning of miners with many invalid shares.
* **Tests** with a simulated Veil node and wallet (`test/`): a real RandomX miner finds shares and blocks against the pool code.

## Developer donation (please read)

The pool takes a **developer donation** from the reward of every block it finds, before the miners' shares are computed. It is configured in
`config.json` (see `config_examples/veil.json`):

```json
"blockUnlocker": {
  "poolFee": 1,
  "donations": { "bv1q3usgtz94uf4hpd4md7qrtlfzhl5gzctpsw90f2": 0.5 }
}
```

* `poolFee` is the fee of the pool operator (percent). `donations` is a table `Veil address -> percent` (up to 10% per entry) for the developers of
  this software; **the default is 0.5% to the address of the project's own pool**. The donation is paid like any other balance.
* It is included in the "Pool Fee" figure that the pool's website and API show to the miners (as in the original software).
* You are free to change the percentage, the address or to empty the table (`"donations": {}`): it is your pool and the license is the GPL.
  Please tell your miners the truth about the fees of your pool.
* This has nothing to do with the miner poolpayminer (a separate project with its own fee).

## Installation

See [docs/INSTALL.md](docs/INSTALL.md): the Veil node (build from source or the official release), the RandomX helper, Redis, the pool services
(systemd templates in `deployment/`), the website and the first payout rehearsal.

Requirements: Linux, Node.js 18 or newer, Redis, a Veil node (`veild` 1.4.4 or newer) synchronised with the network, a C++ compiler and RandomX
for the helper, a web server for the website and a TLS certificate for the TLS stratum ports.

## Miners

The pool needs a miner that supports the `rx/veil` algorithm: [poolpayminer](https://github.com/newsmoneymaker/poolpayminer) (Windows and Linux,
free, has its own fee) or the XMRig fork [us77ipis/xmrig-veil](https://github.com/us77ipis/xmrig-veil). Stock XMRig does not support it.

## Tests

```
npm install
node test/test-account.js                 # address handling, needs nothing else
make -C hasher RANDOMX=/path/to/randomx-prefix
# The others use test/config.test.json and a THROWAWAY Redis on port 16379 (they flush it, never point them at a real database):
redis-server --port 16379 --requirepass CHANGE_ME_REDIS_PASSWORD --save "" --appendonly no &
TEST_ADDRESS=bv1q... node test/test-veil-pool.js                       # simulated node + pool + a miner that really mines
TEST_ADDRESS=bv1q... TEST_ADDRESS2=bv1q... TEST_DEV_ADDRESS=bv1q... node test/test-veil-payments.js   # unlocker and payments
```

## Money warning

The payment processor moves real coins. Rehearse first: `"dryRun": true`, then a whitelist (`onlyAccounts`) with a few small payouts of your own,
then enable it. A transaction that has been sent to the network can not be cancelled. Keep the wallet backup (the 24 word seed) and the RPC password private.

## License and credits

GNU GPL v2 (see [LICENSE](LICENSE)). Based on cryptonote-nodejs-pool, Copyright (c) Dvandal and contributors. The protocol details of Veil's RandomX
mining were taken from the Veil source (MIT) and from [us77ipis/veil-node-stratum-proxy](https://github.com/us77ipis/veil-node-stratum-proxy).
Veil and RandomX are separate programs and are not included.
