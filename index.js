import express from "express";
import makeWASocket, { useMultiFileAuthState } from "baileys";
import TelegramBot from "node-telegram-bot-api";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import fs from "fs";
import XLSX from "xlsx";
import { parse } from "csv-parse/sync";


// ---------------------------- CONFIG ----------------------------
const TG_TOKEN = "7661508132:AAFZFJ_Lgg3QOt0kRSwi-6eNxebHKFDUsLI";       // Telegram Bot Token
const OWNER_ID = 5992380428;                   // Telegram ID of bot owner/admin
const CHANNEL_ID = -1003042574670;            // Telegram Channel ID
const CHANNEL_LINK = "https://t.me/tskwoegehks72";

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Bot is running fine!");
});

app.listen(PORT, () => {
  console.log(`🚀 Express server running on port ${PORT}`);
});

// ---------------------------- BOT INIT ----------------------------
const bot = new TelegramBot(TG_TOKEN, { polling: true });
let sock;
let isConnected = false;
let adminNotified = false;

// ---------------------------- VERIFIED USERS ----------------------------
let verifiedUsers = new Set();
const VERIFIED_FILE = "./verifiedUsers.json";
if (fs.existsSync(VERIFIED_FILE)) {
  try { verifiedUsers = new Set(JSON.parse(fs.readFileSync(VERIFIED_FILE, "utf8"))); }
  catch { verifiedUsers = new Set(); }
}
function saveVerifiedUsers() {
  fs.writeFileSync(VERIFIED_FILE, JSON.stringify([...verifiedUsers], null, 2));
}

// ---------------------------- HELPER FUNCTIONS ----------------------------
function normalizeNumber(raw) {
  const n = (raw || "").toString().replace(/\D+/g, "");
  return n || null;
}

function formatNumber(num) {
  return num.startsWith("+") ? num : num;
}

async function isUserInChannel(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch { return false; }
}

