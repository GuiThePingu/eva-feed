const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { ethers } = require("ethers");

const app = express();
app.use(cors());

const BURN_VAULT_ADDRESS = "0x8FAE092a9Bbc7E4036C8c815c821E450A3E359F8";
const WBTC_ADDRESS       = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)"
];

const VAULT_ABI = [
  "function remainingEvaCovered() view returns (uint256)"
];

const provider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc");

let cache = {
  burnPriceUSD:   null,
  burnPriceBTC:   null,
  burnPriceSats:  null,
  premiumRatio:   null,
  wbtcInVault:    null,
  evaGuaranteed:  null,
  marketPriceUSD: null,
  btcUSD:         null,
  lastUpdated:    null,
  error:          null
};

// ─── Preço via CoinGecko (funciona no Railway) ────────────────────────────────
async function fetchPrices() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,evervalue-coin&vs_currencies=usd";
  const res  = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "eva-feed/1.0" }
  });
  const data = await res.json();
  return {
    btcUSD: data["bitcoin"]?.usd ?? null,
    evaUSD: data["evervalue-coin"]?.usd ?? null
  };
}

async function updateCache() {
  try {
    const vault        = new ethers.Contract(BURN_VAULT_ADDRESS, VAULT_ABI, provider);
    const wbtcContract = new ethers.Contract(WBTC_ADDRESS, ERC20_ABI, provider);

    const wbtcRaw          = await wbtcContract.balanceOf(BURN_VAULT_ADDRESS);
    const wbtcInVault      = parseFloat(ethers.formatUnits(wbtcRaw, 8));

    const evaGuaranteedRaw = await vault.remainingEvaCovered();
    const evaGuaranteed    = parseFloat(ethers.formatUnits(evaGuaranteedRaw, 18));

    const burnPriceBTC  = wbtcInVault / evaGuaranteed;
    const burnPriceSats = Math.round(burnPriceBTC * 100_000_000);

    const { btcUSD, evaUSD } = await fetchPrices();

    const burnPriceUSD = btcUSD ? burnPriceBTC * btcUSD : null;
    const premiumRatio = (evaUSD && burnPriceUSD)
      ? ((evaUSD - burnPriceUSD) / burnPriceUSD) * 100
      : null;

    cache = {
      burnPriceUSD:   burnPriceUSD ? parseFloat(burnPriceUSD.toFixed(4)) : null,
      burnPriceBTC:   parseFloat(burnPriceBTC.toFixed(10)),
      burnPriceSats:  burnPriceSats,
      premiumRatio:   premiumRatio ? parseFloat(premiumRatio.toFixed(2)) : null,
      wbtcInVault:    parseFloat(wbtcInVault.toFixed(8)),
      evaGuaranteed:  parseFloat(evaGuaranteed.toFixed(2)),
      marketPriceUSD: evaUSD,
      btcUSD:         btcUSD,
      lastUpdated:    new Date().toISOString(),
      error:          null
    };

    console.log(`[${cache.lastUpdated}] BTC: $${btcUSD} | Burn: $${cache.burnPriceUSD} (${burnPriceSats} sats) | EVA: $${evaUSD} | Premium: ${cache.premiumRatio}%`);
  } catch (err) {
    console.error("Erro:", err.message);
    cache.error       = err.message;
    cache.lastUpdated = new Date().toISOString();
  }
}

app.get("/eva",            (req, res) => res.json(cache));
app.get("/eva/burn-price", (req, res) => res.json({ value: cache.burnPriceUSD }));
app.get("/eva/burn-sats",  (req, res) => res.json({ value: cache.burnPriceSats }));
app.get("/eva/premium",    (req, res) => res.json({ value: cache.premiumRatio }));
app.get("/eva/guaranteed", (req, res) => res.json({ value: cache.evaGuaranteed }));
app.get("/eva/wbtc-vault", (req, res) => res.json({ value: cache.wbtcInVault }));
app.get("/health",         (req, res) => res.json({ status: "ok", lastUpdated: cache.lastUpdated }));

cron.schedule("*/15 * * * *", updateCache);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`EVA Feed rodando na porta ${PORT}`);
  await updateCache();
});
