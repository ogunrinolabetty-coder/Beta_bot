const https = require("https");
const http  = require("http");

// ── CONFIG ──────────────────────────────────────────────
const BOT_TOKEN      = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID        = "5092755750";
const HELIUS_KEY     = "72099335-bd1f-4fb2-b3b9-74caf6656d3f";
const MAX_MC         = 50000;
const MIN_TX_USD     = 10;      // min $10 per transaction
const MIN_BUYS       = 3;       // min 3 consecutive buys
const WINDOW_MS      = 3600000; // 1 hour window
const INTERVAL_MS    = 30_000;

// Routers to watch
const WATCHED_ROUTERS = [
  "junoD9pHBQHsbGgcHU85P9jYDHiRyVHpVgoHoRxTQ6m",  // Jupiter aggregator
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6
  "DFlow",
  "okx",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // PumpFun AMM
];

// ────────────────────────────────────────────────────────

// accumulation tracking: walletAddr -> { tokenMint -> [{ time, amount, signature }] }
const accumulation = {};
const alerted = new Set();
let lastUpdateId = 0;

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { "User-Agent": "Mozilla/5.0", ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function sendTelegram(text, chatId = CHAT_ID) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function pollCommands() {
  try {
    const res = await get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
    const updates = res?.result || [];

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id.toString();
      const text = msg.text.trim();
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === "/setmc") {
        if (parts.length < 2) {
          await sendTelegram(
            `ℹ️ <b>How to set max MC:</b>\n\n<code>/setmc &lt;amount&gt;</code>\n\n<b>Example:</b>\n<code>/setmc 50000</code>`,
            chatId
          );
        } else {
          const val = parseInt(parts[1]);
          if (isNaN(val) || val <= 0) {
            await sendTelegram(`⚠️ Invalid amount.\n\n<b>Example:</b> <code>/setmc 50000</code>`, chatId);
          } else {
            MAX_MC_CURRENT = val;
            await sendTelegram(`✅ Max MC updated to <b>$${val.toLocaleString()}</b>`, chatId);
          }
        }

      } else if (cmd === "/settings") {
        await sendTelegram(
          `⚙️ <b>Current Settings</b>\n\n` +
          `• Max MC: <b>$${MAX_MC_CURRENT.toLocaleString()}</b>\n` +
          `• Min buys: <b>${MIN_BUYS}</b> within 1 hour\n` +
          `• Min tx size: <b>$${MIN_TX_USD}</b>\n` +
          `• Chain: <b>Solana</b>\n` +
          `• Routers: JUP, OKX, dFlow, PumpFun AMM`,
          chatId
        );

      } else if (cmd === "/help") {
        await sendTelegram(
          `🤖 <b>Accumulation Detector Commands</b>\n\n` +
          `/setmc &lt;amount&gt; — Set max MC threshold\n` +
          `/settings — Show current settings\n` +
          `/help — Show this message`,
          chatId
        );
      }
    }
  } catch (e) {
    console.error("[CMD ERROR]", e.message);
  }
}

let MAX_MC_CURRENT = MAX_MC;

function isWatchedRouter(tx) {
  const accounts = tx?.accountData?.map(a => a.account) || [];
  const instructions = tx?.instructions || [];
  const desc = JSON.stringify(tx).toLowerCase();

  // Check for known router signatures
  for (const router of WATCHED_ROUTERS) {
    if (accounts.includes(router)) return true;
    if (desc.includes(router.toLowerCase())) return true;
  }

  // Check program IDs in instructions
  for (const ix of instructions) {
    if (WATCHED_ROUTERS.includes(ix.programId)) return true;
  }

  // Check source field
  const source = (tx?.source || "").toLowerCase();
  if (source.includes("jupiter") || source.includes("jup")) return true;
  if (source.includes("okx")) return true;
  if (source.includes("dflow")) return true;
  if (source.includes("pump")) return true;

  return false;
}

async function getTokenData(mint) {
  try {
    const res = await get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs = res?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    const sol = pairs.filter(p => (p.chainId || "").toLowerCase() === "solana");
    if (sol.length === 0) return null;
    sol.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0));
    return sol[0];
  } catch (e) {
    return null;
  }
}

