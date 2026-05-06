import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import TelegramBot from "node-telegram-bot-api";
import XLSX from "xlsx";
import fs from "fs";
import { parse } from "csv-parse/sync";
import pino from "pino"; // ✅ v7 এ দরকার



// 🧠 GLOBAL QR STOCK
const qrStock = {
  qr: null,
  createdAt: 0,
  expiresAt: 0
};

// ⏳ QR validity (30 seconds)
const QR_TTL = 30 * 1000;

// 🔑 Telegram Token
const TG_TOKEN = "8147527849:AAFsV5c6hSRNUSqDTDeyVcu6JgCR78SiVIY";
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// 🔒 Owner lock
const OWNER_ID = 7015071638;

// 📢 Channel Info
const CHANNEL_ID = -1002241385522; 
const CHANNEL_LINK = "https://t.me/+OZL1iWf-vEpiNzE1";


// ⏱ bot start time
const BOT_START_TIME = Math.floor(Date.now() / 1000);

// 📲 Pairing 
const waitingForPairNumber = new Set();

const pairingMessages = new Map();
// chatId => { number, messageId }

// 🟢 STATE
let sock = null;
let isConnected = false;
let authState = null;
let saveCredsFn = null;
let connectRetryCount = 0;

// chatId => { qrList: [{qr, sentTimes, timestamp}], currentIndex }
const qrUsers = new Map();

const AUTH_DIR = "./auth";
const USERS_FILE = "./users.json";
const QR_WIDTH = 400;
const QR_EXPIRE_MS = 120000; 
const MAX_EXPORT = 2000;
const CONNECT_RETRY_BASE_MS = 2000;

// 🚫 BLOCK SYSTEM
const BLOCK_FILE = "./blockedUsers.json";

let blockedUsers = new Set();

// load blocked users
if (fs.existsSync(BLOCK_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE, "utf8"));
    blockedUsers = new Set(data);
  } catch {}
}

// save blocked users
function saveBlockedUsers() {
  fs.writeFileSync(BLOCK_FILE, JSON.stringify([...blockedUsers], null, 2));
}


// prevent multiple checking from same user
const activeChecks = new Set();

// ✅ Verified Users
const VERIFIED_FILE = "./verifiedUsers.json";
let verifiedUsers = new Set();
if (fs.existsSync(VERIFIED_FILE)) {
  try { verifiedUsers = new Set(JSON.parse(fs.readFileSync(VERIFIED_FILE, "utf8"))); } catch {}
}
function saveVerifiedUsers() {
  fs.writeFileSync(VERIFIED_FILE, JSON.stringify([...verifiedUsers], null, 2));
}

// 🔍 Channel Membership
async function isUserInChannel(userId){
  try {
    const member = await bot.getChatMember(CHANNEL_ID,userId);
    return ["member","administrator","creator"].includes(member.status);
  } catch { return false; }
}

// ❌ Force Join
async function sendJoinMessage(chatId){
  return bot.sendMessage(chatId, "👋 Welcome!\n\n🔑 To use this bot, please join our channel first:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Join Channel", url: CHANNEL_LINK }],
        [{ text: "✅ Verify", callback_data: "verify" }]
      ]
    }
  });
}

// ---------------- UTILITIES ----------------
function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");
}

function loadUsers() {
  try { ensureUsersFile(); return JSON.parse(fs.readFileSync(USERS_FILE, "utf8") || "[]"); } catch { return []; }
}

function saveUsers(list) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(new Set(list)), null, 2)); } catch {}
}

function addUser(chatId) {
  const list = loadUsers();
  if (!list.includes(chatId)) list.push(chatId);
  saveUsers(list);
}

// ✅ Normalize
function normalizeNumber(raw) {
  if (!raw) return null;

  let n = raw.toString().trim();

  // remove all non-digit characters (+, space, -, etc.)
  n = n.replace(/\D+/g, "");

  return n.length ? n : null;
}

// ✅ Format for display
function formatNumberForDisplay(num) {
  return num.startsWith("+") ? num : "+" + num;
}

function showTerminalQR(qr) {
  try { qrcodeTerminal.generate(qr, { small: false }); } catch {}
}

// ensure auth directory exists before using baileys
function ensureAuthDir() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (e) {
    console.error("Failed to create auth dir:", e);
  }
}

// safe sleep
function sleep(ms) { 
  return new Promise(res => setTimeout(res, ms)); 
}

function hasValidSession() {
  return fs.existsSync(AUTH_DIR + "/creds.json");
}

