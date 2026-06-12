const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { ethers } = require("ethers");

const app = express();
app.use(cors());

// ─── Endereços na Arbitrum One ───────────────────────────────────────────────
const BURN_VAULT_ADDRESS = "0x8FAE092a9Bbc7E4036C8c815c821E450A3E359F8";
const WBTC_ADDRESS       = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";

const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ABI do BurnVault Boost — lê os campos do contrato
const VAULT_ABI = [
  "function remainingEvaCovered() view returns (uint256)",
  "function getEffectiveEvaAmount() view returns (uint256)",
  "function ONE_EVA() view returns (uint256)",
  "function eva() view returns (address)"
];

const provider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc");

let cache = {
  burnPriceUSD:      null,
  burnPriceBTC:      null,
  burnPriceSats:     null,
  premiumRatio:      null,
  wbtcInVault:       null,
  evaGuaranteed:     null, // tokens cobertos pelo vault (diminui com queimas)
  evaBurnedSoFar:    null,
  marketPriceUSD:    null,
  btcUSD:            null,
  lastUpdated:       null,
  error:             null
};

// ─── Preço BTC via Binance (tempo real) ──────────────────────────────────────
async function fetchPrices() {
  const btcRes  = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  const btcData = await btcRes.json();
  const btcUSD  = parseFloat(btcData.price);

  // EVA — tenta Binance, fallback CoinGecko
  let evaUSD = null;
  try {
    const evaRes  = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=EVAUSDT");
    const evaData = await evaRes.json();
    if (evaData.price) evaUSD = parseFloat(evaData.price);
  } catch (_) {}

  if (!evaUSD) {
    const cgRes  = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=evervalue-coin&vs_currencies=usd");
    const cgData = await cgRes.json();
    evaUSD = cgData["evervalue-coin"]?.usd ?? null;
  }

  return { btcUSD, evaUSD };
}

// ─── Lê on-chain e calcula ───────────────────────────────────────────────────
async function updateCache() {
  try {
    const vault        = new ethers.Contract(BURN_VAULT_ADDRESS, VAULT_ABI, provider);
    const wbtcContract = new ethers.Contract(WBTC_ADDRESS, ERC20_ABI, provider);

    // wBTC no vault (8 decimais)
    const wbtcRaw     = await wbtcContract.balanceOf(BURN_VAULT_ADDRESS);
    const wbtcInVault = parseFloat(ethers.formatUnits(wbtcRaw, 8));

    // EVA garantida pelo vault — esse valor diminui conforme queimas acontecem
    const evaGuaranteedRaw = await vault.remainingEvaCovered();
    const evaGuaranteed    = parseFloat(ethers.formatUnits(evaGuaranteedRaw, 18));

    // Burn Price em BTC por EVA = wBTC no vault / EVA coberta
    const burnPriceBTC  = wbtcInVault / evaGuaranteed;
    const burnPriceSats = Math.round(burnPriceBTC * 100_000_000); // em satoshis

    // Preços de mercado
    const { btcUSD, evaUSD } = await fetchPrices();

    // Burn Price em USD
    const burnPriceUSD = burnPriceBTC * btcUSD;

    // Premium Ratio
    const premiumRatio = evaUSD
      ? ((evaUSD - burnPriceUSD) / burnPriceUSD) * 100
      : null;

    cache = {
      burnPriceUSD:   parseFloat(burnPriceUSD.toFixed(4)),
      burnPriceBTC:   parseFloat(burnPriceBTC.toFixed(10)),
      burnPriceSats:  burnPriceSats,
      premiumRatio:   premiumRatio ? parseFloat(premiumRatio.toFixed(2)) : null,
      wbtcInVault:    parseFloat(wbtcInVault.toFixed(8)),
      evaGuaranteed:  parseFloat(evaGuaranteed.toFixed(2)), // atualiza automaticamente
      marketPriceUSD: evaUSD,
      btcUSD:         parseFloat(btcUSD.toFixed(2)),
      lastUpdated:    new Date().toISOString(),
      error:          null
    };

    console.log(`[${cache.lastUpdated}] BTC: $${btcUSD.toLocaleString()} | Burn Price: $${cache.burnPriceUSD} (${burnPriceSats} sats) | EVA coberta: ${cache.evaGuaranteed} | Premium: ${cache.premiumRatio}%`);
  } catch (err) {
    console.error("Erro:", err.message);
    cache.error       = err.message;
    cache.lastUpdated = new Date().toISOString();
  }
}

// ─── Rotas ───────────────────────────────────────────────────────────────────
app.get("/eva",            (req, res) => res.json(cache));
app.get("/eva/burn-price", (req, res) => res.json({ value: cache.burnPriceUSD }));
app.get("/eva/burn-sats",  (req, res) => res.json({ value: cache.burnPriceSats }));
app.get("/eva/premium",    (req, res) => res.json({ value: cache.premiumRatio }));
app.get("/eva/guaranteed", (req, res) => res.json({ value: cache.evaGuaranteed }));
app.get("/eva/wbtc-vault", (req, res) => res.json({ value: cache.wbtcInVault }));
app.get("/health",         (req, res) => res.json({ status: "ok", lastUpdated: cache.lastUpdated }));

// ─── Atualiza a cada 15 minutos ──────────────────────────────────────────────
cron.schedule("*/15 * * * *", updateCache);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`EVA Feed rodando na porta ${PORT}`);
  await updateCache();
});
