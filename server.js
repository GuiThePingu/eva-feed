const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

const BURN_VAULT_ADDRESS = "0x8FAE092a9Bbc7E4036C8c815c821E450A3E359F8";
const WBTC_ADDRESS       = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const HISTORY_FILE       = path.join(__dirname, "history.json");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];
const VAULT_ABI = [
  "function remainingEvaCovered() view returns (uint256)"
];

const provider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc");

// ─── Carrega ou inicializa histórico ─────────────────────────────────────────
function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  }
  return [];
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

let cache = { burnPriceUSD: null, burnPriceSats: null, premiumRatio: null, wbtcInVault: null, evaGuaranteed: null, marketPriceUSD: null, btcUSD: null, lastUpdated: null, error: null };

// ─── Preços via CoinGecko ─────────────────────────────────────────────────────
async function fetchPrices() {
  const res  = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,evervalue-coin&vs_currencies=usd",
    { headers: { "Accept": "application/json", "User-Agent": "eva-feed/1.0" } });
  const data = await res.json();
  return { btcUSD: data["bitcoin"]?.usd ?? null, evaUSD: data["evervalue-coin"]?.usd ?? null };
}

// ─── Coleta dados e salva no histórico ───────────────────────────────────────
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
    const burnPriceUSD = btcUSD ? parseFloat((burnPriceBTC * btcUSD).toFixed(4)) : null;
    const premiumRatio = (evaUSD && burnPriceUSD) ? parseFloat(((evaUSD - burnPriceUSD) / burnPriceUSD * 100).toFixed(2)) : null;

    cache = { burnPriceUSD, burnPriceBTC: parseFloat(burnPriceBTC.toFixed(10)), burnPriceSats, premiumRatio, wbtcInVault: parseFloat(wbtcInVault.toFixed(8)), evaGuaranteed: parseFloat(evaGuaranteed.toFixed(2)), marketPriceUSD: evaUSD, btcUSD, lastUpdated: new Date().toISOString(), error: null };

    // ─── Salva um ponto por dia no histórico ─────────────────────────────────
    const today = new Date().toISOString().slice(0, 10); // "2026-06-13"
    const history = loadHistory();
    const existingIndex = history.findIndex(h => h.date === today);
    const point = { date: today, burnPriceUSD, burnPriceSats, burnPriceBTC: parseFloat(burnPriceBTC.toFixed(10)), marketPriceUSD: evaUSD, btcUSD, wbtcInVault: parseFloat(wbtcInVault.toFixed(8)), evaGuaranteed: parseFloat(evaGuaranteed.toFixed(2)), premiumRatio };

    if (existingIndex >= 0) {
      history[existingIndex] = point; // atualiza o dia atual
    } else {
      history.push(point); // adiciona novo dia
    }
    saveHistory(history);

    console.log(`[${today}] BTC: $${btcUSD} | Burn: $${burnPriceUSD} (${burnPriceSats} sats) | EVA: $${evaUSD} | Premium: ${premiumRatio}%`);
  } catch (err) {
    console.error("Erro:", err.message);
    cache.error = err.message;
    cache.lastUpdated = new Date().toISOString();
  }
}

// ─── Rotas ───────────────────────────────────────────────────────────────────
app.get("/eva",         (req, res) => res.json(cache));
app.get("/eva/history", (req, res) => {
  const history = loadHistory();
  const days = parseInt(req.query.days) || 365;
  res.json(history.slice(-days)); // ex: /eva/history?days=90
});

// Rota para o Pine Script — retorna CSV com date,burnPriceSats,marketPriceSats
app.get("/eva/csv", (req, res) => {
  const history = loadHistory();
  const days = parseInt(req.query.days) || 365;
  const slice = history.slice(-days);
  let csv = "date,burnPriceUSD,burnPriceSats,marketPriceUSD,premiumRatio,wbtcInVault,evaGuaranteed\n";
  for (const h of slice) {
    csv += `${h.date},${h.burnPriceUSD ?? ""},${h.burnPriceSats ?? ""},${h.marketPriceUSD ?? ""},${h.premiumRatio ?? ""},${h.wbtcInVault ?? ""},${h.evaGuaranteed ?? ""}\n`;
  }
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

app.get("/eva/burn-price", (req, res) => res.json({ value: cache.burnPriceUSD }));
app.get("/eva/burn-sats",  (req, res) => res.json({ value: cache.burnPriceSats }));
app.get("/eva/premium",    (req, res) => res.json({ value: cache.premiumRatio }));
app.get("/eva/guaranteed", (req, res) => res.json({ value: cache.evaGuaranteed }));
app.get("/eva/wbtc-vault", (req, res) => res.json({ value: cache.wbtcInVault }));
app.get("/health",         (req, res) => res.json({ status: "ok", lastUpdated: cache.lastUpdated, historyDays: loadHistory().length }));

cron.schedule("*/15 * * * *", updateCache);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`EVA Feed rodando na porta ${PORT}`);
  await updateCache();
});
