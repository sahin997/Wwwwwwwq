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

//_______________________________________
import {
  getMainKeyboard,
  handleButtons,
  showMenu,
  isButtonMessage
} from "./Button.js";
//-----------------------------------------------------


// 🔥 AUTO VERIFY SYSTEM
const joinMessageStore = new Map(); // chatId => message_id
const autoVerifyIntervals = new Map(); // chatId => interval


// 🔑 Telegram Token
const TG_TOKEN = "8454140094:AAFPtdn3Cu0t7O5iZBZbg6mUsxYnL1_uCSU";
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// 🔒 Owner lock
const OWNER_ID = 7015071638;

// 📢 Channel Info
// 🔥 MULTI CHANNEL SYSTEM
const CHANNEL_1 = -1002241385522;
const CHANNEL_2 = -1003068363952;
const CHANNEL_3 = -1002985131272;

const CHANNEL_LINK_1 = "https://t.me/FoXyWs";
const CHANNEL_LINK_2 = "https://t.me/FoXyMx2";
const CHANNEL_LINK_3 = "https://t.me/FoXyMX4";

//_______________________________________
//setupMgv(bot, OWNER_ID, CHANNEL_ID);

//setupBroadcast(bot, OWNER_ID);
//_______________________________________
// ⏱ bot start time
const EXPIRE_IMAGE_PATH = "./assets/qr_expired.png";
const BOT_START_TIME = Math.floor(Date.now() / 1000);


const userSessions = new Map();
// chatId => { qrList: [{qr, sentTimes, timestamp}], currentIndex }

// 🔥 GLOBAL (উপরে add কর)
const userPrefix = new Map();
const userAction = new Map();

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


// 🔥 MULTI CHANNEL CHECK (FIXED & SAFE)
async function checkAllChannels(userId) {
  const channels = [
    { id: CHANNEL_1, link: CHANNEL_LINK_1, name: "Channel 1" },
    { id: CHANNEL_2, link: CHANNEL_LINK_2, name: "Channel 2" },
    { id: CHANNEL_3, link: CHANNEL_LINK_3, name: "Channel 3" }
  ];

  let notJoined = [];

  for (const ch of channels) {
    try {
      const member = await bot.getChatMember(ch.id, userId);

      if (!member || !["member", "administrator", "creator"].includes(member.status)) {
        notJoined.push(ch);
      }

    } catch (err) {
      // 🔥 যদি error হয় (bot not admin / user not found) → consider not joined
      notJoined.push(ch);
    }
  }

  return notJoined;
}



