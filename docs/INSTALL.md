# Installing a Veil pool

Paths below are examples: the pool in `/opt/veil-nodejs-pool`, the node and its data in `/opt/veil`, all run by the user `veilpool`
(the systemd templates in `deployment/systemd/` use these paths).

## 1. Veil node

Use the official release from <https://github.com/Veil-Project/veil/releases> (verify `shasums.txt` and its GPG signature; the signer's key
fingerprint is printed in the release notes) or build it. **The official Linux binary needs a recent glibc (2.34 for 1.4.4)**; on an older
system build from the tag:

```
git clone --branch v1.4.4.0 --depth 1 https://github.com/Veil-Project/veil && cd veil
# build dependencies: build-essential libtool autotools-dev automake pkg-config libssl-dev libevent-dev bsdmainutils python3
#   libboost-all-dev libgmp-dev libzmq3-dev, and Berkeley DB 4.8 (contrib/install_db4.sh <prefix>)
./autogen.sh
./configure --without-gui --disable-tests --disable-bench --with-zerocoin-bignum=gmp BDB_LIBS="-L<prefix>/db4/lib -ldb_cxx-4.8" BDB_CFLAGS="-I<prefix>/db4/include"
make -j4 && make install
```

`/opt/veil/data/veil.conf`:

```
server=1
listen=1
rpcuser=veilpool
rpcpassword=<a long random password>
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=5556
dbcache=2048
# the pool's reward address, a basecoin address of the pool wallet (see below); the node builds every block template with it
miningaddress=bv1q...
```

A new wallet needs a seed: start once with `-generateseed=1` (the 24 words are printed to the console only, **write them down and keep them offline**;
run it so that the output does not land in a log). Then `veil-cli getnewbasecoinaddress` gives addresses; put one into `miningaddress`.

Let the node synchronise (`veil-cli getblockchaininfo`). A sync from genesis takes long, the project also publishes chain snapshots
(<https://github.com/Veil-Project/veil-snapshots>): read what you trust before you use one. The pool refuses to hand out work while the node has no template.

Put the RPC password into `/opt/veil/data/rpc.pass` (mode 600); `config.json` reads it from there.

## 2. RandomX helper

```
git clone https://github.com/tevador/RandomX && cd RandomX && mkdir build && cd build
cmake .. -DARCH=native -DBUILD_SHARED_LIBS=OFF && make -j4 randomx
mkdir -p /opt/randomx/include /opt/randomx/lib && cp ../src/randomx.h /opt/randomx/include && cp librandomx.a /opt/randomx/lib
cd /opt/veil-nodejs-pool/hasher && make RANDOMX=/opt/randomx
```

The helper needs about 2.3 GB of RAM (RandomX dataset, fast mode; `"hasher": {"light": true}` uses 256 MB and is much slower).

## 3. Redis

Use a dedicated instance with a password and AOF (`deployment/redis-pool.conf.example`, unit `veil-pool-redis`, port 6381).

## 4. The pool

```
cd /opt/veil-nodejs-pool && npm install --production
cp config_examples/veil.json config.json      # then edit it
```

Edit `config.json`: `poolHost`, the ports and the certificate for TLS (`poolServer.sslCert/sslKey`), `redis`, `api.password`, `node.passwordFile`,
`blockUnlocker.poolFee` and `donations`, `payments`. **Keep `payments.dryRun: true` until the rehearsal below.**

```
cp deployment/systemd/*.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now veil-pool-redis veil-node
systemctl enable --now veil-pool veil-pool-api veil-pool-unlocker veil-pool-payments veil-pool-charts
```

The pool runs as separate modules (`init.js -module=pool|api|unlocker|payments`), each in its own unit. The pool module keeps one hasher process
(and its RandomX dataset), so run it as one process. Until payouts are proven, restrict the stratum ports with `poolServer.allowIPs`.

## 5. Website

Copy `website_example/` to the web root, set `poolHost`, the contact and links in `config.js`, and proxy `/api` to the pool API on 127.0.0.1:8118
(`deployment/apache-vhost.conf.example` exposes only the read-only methods).

## 6. Rehearse the payments

1. `payments.dryRun: true`: the log of `veil-pool-payments` shows what would be paid.
2. Fund the pool wallet with a few coins, credit a small balance in Redis to your own test addresses (`<coin>:workers:<address>`, field `balance`),
   set `payments.onlyAccounts` to them, `dryRun: false`, and watch the payout confirm.
3. Remove the test accounts from Redis and set `onlyAccounts` to `[]`.

Good to know: block rewards can be spent after 100 blocks; `deployment/pause-payments.sh` stops new payouts at once; the wallet must stay unlocked and
online for the payouts (an encrypted wallet needs `walletpassphrase` before sending, or leave the pool wallet unencrypted with only small balances in it).