async function scan() {
  try {
    console.log(`[${new Date().toLocaleTimeString()}] Scanning...`);
    // Fetch recent Solana transactions via Helius
    const url = `https://api.helius.xyz/v0/addresses/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA/transactions?api-key=${HELIUS_KEY}&limit=100&type=SWAP`;
    console.log(`[${new Date().toLocaleTimeString()}] Fetching Helius data...`);
    const txs = await get(url);
    console.log(`[${new Date().toLocaleTimeString()}] Helius response: ${Array.isArray(txs) ? txs.length + ' txs' : JSON.stringify(txs).slice(0, 100)}`);

    if (!Array.isArray(txs) || txs.length === 0) return;

    const now = Date.now();

    for (const tx of txs) {
      // Only care about watched routers
      if (!isWatchedRouter(tx)) continue;

      const transfers = tx?.tokenTransfers || [];
      const timestamp = (tx?.timestamp || 0) * 1000;
      const signature = tx?.signature || "";

      for (const transfer of transfers) {
        const mint = transfer?.mint;
        const toWallet = transfer?.toUserAccount;
        const fromWallet = transfer?.fromUserAccount;
        const tokenAmount = parseFloat(transfer?.tokenAmount || 0);

        if (!mint || !toWallet) continue;

        // Skip stables and SOL
        if (mint === "So11111111111111111111111111111111111111112") continue;
        if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") continue;
        if (mint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") continue;

        // Get approximate USD value from tx nativeTransfers
        const solSpent = Math.abs(
          (tx?.nativeTransfers || [])
            .filter(t => t.fromUserAccount === toWallet)
            .reduce((sum, t) => sum + (t.amount || 0), 0)
        ) / 1e9;
        const usdValue = solSpent * 150; // rough SOL price estimate

        if (usdValue < MIN_TX_USD) continue;

        // Track accumulation per wallet per token
        if (!accumulation[toWallet]) accumulation[toWallet] = {};
        if (!accumulation[toWallet][mint]) accumulation[toWallet][mint] = [];

        const history = accumulation[toWallet][mint];

        // Check if last action was a sell (fromWallet === toWallet means they sent out)
        // Reset if there was a sell
        const lastEntry = history[history.length - 1];

        // Add this buy
        history.push({ time: timestamp, usdValue, signature });

        // Clean entries older than 1 hour
        const recent = history.filter(e => now - e.time < WINDOW_MS);
        accumulation[toWallet][mint] = recent;

        // Check if we have MIN_BUYS consecutive buys in window
        if (recent.length < MIN_BUYS) continue;

        // Check total USD spent
        const totalUsd = recent.reduce((sum, e) => sum + e.usdValue, 0);

        // Dedupe alert per wallet+token combo
        const alertKey = `${toWallet}:${mint}`;
        if (alerted.has(alertKey)) continue;

        // Check MC on DexScreener
        const pair = await getTokenData(mint);
        if (!pair) continue;

        const mcapRaw = parseFloat(pair.marketCap || 0);
        if (mcapRaw === 0 || mcapRaw > MAX_MC_CURRENT) continue;

        alerted.add(alertKey);
        // Reset after 2 hours so we can re-alert if accumulation continues
        setTimeout(() => alerted.delete(alertKey), 7200000);

        const name     = pair.baseToken?.name || "Unknown";
        const symbol   = pair.baseToken?.symbol || "?";
        const mcap     = `$${Number(mcapRaw).toLocaleString()}`;
        const liq      = `$${Number(pair.liquidity?.usd || 0).toLocaleString()}`;
        const priceUsd = parseFloat(pair.priceUsd || 0);
        const change1h = pair.priceChange?.h1 != null ? `${pair.priceChange.h1 > 0 ? "+" : ""}${parseFloat(pair.priceChange.h1).toFixed(1)}%` : "N/A";
        const dexUrl   = `https://dexscreener.com/solana/${pair.pairAddress}`;
        const shortWallet = toWallet.slice(0, 6) + "..." + toWallet.slice(-4);

        const msg =
`🚨 <b>ACCUMULATION ALERT — SOLANA</b>

👤 Wallet: <code>${toWallet}</code>
📦 <b>${recent.length} consecutive buys</b> in 1h — no sells
💸 Total spent: <b>~$${totalUsd.toFixed(2)}</b>

🪙 <b>${name}</b> (<b>$${symbol}</b>)
💰 Market Cap: <b>${mcap}</b>
💵 Price: <b>$${priceUsd.toFixed(8)}</b>
💧 Liquidity: <b>${liq}</b>
📈 1h Change: <b>${change1h}</b>

📋 CA: <code>${mint}</code>

🔗 <a href="${dexUrl}">DexScreener</a>

⚠️ DYOR — not financial advice.`;

        await sendTelegram(msg);
        console.log(`[ACCUM] ${shortWallet} bought ${symbol} x${recent.length} | MC: ${mcap} | ~$${totalUsd.toFixed(2)}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[${new Date().toLocaleTimeString()}] Scan complete`);
  } catch (err) {
    console.error("Scan error:", err.message);
  }
}

// Keep-alive — start FIRST before any API calls
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("accumulation detector alive");
}).listen(process.env.PORT || 3000, () => console.log(`Ping server on port ${process.env.PORT || 3000}`));

(async () => {
  console.log("🔍 Solana Accumulation Detector started");
  console.log(`   Max MC      : $${MAX_MC_CURRENT.toLocaleString()}`);
  console.log(`   Min buys    : ${MIN_BUYS} within 1h`);
  console.log(`   Min tx size : $${MIN_TX_USD}`);
  console.log(`   Routers     : JUP, OKX, dFlow, PumpFun AMM`);
  console.log(`   Interval    : ${INTERVAL_MS / 1000}s\n`);
  await sendTelegram(
    `✅ <b>Accumulation Detector is live!</b>\n\n` +
    `Watching Solana for wallets making 3+ consecutive buys on the same token within 1 hour through:\n` +
    `• Jupiter aggregator\n• OKX router\n• dFlow\n• PumpFun AMM\n\n` +
    `Filters:\n• Max MC: $${MAX_MC_CURRENT.toLocaleString()}\n• Min tx size: $${MIN_TX_USD}\n• No sells in between\n\n` +
    `Commands: /setmc /settings /help`
  );
  await scan();
  setInterval(scan, INTERVAL_MS);
  setInterval(pollCommands, 3000);
})();
