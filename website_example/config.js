/* Veil pool website settings */

// Coin name shown next to the pool name (must equal the "symbol" of the pool config)
var parentCoin = "VEIL";

// Pool API: proxied by the web server from /api to the pool's API on 127.0.0.1
var api = "/api";

// Pool host name shown on the "Getting started" page
var poolHost = "pool.example.com";

// A notice shown above every page (empty = none)
var poolNotice = {en: "", ru: ""};

// Contact / community links (leave empty to hide)
var email = "";
var telegram = "";
var discord = "";
var github = "";
var minerDownload = "/downloads/";      // poolpayminer (optional menu item; leave empty to hide)

// No exchange data source for Veil here, market widgets are hidden
var marketCurrencies = [];

// Block explorer links ({id} = block height / transaction id)
var blockchainExplorer = "https://explorer.veil-project.com/main/block/{id}";
var transactionExplorer = "https://explorer.veil-project.com/main/tx/{id}";

// Theme and default language ("en" or "ru")
var themeCss = "themes/default.css";
var defaultLang = "en";