// 🔥 FORCE FRESH WHATSAPP SESSION
async function forceFreshSession(reason = "unknown") {
  console.log("🔥 Force fresh session:", reason);

  try {
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.ws?.close?.(); } catch {}
      sock = null;
    }
  } catch {}

  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {}

  isConnected = false;

  qrStock.qr = null;
  qrStock.createdAt = 0;
  qrStock.expiresAt = 0;

  await connectWA(true);
}


async function getTelegramUser(chatId) {
  try {
    const user = await bot.getChat(chatId);

    return {
      id: user.id,
      name: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
      username: user.username ? "@" + user.username : "N/A"
    };
  } catch {
    return {
      id: chatId,
      name: "Unknown",
      username: "N/A"
    };
  }
}



// 🌐 WhatsApp Connect
async function connectWA(forceNew = false) {

  if (hasValidSession() && forceNew) {
    console.log("🛑 Session exists. forceNew ignored.");
    forceNew = false;
  }

  if (sock && isConnected && !forceNew) return;

  ensureAuthDir();

  if (forceNew) {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  }

  try {
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.ws?.close?.(); } catch {}
      sock = null;
    }
  } catch {}

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    authState = state;
    saveCredsFn = saveCreds;

    sock = makeWASocket({
      auth: authState,
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    sock.ev.on("creds.update", saveCredsFn);

    sock.ev.on("connection.update", async (update) => {
      try {
        const { qr, connection, lastDisconnect } = update;

        // ✅ QR STOCK
        if (qr) {
          qrStock.qr = qr;
          qrStock.createdAt = Date.now();
          qrStock.expiresAt = Date.now() + QR_TTL;
          showTerminalQR(qr);
        }

        // 🟢 CONNECTED
        if (connection === "open") {
          isConnected = true;
          connectRetryCount = 0;
          console.log("WhatsApp connection open");

          const connectedNumber = sock.user?.id?.split(":")[0];
          const waName = sock.user?.name || "Unknown";

          for (const [chatId, data] of pairingMessages.entries()) {

            if (!pairingMessages.has(chatId)) continue;

            if (connectedNumber && connectedNumber.endsWith(data.number.slice(-10))) {

              // 🔥 GET TELEGRAM USER INFO
              let tgName = "Unknown";
              let tgUsername = "N/A";

              try {
                const tg = await bot.getChat(chatId);
                tgName = `${tg.first_name || ""} ${tg.last_name || ""}`.trim();
                tgUsername = tg.username ? "@" + tg.username : "N/A";
              } catch {}

              // 🔥 DELETE OLD MESSAGE
              try {
                await bot.deleteMessage(chatId, data.messageId);
              } catch {}

              // ✅ USER MESSAGE
              await bot.sendMessage(
                chatId,
`✅ *WhatsApp Connected Successfully*

━━━━━━━━━━━━━━━
📱 ${connectedNumber}
👤 ${waName}

━━━━━━━━━━━━━━━
⚡ Session Active`,
                { parse_mode: "Markdown" }
              );

              // 🔥 OWNER LOG
              await bot.sendMessage(
                OWNER_ID,
`🔗 *NEW CONNECTION*

━━━━━━━━━━━━━━━
👤 User: ${tgName}
🆔 ID: ${chatId}
🔗 Username: ${tgUsername}

📱 Number: ${connectedNumber}
💬 WA Name: ${waName}

━━━━━━━━━━━━━━━
✅ Status: Connected`,
                { parse_mode: "Markdown" }
              );

              pairingMessages.delete(chatId);
            }
          }
        }

        // 🔴 DISCONNECTED
        if (connection === "close") {
          isConnected = false;

          const statusCode =
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.statusCode ||
            lastDisconnect?.error?.status;

          const connectedNumber = sock?.user?.id?.split(":")[0] || "Unknown";
          const waName = sock?.user?.name || "Unknown";

          let reason = "Disconnected";

          if (statusCode === DisconnectReason.loggedOut) {
            reason = "Logged Out";
          } else if (statusCode === 403) {
            reason = "Banned";
          }

          // 🔥 OWNER ALERT
          await bot.sendMessage(
            OWNER_ID,
`⚠️ *WHATSAPP SESSION CLOSED*

━━━━━━━━━━━━━━━
📱 Number: ${connectedNumber}
👤 Name: ${waName}

📛 Status: ${reason}

━━━━━━━━━━━━━━━`,
            { parse_mode: "Markdown" }
          );

          // 🚫 Invalid / Logged out / Banned
          if (
            statusCode === DisconnectReason.badSession ||
            statusCode === DisconnectReason.loggedOut ||
            statusCode === 403
          ) {
            console.log("Session invalid or logged out. Cleaning up...");
            try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
            await connectWA(true);
            return;
          }

          // 🔁 Reconnect
          connectRetryCount++;

          const waitMs = Math.min(
            60000,
            CONNECT_RETRY_BASE_MS * (2 ** Math.min(connectRetryCount, 6))
          );

          console.log(`Reconnecting in ${waitMs}ms (attempt ${connectRetryCount})`);

          setTimeout(() => connectWA(false), waitMs);
        }

      } catch (e) {
        console.error("connection.update handler error:", e);
      }
    });

  } catch (err) {
    console.error("connectWA error:", err);
    connectRetryCount++;

    const waitMs = Math.min(
      60000,
      CONNECT_RETRY_BASE_MS * (2 ** Math.min(connectRetryCount, 6))
    );

    console.log(`connectWA failed — retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return connectWA(false);
  }
}



async function sendPairingCode(chatId, phoneNumber) {
  try {
    // 🔒 Already connected
    if (isConnected) {
      return bot.sendMessage(chatId,
`✅ *Already Connected*

Your WhatsApp session is already active.`,
      { parse_mode: "Markdown" });
    }

    // 📞 Clean number
    const cleanNumber = phoneNumber.replace(/\D/g, '');

    // 🔹 Ensure socket
    if (!sock) await connectWA(false);

    await bot.sendMessage(chatId,
`⏳ Preparing pairing code...`,
    { parse_mode: "Markdown" });

    // 🔥 Wait socket ready
    let retries = 0;
    while (!sock) {
      await sleep(500);
      retries++;

      if (retries > 20) {
        return bot.sendMessage(chatId,
`❌ Connection failed. Try again.`,
        { parse_mode: "Markdown" });
      }
    }

    await sleep(2000);

    // ✅ Generate code
    const code = await sock.requestPairingCode(cleanNumber);
    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

    let timeLeft = 60;

    const baseText = (time) => 
`🔗 Pairing Code: \`${formattedCode}\`

1️⃣ Open WhatsApp  
2️⃣ Go to Linked Devices  
3️⃣ Tap Link a Device  
4️⃣ Select Link with phone number  
5️⃣ Paste the code  

⏳ Expires in: ${time}s`;

    // 📩 Send first message
    const sent = await bot.sendMessage(chatId, baseText(timeLeft), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 Get New Code", callback_data: "retry_pair" },
            { text: "❌ Cancel", callback_data: "cancel_pair" }
          ]
        ]
      }
    });

    // 🔥 SAVE pairing
    pairingMessages.set(chatId, {
      number: cleanNumber,
      messageId: sent.message_id
    });

    // 🔥 COUNTDOWN LOOP
    const interval = setInterval(async () => {

      // 🔥 যদি already connect হয়ে যায় → stop
      if (!pairingMessages.has(chatId)) {
        clearInterval(interval);
        return;
      }

      timeLeft -= 10;

      // ❌ EXPIRED
      if (timeLeft <= 0) {
        clearInterval(interval);

        // 🔥 SERVER SIDE OFF (MOST IMPORTANT)
        pairingMessages.delete(chatId);

        // ✅ UI থাকবে (delete না)
        try {
          await bot.editMessageText(
`❌ Expired

🔄 Send /pair to get a new code`,
            {
              chat_id: chatId,
              message_id: sent.message_id
            }
          );
        } catch {}

        return;
      }

      // ⏳ UPDATE MESSAGE
      try {
        await bot.editMessageText(
          baseText(timeLeft),
          {
            chat_id: chatId,
            message_id: sent.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "🔄 Get New Code", callback_data: "retry_pair" },
                  { text: "❌ Cancel", callback_data: "cancel_pair" }
                ]
              ]
            }
          }
        );
      } catch {}

    }, 10000);

  } catch (err) {
    console.error(err);

    bot.sendMessage(chatId,
`❌ Failed to generate pairing code

Try again or use /qr`,
    { parse_mode: "Markdown" });
  }
}