// 🔥 AUTO JOIN UI + AUTO VERIFY (PRO VERSION)
async function sendJoinMessage(chatId) {

  const notJoined = await checkAllChannels(chatId);

  // ✅ সব join করা থাকলে
  if (notJoined.length === 0) return true;

  // 🔘 keyboard তৈরি
  const keyboard = notJoined.map(ch => [
    { text: `📢 Join ${ch.name}`, url: ch.link }
  ]);

  keyboard.push([
    { text: "⏳ Auto Checking...", callback_data: "ignore" }
  ]);

  // 🔥 পুরাতন message delete
  const oldMsgId = joinMessageStore.get(chatId);
  if (oldMsgId) {
    try {
      await bot.deleteMessage(chatId, oldMsgId);
    } catch {}
  }

  // 📩 নতুন message
  const sent = await bot.sendMessage(
    chatId,
`👋 Welcome!

🔐 Join all channels to continue

🎯 Remaining: ${notJoined.length}/3

⚡ Joined channels will disappear automatically`,
    {
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );

  // 🔥 message store
  joinMessageStore.set(chatId, sent.message_id);

  // 🔁 পুরান interval clear
  if (autoVerifyIntervals.has(chatId)) {
    clearInterval(autoVerifyIntervals.get(chatId));
    autoVerifyIntervals.delete(chatId);
  }

  // 🔥 START AUTO VERIFY
  startAutoVerify(chatId);

  return false;
}


// 🔥 AUTO VERIFY FUNCTION (PLACE RIGHT AFTER sendJoinMessage)
function startAutoVerify(chatId) {

  // 🔁 prevent duplicate interval
  if (autoVerifyIntervals.has(chatId)) {
    clearInterval(autoVerifyIntervals.get(chatId));
  }

  const interval = setInterval(async () => {

    try {
      const notJoined = await checkAllChannels(chatId);
      const msgId = joinMessageStore.get(chatId);

      if (!msgId) return;

      // ✅ সব join complete
      if (notJoined.length === 0) {

        clearInterval(interval);
        autoVerifyIntervals.delete(chatId);
        joinMessageStore.delete(chatId);

        verifiedUsers.add(chatId);
        saveVerifiedUsers();

        await bot.sendMessage(chatId,
`✅ Verified Successfully!

🎉 All channels joined.

🚀 You can now use the bot.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Start", callback_data: "start_now" }]
            ]
          }
        });

        return;
      }

      // 🔄 UI update (joined channel remove)
      const keyboard = notJoined.map(ch => [
        { text: `📢 Join ${ch.name}`, url: ch.link }
      ]);

      keyboard.push([
        { text: "⏳ Checking...", callback_data: "ignore" }
      ]);

      await bot.editMessageReplyMarkup(
        { inline_keyboard: keyboard },
        {
          chat_id: chatId,
          message_id: msgId
        }
      );

    } catch (e) {
      // silent fail (important)
    }

  }, 3000); // ⏱ প্রতি 3 সেকেন্ডে check

  autoVerifyIntervals.set(chatId, interval);
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
  let n = (raw || "").toString().replace(/\D+/g, "");
  return n || null;
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



// 🧠 check if user has valid session
function hasValidSession(userId) {
  const authDir = `./auth/${userId}`;
  return fs.existsSync(authDir + "/creds.json");
}


// 🔥 FORCE FRESH SESSION (Multi User)
async function forceFreshSession(userId, reason = "unknown") {

  console.log(`🔥 Force fresh session: ${userId} | Reason: ${reason}`);

  const session = userSessions.get(userId);
  const AUTH_DIR = `./auth/${userId}`;

  // 🔌 close existing socket
  try {
    if (session?.sock) {
      try { session.sock.ev.removeAllListeners(); } catch {}
      try { session.sock.ws?.close?.(); } catch {}
    }
  } catch {}

  // 🗑 delete auth folder
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {}

  // 🧹 remove session from memory
  userSessions.delete(userId);

  // 🔄 reconnect fresh
  await connectWA(userId, true);
}


// 🌐 WhatsApp Connect
async function connectWA(userId, forceNew = false) {

  const AUTH_DIR = `./auth/${userId}`;

  // ensure auth dir exists
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
  } catch (e) {
    console.error("Auth dir error:", e);
  }

  let session = userSessions.get(userId);

  // 🛑 prevent duplicate connection
  if (session && session.sock && session.isConnected && !forceNew) {
    return session.sock;
  }

  // 🔥 force fresh session
  if (forceNew) {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  }

  // 🔌 close old socket if exists
  if (session?.sock) {
    try { session.sock.ev.removeAllListeners(); } catch {}
    try { session.sock.ws?.close?.(); } catch {}
  }

  try {

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["FoXyMx","Chrome","121.0"],
      syncFullHistory: false
    });

    // 🧠 new session object
    session = {
      sock,
      isConnected: false,
      qr: null,
      retry: 0
    };

    userSessions.set(userId, session);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {

      try {
        const { qr, connection, lastDisconnect } = update;

        // 📷 store QR per user
        if (qr) {
          session.qr = qr;
          showTerminalQR(qr); // optional
        }

        // 🟢 CONNECTED
        if (connection === "open") {
          session.isConnected = true;
          session.retry = 0;
          console.log(`✅ Connected: ${userId}`);
        }

        // 🔴 DISCONNECTED
        if (connection === "close") {

          session.isConnected = false;

          const statusCode =
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.statusCode ||
            lastDisconnect?.error?.status;

          // ❌ invalid session → reset
          if (
            statusCode === DisconnectReason.badSession ||
            statusCode === DisconnectReason.loggedOut ||
            statusCode === 403
          ) {
            console.log(`❌ Session expired: ${userId}`);
            userSessions.delete(userId);

            await connectWA(userId, true);
            return;
          }

          // 🔁 retry reconnect
          session.retry++;

          const waitMs = Math.min(
            60000,
            CONNECT_RETRY_BASE_MS * (2 ** Math.min(session.retry, 6))
          );

          console.log(`🔁 Reconnecting ${userId} in ${waitMs}ms`);

          setTimeout(() => connectWA(userId, false), waitMs);
        }

      } catch (e) {
        console.error("connection.update error:", e);
      }

    });

    return sock;

  } catch (err) {

    console.error("connectWA error:", err);

    const retry = (session?.retry || 0) + 1;

    const waitMs = Math.min(
      60000,
      CONNECT_RETRY_BASE_MS * (2 ** Math.min(retry, 6))
    );

    console.log(`Retrying ${userId} in ${waitMs}ms`);

    await sleep(waitMs);
    return connectWA(userId, false);
  }
}


const generatingQR = new Map();
const qrTimers = new Map(); 
const lastQRMessage = new Map();

async function sendFreshQR(chatId, forceNew = false) {

  // 🔥 prevent stuck QR lock (FIX)
  if (generatingQR.has(chatId)) {
    try {
      await generatingQR.get(chatId);
    } catch {}
    generatingQR.delete(chatId);
  }

  const qrPromise = (async () => {
    try {

      let session = userSessions.get(chatId);

      // 🔥 force new QR (button click)
      if (forceNew) {
        await forceFreshSession(chatId, "manual_refresh");
        session = userSessions.get(chatId);
      }

      // 🔌 create connection
      if (!session) {
        await connectWA(chatId);
        session = userSessions.get(chatId);
      }

      // ✅ already connected
      if (session?.isConnected) {
        await bot.sendMessage(chatId, "✅ WhatsApp already connected.");
        return;
      }

      // 🔥 WAIT QR (improved stability)
      let attempts = 0;
      while ((!session?.qr) && attempts < 50) {
        await sleep(200);
        session = userSessions.get(chatId);
        attempts++;
      }

      if (!session?.qr) {
        await bot.sendMessage(chatId, "❌ QR generation failed. Try again.");
        return;
      }

      // 📷 QR image
      const buf = await QRCode.toBuffer(session.qr, {
        type: "png",
        width: QR_WIDTH
      });

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎥 How to Connect WhatsApp",
                url: "https://t.me/FoXyWs/908"
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

      let timeLeft = 60;

      // 🧹 delete old QR message
      if (lastQRMessage.has(chatId)) {
        try {
          await bot.deleteMessage(chatId, lastQRMessage.get(chatId));
        } catch {}
      }

      const sentMsg = await bot.sendPhoto(chatId, buf, {
        caption: `📷 *WhatsApp Login Required*

⚠️ *Step-by-Step Instructions:*

1️⃣ Open your WhatsApp app  
2️⃣ Tap Menu (⋮) ➝ Linked Devices  
3️⃣ Tap "Link a Device"  
4️⃣ Scan the QR code below 🔳

⏳ *Expires in: ${timeLeft}s*`,
        parse_mode: "Markdown",
        ...keyboard
      });

      lastQRMessage.set(chatId, sentMsg.message_id);

      // 🔥 clear old timer properly (FIX)
      if (qrTimers.has(chatId)) {
        clearInterval(qrTimers.get(chatId));
        qrTimers.delete(chatId);
      }

      const interval = setInterval(async () => {
        try {
          timeLeft -= 10;

          // ⛔ expire
          if (timeLeft <= 0) {
            clearInterval(interval);
            qrTimers.delete(chatId);

            if (fs.existsSync(EXPIRE_IMAGE_PATH)) {

              try {
                await bot.deleteMessage(chatId, sentMsg.message_id);
              } catch {}

              await bot.sendPhoto(chatId, EXPIRE_IMAGE_PATH, {
                caption: `❌ *QR Expired*

🔄 Please generate a new QR code.`,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "🔄 Get New QR",
                        callback_data: "get_new_qr"
                      }
                    ]
                  ]
                }
              });

            } else {

              await bot.editMessageCaption(
                `❌ *QR Expired*

🔄 Please generate a new QR code.`,
                {
                  chat_id: chatId,
                  message_id: sentMsg.message_id,
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: "🔄 Get New QR",
                          callback_data: "get_new_qr"
                        }
                      ]
                    ]
                  }
                }
              );
            }

            return;
          }

          // 🔄 update timer
          await bot.editMessageCaption(
            `📷 *WhatsApp Login Required*

⚠️ *Step-by-Step Instructions:*

1️⃣ Open your WhatsApp app  
2️⃣ Tap Menu (⋮) ➝ Linked Devices  
3️⃣ Tap "Link a Device"  
4️⃣ Scan the QR code below 🔳

⏳ *Expires in: ${timeLeft}s*`,
            {
              chat_id: chatId,
              message_id: sentMsg.message_id,
              parse_mode: "Markdown",
              reply_markup: keyboard.reply_markup
            }
          );

        } catch (e) {
          // 🔥 silent fail (prevent crash)
        }
      }, 10000);

      qrTimers.set(chatId, interval);

    } catch (err) {
      console.error("sendFreshQR error:", err);
      await bot.sendMessage(chatId, "❌ QR generation failed. Try again.");
    } finally {
      generatingQR.delete(chatId);
    }
  })();

  generatingQR.set(chatId, qrPromise);
  return qrPromise;
}

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const joinOk = await sendJoinMessage(chatId);
  if (!joinOk) return;

  if(!verifiedUsers.has(chatId)){
    verifiedUsers.add(chatId);
    saveVerifiedUsers();
  }

  // ✅ FIX: use session instead of global isConnected
  const session = userSessions.get(chatId);
  if (chatId === OWNER_ID && !session?.isConnected) {
    await connectWA(chatId);
  }

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


// 📘 Handle callback buttons (FINAL CLEAN VERSION)
bot.on("callback_query", async (query) => {

  const chatId = query.message.chat.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  // 📖 HOW TO USE
  if (data === "how_to_use") {
    return bot.sendMessage(
      chatId,
      "🎬 *Step-by-Step Guide*\n\n" +
      "▶️ Learn how to use the bot easily.\n" +
      "📹 Watch here: https://t.me/FoXyWs/908",
      { parse_mode: "Markdown" }
    );
  }

  // 🚀 START BUTTON (AUTO VERIFY SYSTEM)
  if (data === "start_now") {

    // 🔐 ensure user joined সব channel
    const joinOk = await sendJoinMessage(chatId);
    if (!joinOk) return;

    // ✅ mark verified
    if (!verifiedUsers.has(chatId)) {
      verifiedUsers.add(chatId);
      saveVerifiedUsers();
    }

    // 🔌 connect WhatsApp (owner only)
    const session = userSessions.get(chatId);
    if (chatId === OWNER_ID && !session?.isConnected) {
      await connectWA(chatId);
    }

    const welcomeText =
      `👋 Welcome ${query.from?.first_name || "User"}!\n\n` +
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

    return bot.sendMessage(chatId, welcomeText, keyboard);
  }

  // 📷 QR GENERATE
  if (data === "qr_generate" || data === "get_new_qr") {

    const session = userSessions.get(chatId);

    if (session?.isConnected) {
      return bot.sendMessage(
        chatId,
        "✅ WhatsApp session is active. No QR needed right now."
      );
    }

    if (data === "get_new_qr") {
      return sendFreshQR(chatId, true);
    }

    return sendFreshQR(chatId);
  }

});

// ----------------COMMAND ----------------


bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    "🎛 *Main Menu*\n\nChoose an option below 👇",
    {
      parse_mode: "Markdown",
      ...getMainKeyboard()
    }
  );
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


// ---------------- COMMAND ----------------





// ---------------- /qr COMMAND ----------------
bot.onText(/\/qr/i, async (msg) => {

  if (msg.date < BOT_START_TIME) return;

  const chatId = msg.chat.id;

  const session = userSessions.get(chatId);

  // ✅ already connected
  if (session?.isConnected) {
    return bot.sendMessage(chatId, "✅ WhatsApp already connected.");
  }

  // 🔄 just send QR (auto handle করবে)
  await sendFreshQR(chatId);

});

// ✅ Check Numbers
async function checkNumbers(numbers, chatId) {
  let limitExceeded = false;
  if (numbers.length > 100) {
    limitExceeded = true;
    numbers = numbers.slice(0, 100);
  }

  // ✅ FIX: get user-specific socket
  const session = userSessions.get(chatId);
  const sock = session?.sock;

  if (!sock || !session?.isConnected) {
    return { results: [], limitExceeded };
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
    reply += `✅ \`${num.replace(/^\+/, '')}\`\n`;
  }

  reply += "━━━━━━━━━━━━━\n";
  reply += `🔴 Not Registered [ ${notRegistered.length} ]\n\n`;

  for (const num of notRegistered) {
    const formatted = num.startsWith("+") ? num : "+" + num;
    reply += `❌ \`${formatted}\`\n`;
  }

  await bot.sendMessage(chatId, reply, {
    parse_mode: "Markdown"
  });
  
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

  const chatId = msg.chat.id;
  addUser(chatId);

  const joinOk = await sendJoinMessage(chatId);
  if (!joinOk) return;

  if (!msg.document) return;

  // ✅ FIX: per-user session check
  const session = userSessions.get(chatId);
  const sock = session?.sock;

  if (!session?.isConnected || !sock)
    return bot.sendMessage(chatId, "⚠️ WhatsApp not connected. Use /qr first.");

  try {

    // 🔥 RESET EVERY FILE
    userPrefix.delete(chatId);
    userAction.delete(chatId);

    // 🔘 SHOW BUTTON (UPDATED)
    await bot.sendMessage(chatId,
`⚙️ *Choose Option*

Select how you want to proceed:

🔢 Set Prefix — Filter numbers by prefix  
▶️ Start Checking — Run without filter`,
{
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔢 Set Prefix", callback_data: "set_prefix" }],
      [{ text: "▶️ Start Checking", callback_data: "start_check" }]
    ]
  }
});

    // 🔥 WAIT UNTIL USER CLICK (FIXED)
    const waitUser = () => new Promise(resolve => {
      const interval = setInterval(() => {
        const action = userAction.get(chatId);

        if (action === "start") {
          clearInterval(interval);
          resolve();
        }
      }, 500);
    });

    await waitUser();

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || `file_${Date.now()}`;
    const tmpPath = `./tmp_${Date.now()}_${fileName}`;

    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) {
      return bot.sendMessage(chatId, "❌ Could not get file path from Telegram.");
    }

    const fileURL = `https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`;
    const res = await fetch(fileURL);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpPath, buf);

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

    numbers = numbers
      .map(n => n.replace(/[^0-9+]/g, ""))
      .map(n => (n.startsWith("+") ? n.slice(1) : n))
      .filter(n => /^\d+$/.test(n));

    numbers = [...new Set(numbers)];

    if (numbers.length === 0)
      return bot.sendMessage(chatId, "❌ No valid numbers found.");

    let prefix = userPrefix.get(chatId);
    if (prefix) {
      numbers = numbers
        .filter(n => n.startsWith(prefix))
        .filter(n => n.length > prefix.length);
    }

    if (numbers.length === 0)
      return bot.sendMessage(chatId, "❌ No numbers matched prefix.");

    let numbersToCheck;

    if (numbers.length > 100) {
      numbersToCheck = numbers
        .map((num, idx) => ({ num, line: idx + 1 }))
        .sort(() => Math.random() - 0.5)
        .slice(0, 100);
    } else {
      numbersToCheck = numbers.map((num, idx) => ({ num, line: idx + 1 }));
    }

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

    let reply = "";

    const registered = results.filter(r => r.status === "REGISTERED");
    registered.forEach(r => {
      reply += `✅ ${r.number.replace(/^\+/, "")}\n`;
    });

    const notRegistered = results.filter(r => r.status !== "REGISTERED");

    if (notRegistered.length > 0) {
      reply += "---------------------\n";
      reply += `🔴 Not Registered [ ${notRegistered.length} ]\n\n`;

      notRegistered.forEach(r => {
        let num = r.number.startsWith("+") ? r.number : "+" + r.number;
        reply += `❌ ${num}\n`;
      });
    }

    if (reply) await bot.sendMessage(chatId, reply);

    userPrefix.delete(chatId);
    userAction.delete(chatId);

  } catch (e) {
    console.error("document handler error:", e);
    bot.sendMessage(chatId, "❌ Failed to process file. Make sure it's valid.");
  }
});