async function sendJoinMessage(chatId) {
  return bot.sendMessage(chatId, `👋 Welcome!\n\n🔑 Please join the channel to use this bot:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Join Channel", url: CHANNEL_LINK }],
        [{ text: "✅ Verify", callback_data: "verify" }]
      ]
    }
  });
}

// ---------------------------- WHATSAPP CONNECTION ----------------------------
async function resetAuthAndReconnect(chatId) {
  try { if(sock?.ev) sock.ev.removeAllListeners(); if(sock?.ws?.close) sock.ws.close(); } catch {}
  fs.rmSync("./auth", { recursive: true, force: true });
  await bot.sendMessage(chatId, "⚠️ WhatsApp session ended. Generating new QR...");
  setTimeout(() => connectWA(chatId), 1000);
}

async function showQRCode(qr, chatId) {
  try {
    qrcodeTerminal.generate(qr, { small: true });
    const buf = await QRCode.toBuffer(qr, { type: "png", width: 400 });
    await bot.sendPhoto(chatId, buf, { caption: "📷 Scan this QR code in WhatsApp → Linked Devices." });
  } catch {}
}

async function connectWA(chatId) {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    sock = makeWASocket({ auth: state, printQRInTerminal: false });
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
      if (qr && chatId === OWNER_ID) await showQRCode(qr, chatId);

      if (connection === "open") {
        isConnected = true;
        if (!adminNotified) {
          await bot.sendMessage(OWNER_ID, "✅ WhatsApp session is active!");
          adminNotified = true;
        }
      }

      if (connection === "close") {
        isConnected = false;
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) await resetAuthAndReconnect(chatId);
        else setTimeout(()=>connectWA(chatId), 5000);
      }
    });
  } catch {
    setTimeout(()=>connectWA(chatId), 5000);
  }
}

// ---------------------------- CHECK NUMBERS ----------------------------
async function checkNumber(num) {
  try {
    const result = await sock.onWhatsApp(num + "@s.whatsapp.net");
    const exists = Array.isArray(result) ? !!result[0]?.exists : !!result?.exists;
    return exists ? "REGISTERED" : "NOT REGISTERED";
  } catch { return "NOT REGISTERED"; }
}

async function checkNumbers(numbers, chatId) {
  let results = [];
  let progressMsg = await bot.sendMessage(chatId, `⏳ Progress: 0/${numbers.length}`);
  let done = 0;

  for (const raw of numbers) {
    const num = normalizeNumber(raw);
    if (!num) continue;
    const status = await checkNumber(num);
    results.push({ number: formatNumber(num), status });
    done++;
    try { await bot.editMessageText(`⏳ Progress: ${done}/${numbers.length}`, { chat_id: chatId, message_id: progressMsg.message_id }); } catch {}
  }

  return results;
}

async function sendResults(chatId, results) {
  let reply = "📊 WhatsApp Status Report\n\n";
  for (const r of results) {
    if (r.status === "REGISTERED") reply += `✅ ${r.number}\n`;
    else if (r.status === "NOT REGISTERED") reply += `❌ ${r.number}\n`;
    else reply += `⚠️ ${r.number} Check failed\n`;
  }

  const registeredCount = results.filter(r => r.status === "REGISTERED").length;
  const notRegisteredCount = results.filter(r => r.status === "NOT REGISTERED").length;
  const failedCount = results.filter(r => !["REGISTERED","NOT REGISTERED"].includes(r.status)).length;

  reply += `\n📌 Summary:\n`;
  reply += `✅ Registered: ${registeredCount}\n`;
  reply += `❌ Not Registered: ${notRegisteredCount}\n`;
  reply += `⚠️ Failed: ${failedCount}\n`;

  await bot.sendMessage(chatId, reply);
}

// ---------------------------- TELEGRAM HANDLERS ----------------------------

// /start command with World Cup styled welcome
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const inChannel = await isUserInChannel(chatId);
  if (!inChannel) return sendJoinMessage(chatId);

  if (!verifiedUsers.has(chatId)) { verifiedUsers.add(chatId); saveVerifiedUsers(); }

  if (chatId === OWNER_ID && !adminNotified) {
    if (!isConnected) await connectWA(chatId);
    try { await bot.sendMessage(OWNER_ID, "✅ WhatsApp session is now active!"); } catch {}
    adminNotified = true;
  }

  bot.sendMessage(chatId,
    `🏆 *Welcome to FoXy WhatsApp Checker!* \n\n` +
    `👋 Hello, *${msg.from.first_name}*!\n\n` +
    `📥 Send WhatsApp numbers (single/multiple) or upload files: .txt, .csv, .xlsx\n\n` +
    `⚡ *Instant Check:* The bot will verify each number immediately and send the report.\n\n` +
    `ℹ️ *Legend:*\n✅ Registered\n❌ Not Registered\n\n` +
    `🌐 Enjoy checking numbers like a World Cup champion!`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "FoXyPrefix Bot", url: "https://t.me/FoXyPrefix_bot" }],
          [{ text: "🆘 Support", url: "https://t.me/FOXyChatSupport" }]
        ]
      }
    }
  );
});

// Verify Button
bot.on("callback_query", async query => {
  if (query.data === "verify") {
    const chatId = query.message.chat.id;
    const inChannel = await isUserInChannel(chatId);
    if (inChannel) {
      verifiedUsers.add(chatId);
      saveVerifiedUsers();
      bot.sendMessage(chatId, `✅ Verification successful!`);
      if (chatId === OWNER_ID && !isConnected) await connectWA(chatId);
    } else sendJoinMessage(chatId);
  }
});

// Handle Text Messages
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  if (!isConnected || !sock) return;
  if (msg.text?.startsWith("/")) return;
  if (msg.document) return;

  const inChannel = await isUserInChannel(chatId);
  if (!inChannel) { verifiedUsers.delete(chatId); saveVerifiedUsers(); return sendJoinMessage(chatId); }
  if (!verifiedUsers.has(chatId)) return;

  const numbers = msg.text.split(/[\n, ,]+/).map(x => x.trim()).filter(Boolean);
  if (numbers.length === 0) return;
  const results = await checkNumbers(numbers, chatId);
  await sendResults(chatId, results);
});

// Handle Document Uploads
bot.on("document", async msg => {
  const chatId = msg.chat.id;
  if (!isConnected || !sock) return;

  const inChannel = await isUserInChannel(chatId);
  if (!inChannel) { verifiedUsers.delete(chatId); saveVerifiedUsers(); return sendJoinMessage(chatId); }
  if (!verifiedUsers.has(chatId)) return;

  try {
    const fileId = msg.document.file_id;
    const fileLink = await bot.getFileLink(fileId);
    const res = await fetch(fileLink);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filePath = `./temp_${Date.now()}_${msg.document.file_name}`;
    fs.writeFileSync(filePath, buffer);

    let numbers = [];
    if (msg.document.file_name.endsWith(".txt")) numbers = fs.readFileSync(filePath, "utf8").split(/\r?\n/).map(x => x.trim());
    else if (msg.document.file_name.endsWith(".csv")) {
      const records = parse(fs.readFileSync(filePath), { columns: false, skip_empty_lines: true });
      numbers = records.flat();
    } else if (msg.document.file_name.endsWith(".xlsx") || msg.document.file_name.endsWith(".xls")) {
      const wb = XLSX.readFile(filePath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      numbers = XLSX.utils.sheet_to_json(sheet, { header: 1 }).flat();
    }

    fs.unlinkSync(filePath);
    bot.sendMessage(chatId, `📂 Total ${numbers.length} numbers received. Checking...`);
    const results = await checkNumbers(numbers, chatId);
    await sendResults(chatId, results);
  } catch (e) { console.error("File processing error:", e); }
});

// ---------------------------- KEEP BOT RUNNING ----------------------------
process.on("uncaughtException", err => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", err => console.error("Unhandled Rejection:", err));