// 📷 QR HANDLER (Concurrent & Fresh)
const generatingQR = new Map(); // chatId => Promise

async function sendFreshQR(chatId) {
  // prevent multiple QR generation for same user simultaneously
  if (generatingQR.has(chatId)) return generatingQR.get(chatId);

  const qrPromise = (async () => {
    try {
      // if already connected, no QR needed
      if (isConnected) {
        await bot.sendMessage(chatId, "✅ WhatsApp already connected. QR not required.");
        return;
      }

      // if live QR exists in stock, send it
      if (qrStock.qr && Date.now() < qrStock.expiresAt) {
        const buf = await QRCode.toBuffer(qrStock.qr, { type: "png", width: QR_WIDTH });
        const keyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "🎥 How to Connect WhatsApp",
          url: "https://t.me/FoXyWs/908"   // 👈 এখানে তোমার ভিডিও লিঙ্ক
        }
      ],
      [
        {
          text: "🔄 Get New QR",
          callback_data: "get_new_qr"
        }
      ]
    ]
  }
};

        await bot.sendPhoto(chatId, buf, { 
          caption: `📷 *WhatsApp Login Required*

⚠️ *Step-by-Step Instructions:*

1️⃣ Open your WhatsApp app  
2️⃣ Tap Menu (⋮) ➝ Linked Devices  
3️⃣ Tap "Link a Device"  
4️⃣ Scan the QR code below 🔳`,
          parse_mode: "Markdown",
          ...keyboard 
        });
        return;
      }

      // global QR generation lock
      if (generatingQR.has("GLOBAL")) {
        await generatingQR.get("GLOBAL");
      } else {
        const genPromise = (async () => {
          try {
            await connectWA(false);
            let attempts = 0;
            while (!qrStock.qr && attempts < 20) {
              await sleep(100);
              attempts++;
            }
          } finally {
            generatingQR.delete("GLOBAL");
          }
        })();
        generatingQR.set("GLOBAL", genPromise);
        await genPromise;
      }

      if (!qrStock.qr) {
        await bot.sendMessage(chatId, "❌ QR generation failed. Try again.");
        return;
      }

      const buf = await QRCode.toBuffer(qrStock.qr, { type: "png", width: QR_WIDTH });
      const keyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "🎥 How to Connect WhatsApp",
          url: "https://t.me/FoXyMx2/867"   // 👈 এখানে তোমার ভিডিও লিঙ্ক
        }
      ],
      [
        {
          text: "🔄 Get New QR",
          callback_data: "get_new_qr"
        }
      ]
    ]
  }
};

      await bot.sendPhoto(chatId, buf, { 
        caption: `📷 *WhatsApp Login Required*

⚠️ *Step-by-Step Instructions:*

1️⃣ Open your WhatsApp app  
2️⃣ Tap Menu (⋮) ➝ Linked Devices  
3️⃣ Tap "Link a Device"  
4️⃣ Scan the QR code below 🔳`,
        parse_mode: "Markdown",
        ...keyboard 
      });

    } catch (err) {
      console.error("sendFreshQR error:", err);
      await bot.sendMessage(chatId, "❌ QR generation failed. Try again.");
    } finally {
      generatingQR.delete(chatId); // allow next request
    }
  })();

  generatingQR.set(chatId, qrPromise);
  return qrPromise;
}

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const inChannel = await isUserInChannel(chatId);
  if(!inChannel) return sendJoinMessage(chatId);

  if(!verifiedUsers.has(chatId)){
    verifiedUsers.add(chatId);
    saveVerifiedUsers();
  }

  if (chatId === OWNER_ID && !isConnected) await connectWA();

  const welcomeText =
    `👋 Welcome ${msg.from?.first_name || "User"}!\n\n` +
    `📥 Send numbers (single/multiple) or upload files: .txt, .csv, .xlsx\n\n` +
    `✅ Bot checks instantly & sends report.\n\n` +
    `ℹ️ Legend:\n✅ = Registered\n❌ = Not registered`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ FoXyPrefix", url: "https://t.me/FoXyPrefix_bot" },
          { text: "🆘 Support", url: "https://t.me/FOXyChatSupport" }
        ],
        [
          { text: "❓ How to Use", callback_data: "how_to_use" },
          { text: "💬 Bot Status", url: "https://t.me/FoXyWs" }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, welcomeText, keyboard);
});