// 🔘 BUTTON HANDLER (FIXED FINAL)
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;

  // 🔢 SET PREFIX MODE
  if (q.data === "set_prefix") {
    userAction.set(chatId, "waiting_prefix");

    return bot.sendMessage(chatId,
`🔢 *Prefix Filter (Optional)*

Send digits to filter numbers  
Or skip to check normally  

Example:
017 → 017XXXXXXXX
123 → 123XXXXXXX`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Skip Prefix", callback_data: "cancel_prefix" }]
        ]
      }
    });
  }

  // ▶️ START CHECK (NO PREFIX)
  if (q.data === "start_check") {
    userPrefix.delete(chatId); // 🔥 IMPORTANT
    userAction.set(chatId, "start");

    return bot.sendMessage(chatId, "⏳ Checking started...");
  }

  // ❌ SKIP PREFIX
  if (q.data === "cancel_prefix") {
    userPrefix.delete(chatId); // 🔥 IMPORTANT
    userAction.set(chatId, "start");

    return bot.sendMessage(chatId,
`⚡ Prefix skipped

⏳ Checking started...`);
  }
});


// 🔤 PREFIX INPUT (100% SAFE SYSTEM)
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  // 🔥 ONLY prefix mode এ কাজ করবে
  if (userAction.get(chatId) !== "waiting_prefix") return;

  const text = (msg.text || "").trim();
  const prefix = text.replace(/[^0-9]/g, "");

  // ❌ invalid input
  if (!prefix) {
    return bot.sendMessage(chatId, "❌ Please send a valid numeric prefix.");
  }

  // ✅ SAVE PREFIX ONLY (NO SMART LOGIC)
  userPrefix.set(chatId, prefix);

  // 🔥 MOVE TO START MODE
  userAction.set(chatId, "start");

  return bot.sendMessage(chatId,
`Ws check ⌛️:
✅ Prefix saved successfully

🔢 Prefix: ${prefix}

⏳ Checking started...`);
});