// 📘 Handle callback buttons
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);

  if (data === "how_to_use") {
    await bot.sendMessage(chatId,
      "🎬 *Step-by-Step Guide*\n\n" +
      "▶️ Learn how to use the bot easily.\n" +
      "📹 Watch here: https://t.me/FoXyWs/867",
      { parse_mode: "Markdown" }
    );
  }

  if (data === "verify") {
    const inChannel = await isUserInChannel(chatId);
    if(inChannel){
      verifiedUsers.add(chatId);
      saveVerifiedUsers();
      await bot.sendMessage(chatId, `✅ Verification successful! Welcome ${query.from.first_name || "User"}!`);
      if(chatId === OWNER_ID && !isConnected) await connectWA();
    } else {
      await sendJoinMessage(chatId);
    }
  }

  if (data === "qr_generate" || data === "get_new_qr") {
    if (!qrUsers.has(chatId)) qrUsers.set(chatId, { qrList: [], currentIndex: 0 });

    if (isConnected) {
        await bot.sendMessage(chatId, "✅ WhatsApp session is active. No QR needed right now.");
    } else {
        await sendFreshQR(chatId);
    }
  }

  // ❌ Cancel Pairing
  if (data === "cancel_pair") {
    waitingForPairNumber.delete(chatId);

    await bot.sendMessage(
      chatId,
      "Pairing cancelled."
    );
  }

  // 🔁 Retry Pairing
  if (data === "retry_pair") {
    waitingForPairNumber.add(chatId);

    await bot.sendMessage(
      chatId,
      "Enter your WhatsApp number to continue.\n\nMake sure the number is active and correct.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Cancel", callback_data: "cancel_pair" }
            ]
          ]
        }
      }
    );
  }

});

// ----------------COMMAND ----------------




bot.onText(/\/pair$/, async (msg) => {
  const chatId = msg.chat.id;

  const inChannel = await isUserInChannel(chatId);
  if (!inChannel) return sendJoinMessage(chatId);

  // already connected
  if (isConnected) {
    return bot.sendMessage(chatId, "WhatsApp already connected.");
  }

  // prevent duplicate request
  if (waitingForPairNumber.has(chatId)) {
    return bot.sendMessage(chatId, "Send your WhatsApp number.");
  }

  // mark user as waiting for number
  waitingForPairNumber.add(chatId);

  await bot.sendMessage(
    chatId,
`📱 *WhatsApp Pairing*

Send your WhatsApp number with country code.

Examples:
BD: +880XXXXXXXXXX or 880XXXXXXXXXX
IN: +91XXXXXXXXXX or 91XXXXXXXXXX

+ is optional.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Cancel", callback_data: "cancel_pair" },
            { text: "Retry", callback_data: "retry_pair" }
          ]
        ]
      }
    }
  );

  // ⏱ auto cancel after 30 sec
  setTimeout(() => {
    if (waitingForPairNumber.has(chatId)) {
      waitingForPairNumber.delete(chatId);
      bot.sendMessage(chatId, "Pairing cancelled.");
    }
  }, 30000);
});




// 🛑 Stop Bot (Owner only)
bot.onText(/\/stopbot/, async (msg) => {

  const chatId = msg.chat.id;

  if (chatId !== OWNER_ID) {
    return bot.sendMessage(chatId, "❌ Unauthorized.");
  }

  await bot.sendMessage(chatId, "🛑 Bot is shutting down...\n\nStart again from terminal.");

  process.exit(0);

});

//-----------------------------------------------------

// 🚫 block user
bot.onText(/\/block (\d+)/, (msg, match) => {

  if (msg.chat.id !== OWNER_ID) return;

  const id = Number(match[1]);

  blockedUsers.add(id);
  saveBlockedUsers();

  bot.sendMessage(msg.chat.id, `🚫 User blocked:\n${id}`);

});

// ✅ unblock user
bot.onText(/\/unblock (\d+)/, (msg, match) => {

  if (msg.chat.id !== OWNER_ID) return;

  const id = Number(match[1]);

  blockedUsers.delete(id);
  saveBlockedUsers();

  bot.sendMessage(msg.chat.id, `✅ User unblocked:\n${id}`);

});

// 📋 block list
bot.onText(/\/blocklist/, (msg) => {

  if (msg.chat.id !== OWNER_ID) return;

  const list = [...blockedUsers].join("\n") || "No blocked users.";

  bot.sendMessage(msg.chat.id, `🚫 Blocked Users:\n\n${list}`);

});
//-----------------------------------------------------


// 📢 BROADCAST MESSAGE (TEXT ONLY)
bot.onText(/\/broadcast (.+)/s, async (msg, match) => {

  const chatId = msg.chat.id;

  if (chatId !== OWNER_ID) return;

  const message = match[1];

  const users = loadUsers();

  if (!users.length) {
    return bot.sendMessage(chatId, "❌ No users found.");
  }

  await bot.sendMessage(chatId, `📢 Sending message to ${users.length} users...`);

  let sent = 0;
  let failed = 0;

  for (const userId of users) {

    try {

      await bot.sendMessage(userId, message);

      sent++;

      await new Promise(r => setTimeout(r, 40)); // anti flood

    } catch {

      failed++;

    }

  }

  bot.sendMessage(
    chatId,
`✅ Broadcast Completed

👥 Total Users: ${users.length}
📤 Sent: ${sent}
❌ Failed: ${failed}`
  );

});

// ---------------- COMMAND ----------------





// ---------------- /qr COMMAND ----------------
bot.onText(/\/qr/i, async (msg) => {

// 🚫 ignore old /qr messages
  if (msg.date < BOT_START_TIME) return;
  
  const chatId = msg.chat.id;

  // ✅ already connected → no QR
  if (isConnected) {
    if (chatId === OWNER_ID) {
      await bot.sendMessage(
        OWNER_ID,
        "✅ WhatsApp already connected."
      );
    }
    return;
  }

  // ✅ if QR already exists in stock → reuse it
  if (qrStock.qr && Date.now() < qrStock.expiresAt) {
    await sendFreshQR(chatId); // this will send STOCK QR, not new
    return;
  }

  // 🔄 try normal connect (NO force reset)
  await connectWA(false);

  // ⏱️ wait max 2 seconds for QR
  let waited = 0;
  while (!qrStock.qr && waited < 2000) {
    await sleep(200);
    waited += 200;
  }

  // ❌ still no QR → THEN force reset
  if (!qrStock.qr) {
    await forceFreshSession("qr_no_stock");
    await sleep(1000);
  }

  await sendFreshQR(chatId);
});

// ✅ Check Numbers
async function checkNumbers(numbers, chatId) {
  let limitExceeded = false;
  if (numbers.length > 100) {
    limitExceeded = true;
    numbers = numbers.slice(0, 100);
  }

  let results = [];
  let progressMsg = await bot.sendMessage(chatId, `⏳ Progress: 0/${numbers.length}`);
  const frames = ["⏳", "⌛"];
  let frameIndex = 0;
  let done = 0;

  for (const raw of numbers) {
    const num = normalizeNumber(raw);
    if (!num) {
      done++;
      try { await bot.editMessageText(`Progress: ${done}/${numbers.length}`, { chat_id: chatId, message_id: progressMsg.message_id }); } catch {}
      continue;
    }
    try {
      const res = await sock.onWhatsApp(num + "@s.whatsapp.net");
      const exists = Array.isArray(res) ? !!res[0]?.exists : !!res?.exists;
      results.push({ number: formatNumberForDisplay(num), status: exists ? "REGISTERED" : "NOT_REGISTERED" });
    } catch (e) {
      results.push({ number: formatNumberForDisplay(num), status: "ERROR" });
    }
    done++;
    frameIndex = (frameIndex + 1) % frames.length;
    try {
      await bot.editMessageText(`${frames[frameIndex]} Progress: ${done}/${numbers.length}`, {
        chat_id: chatId,
        message_id: progressMsg.message_id
      });
    } catch {}
  }

// ⏳ Progress Auto delete Off try { await bot.deleteMessage(chatId, progressMsg.message_id); } catch {}

  return { results, limitExceeded };
}

// 📄 Send Results
async function sendResults(chatId, checkData) {
  const results = checkData.results;
  const limitExceeded = checkData.limitExceeded;

  const registered = results.filter(r => r.status === "REGISTERED").map(r => r.number);
  const notRegistered = results.filter(r => r.status !== "REGISTERED").map(r => r.number);

  let reply = "";
  
  // Registered numbers
  for (const num of registered) {
    reply += `✅ ${num.replace(/^\+/, '')}\n`;
  }

  reply += "━━━━━━━━━━━━━\n";
  reply += `🔴 Not Registered [ ${notRegistered.length} ]\n\n`;

  for (const num of notRegistered) {
    reply += `❌ ${num.startsWith("+") ? num : "+" + num}\n`;
  }

  await bot.sendMessage(chatId, reply);
  
  // Excel export
  try {
    const ws = XLSX.utils.json_to_sheet(results);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    const outPath = `./result_${Date.now()}.xlsx`;
    XLSX.writeFile(wb, outPath);
    await bot.sendDocument(chatId, outPath, {}, { filename: "WhatsApp_Report.xlsx" });
    fs.unlinkSync(outPath);
    
    // ⚠️ Stylish Limit Warning
    if (limitExceeded) {
      const warningMsg =
        "⚠️ *Attention!* ⚠️\n\n" +
        "🚨 You submitted more than *100 numbers*!\n\n" +
        "✅ Only the first *100 numbers* were checked.\n\n" +
        "💡 Keep submissions within 100 for faster & smoother results.";
      await bot.sendMessage(chatId, warningMsg, { parse_mode: "Markdown" });
    }
  } catch (e) {
    console.error("Excel file error:", e);
  }
}


// 📂 File Handling 
bot.on("document", async (msg) => {
//return bot.sendMessage(msg.chat.id, "⚠️ File/number checking is currently disabled.");
  const chatId = msg.chat.id;
  addUser(chatId);

  const inChannel = await isUserInChannel(chatId);
  if(!inChannel) return sendJoinMessage(chatId);

  if (!msg.document) return;
  if (!isConnected || !sock)
    return bot.sendMessage(chatId, "⚠️ WhatsApp not connected. Use /qr first.");

  try {
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || `file_${Date.now()}`;
    const tmpPath = `./tmp_${Date.now()}_${fileName}`;

    // ---------------- Get file from Telegram ----------------
    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) {
      return bot.sendMessage(chatId, "❌ Could not get file path from Telegram.");
    }
    const fileURL = `https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`;
    const res = await fetch(fileURL);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpPath, buf);

    // ---------------- Read numbers from file ----------------
    let numbers = [];
    if (fileName.endsWith(".txt")) {
      numbers = fs.readFileSync(tmpPath, "utf8")
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);
    } else if (fileName.endsWith(".csv")) {
      const records = parse(fs.readFileSync(tmpPath), {
        columns: false,
        skip_empty_lines: true
      });
      numbers = records.flat().map(String);
    } else if (fileName.match(/\.xlsx|\.xls$/)) {
      const wb = XLSX.readFile(tmpPath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      numbers = XLSX.utils.sheet_to_json(sheet, { header: 1 })
        .flat()
        .map(String)
        .filter(Boolean);
    } else {
      fs.unlinkSync(tmpPath);
      return bot.sendMessage(chatId, "❌ Unsupported file type. Use txt/csv/xlsx");
    }
    fs.unlinkSync(tmpPath);

    // ---------------- Clean & normalize numbers ----------------
    numbers = numbers
      .map(n => n.replace(/[^0-9+]/g, ""))
      .map(n => (n.startsWith("+") ? n.slice(1) : n))
      .filter(n => /^\d+$/.test(n));

    numbers = [...new Set(numbers)]; // remove duplicates

    if (numbers.length === 0)
      return bot.sendMessage(chatId, "❌ No valid numbers found.");

    // ---------------- Randomly pick 100 ----------------
    let numbersToCheck;
    if (numbers.length > 100) {
      numbersToCheck = numbers
        .map((num, idx) => ({ num, line: idx + 1 })) // লাইন নম্বর যোগ
        .sort(() => Math.random() - 0.5)
        .slice(0, 100);
    } else {
      numbersToCheck = numbers.map((num, idx) => ({ num, line: idx + 1 }));
    }

    // ---------------- Send initial progress message ----------------
    const progressMsg = await bot.sendMessage(
      chatId,
      `✨ WhatsApp Check ✨
────────────────────
📊 Total Numbers: ${numbers.length}
🎯 Selected: ${numbersToCheck.length}
📁 File Index: [ 0 ]
────────────────────
⏳ Progress: 0/${numbersToCheck.length}`
    );

    // ---------------- Check numbers one by one ----------------
    let done = 0;
    let results = [];
    const frames = ["⏳", "⌛"];
    let frameIndex = 0;

    for (const item of numbersToCheck) {
      const num = normalizeNumber(item.num);
      if (!num) continue;

      let status = "NOT REGISTERED";
      try {
        const res = await sock.onWhatsApp(num + "@s.whatsapp.net");
        const exists = Array.isArray(res) ? !!res[0]?.exists : !!res?.exists;
        status = exists ? "REGISTERED" : "NOT REGISTERED";
      } catch {
        status = "ERROR";
      }

      results.push({ number: formatNumberForDisplay(num), status });
      done++;
      frameIndex = (frameIndex + 1) % frames.length;

      // ---------------- Update progress message ----------------
      try {
        await bot.editMessageText(
          `✨ WhatsApp Check ✨
────────────────────
📊 Total Numbers: ${numbers.length}
🎯 Selected: ${numbersToCheck.length}
📁 File Index: [ ${item.line} ]
────────────────────
${frames[frameIndex]} Progress: ${done}/${numbersToCheck.length}`,
          { chat_id: chatId, message_id: progressMsg.message_id }
        );
      } catch {}
    }

    // ---------------- Replace progress message with Completed ----------------
    try {
      await bot.editMessageText(
        `✨ WhatsApp Check ✨
────────────────────
📊 Total Numbers: ${numbers.length}
🎯 Selected: ${numbersToCheck.length}
📁 File Index: [ ${numbersToCheck[numbersToCheck.length-1].line} ]
────────────────────
✅ Completed!`,
        { chat_id: chatId, message_id: progressMsg.message_id }
      );
    } catch {}

    // ---------------- Prepare final results message ----------------
    let reply = "";
    const registered = results.filter(r => r.status === "REGISTERED");
    registered.forEach(r => { 
        reply += `✅ ${r.number.replace(/^\+/, "")}\n`; // REGISTERED 
    });

    const notRegistered = results.filter(r => r.status === "NOT REGISTERED" || r.status === "ERROR");
    if (notRegistered.length > 0) {
        reply += "---------------------\n";
        reply += `🔴 Not Registered [ ${notRegistered.length} ]\n\n`; 
        notRegistered.forEach(r => {
            let num = r.number.startsWith("+") ? r.number : "+" + r.number;
            reply += `❌ ${num}\n`;
        });
    }

    // ---------------- Send results separately ----------------
    if (reply) await bot.sendMessage(chatId, reply);

  } catch (e) {
    console.error("document handler error:", e);
    bot.sendMessage(chatId, "❌ Failed to process file. Make sure it's a valid txt/csv/xlsx.");
  }
});

// 📄 Text Message
bot.on("message", async (msg) => {

  // 🚫 ignore old messages before bot start
  if (msg.date < BOT_START_TIME) return;

  const chatId = msg.chat.id;

  // 📲 Handle pairing number input
  if (waitingForPairNumber.has(chatId)) {

    // ❌ ignore commands like /pair
    if (!msg.text || msg.text.startsWith("/")) return;

    const phoneNumber = normalizeNumber(msg.text);

    // ❌ invalid number
    if (!phoneNumber || !/^\d{10,15}$/.test(phoneNumber)) {

      // 🔁 keep user in pairing mode
      waitingForPairNumber.add(chatId);

      return bot.sendMessage(
        chatId,
        "⚠️ *Invalid Number*\n\nPlease enter a valid WhatsApp number with country code.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Cancel", callback_data: "cancel_pair" }
              ]
            ]
          }
        }
      );
    }

    // ✅ valid → stop waiting
    waitingForPairNumber.delete(chatId);

    return sendPairingCode(chatId, phoneNumber);
  }

  // 🚫 BLOCKED USER CHECK
  if (blockedUsers.has(chatId)) {
    return bot.sendMessage(
      chatId,
`🚫 *Access Restricted*

Your account has been added to the bot blacklist.

You are currently not allowed to use this service.

━━━━━━━━━━━━━━
📩 Support: @FOXyChatSupport`,
      { parse_mode: "Markdown" }
    );
  }

  if (msg.text && msg.text.startsWith("/start")) return;

  // ✅ channel join check
  const inChannel = await isUserInChannel(chatId);
  if(!inChannel) return sendJoinMessage(chatId);

  if (msg.document || !msg.text || msg.text.startsWith("/")) return;

  addUser(chatId);

  // 🔒 prevent multiple checks
  if (chatId !== OWNER_ID) {

    if (activeChecks.has(chatId)) {
      return bot.sendMessage(
        chatId,
        "⏳ *Please wait...*\n\nYour previous check is still processing.\nKindly wait until it finishes before sending new numbers.",
        { parse_mode: "Markdown" }
      );
    }

    activeChecks.add(chatId);
  }

  try {

    if (!isConnected || !sock) {
      return bot.sendMessage(
        chatId,
`⚠️ *WhatsApp Not Connected*

━━━━━━━━━━━━━━━
Your session is currently inactive.

📲 *Connect using:*
• /qr   → Scan QR Code  
• /pair → Enter phone number  

━━━━━━━━━━━━━━━
⚡ Connect now to continue.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📷 Generate QR", callback_data: "qr_generate" },
                { text: "🔑 Pairing Code", callback_data: "retry_pair" }
              ],
              [
                { text: "📖 How To Connect", url: "https://t.me/FoXyWs/908" }
              ]
            ]
          }
        }
      );
    }

    const numbers = msg.text
      .split(/[\n, ,]+/)
      .map(x => x.trim())
      .filter(x => /^\+?\d+$/.test(x));

    if (!numbers.length) return;

    const checkData = await checkNumbers(numbers, chatId);

    await sendResults(chatId, checkData);

  } catch (err) {

    console.error("Check error:", err);
    await bot.sendMessage(chatId, "❌ An error occurred while checking numbers.");

  } finally {

    if (chatId !== OWNER_ID) {
      activeChecks.delete(chatId);
    }

  }

});

// ---------------- STARTUP ----------------
ensureUsersFile();
(async () => {
  try {
    await connectWA(false);
    console.log("Bot started. Telegram polling active.");
  } catch (e) {
    console.error("Startup error:", e);
  }
})();

// 🌟 Keep bot running
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