// 📄 Text Message
bot.on("message", async (msg) => {

  // 🚫 ignore old messages before bot start
  if (msg.date < BOT_START_TIME) return;

  const chatId = msg.chat.id;

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
  const joinOk = await sendJoinMessage(chatId);
  if (!joinOk) return;

  // 🚫 ignore non-text / document / commands
  if (msg.document || !msg.text || msg.text.startsWith("/")) return;

  // 🔥 BUTTON FIRST
  await handleButtons(msg, bot, userSessions);

  // 🚫 STOP if it's a button
  if (isButtonMessage(msg)) return;

  // 🔥🔥🔥 PREFIX SYSTEM FIX
  const action = userAction.get(chatId);

  // prefix লিখার সময় → skip
  if (action === "waiting_prefix") return;

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

    // ✅ FIX: per-user session
    const session = userSessions.get(chatId);
    const sock = session?.sock;

    if (!session?.isConnected || !sock) {
      return bot.sendMessage(
        chatId,
`⚠️ *WhatsApp Connection Required*

The WhatsApp session is currently not connected.

Please generate a QR code and connect your WhatsApp account to continue.

Use command: /qr`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📷 Generate QR", callback_data: "qr_generate" },
                { text: "📖 How To Connect", url: "https://t.me/FoXyWs/908" }
              ]
            ]
          }
        }
      );
    }

    // 🔥 FIX: prefix apply করা
    let numbers = msg.text
      .split(/[\n, ,]+/)
      .map(x => x.trim())
      .filter(x => /^\+?\d+$/.test(x));

    if (!numbers.length) return;

    // ✅ APPLY PREFIX HERE (MAIN FIX)
    const prefix = userPrefix.get(chatId);
    if (prefix) {
      numbers = numbers
        .map(n => n.replace(/^\+/, "")) // remove +
        .filter(n => n.startsWith(prefix))
        .filter(n => n.length > prefix.length);
    }

    if (!numbers.length) {
      return bot.sendMessage(chatId, "❌ No numbers matched prefix.");
    }

    const checkData = await checkNumbers(numbers, chatId);

    await sendResults(chatId, checkData);

    // 🔥 reset after success
    userPrefix.delete(chatId);
    userAction.delete(chatId);

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
ensureAuthDir(); // ✅ ensure auth root

(async () => {
  try {
    console.log("🚀 Bot starting...");

    // 🔄 restore previous sessions (VERY IMPORTANT)
    const users = loadUsers();

    for (const userId of users) {
      try {
        if (hasValidSession(userId)) {
          console.log(`♻️ Restoring session for ${userId}`);
          await connectWA(userId);
        }
      } catch (e) {
        console.error(`Restore failed for ${userId}:`, e);
      }
    }

    console.log("✅ Bot started successfully. Telegram polling active.");

  } catch (e) {
    console.error("❌ Startup error:", e);
    process.exit(1);
  }
})();
