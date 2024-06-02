const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
require("dotenv").config();

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, {
  polling: true,
});

let db;
open({
  filename: ".db.db",
  driver: sqlite3.Database,
})
  .then((database) => {
    db = database;
    return db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, 
      title TEXT, 
      description TEXT, 
      location TEXT, 
      time TEXT, 
      messageId INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      userId INTEGER UNIQUE,
      name TEXT,
      phone TEXT
    );
    CREATE TABLE IF NOT EXISTS event_participants (
      id INTEGER PRIMARY KEY,
      eventId INTEGER,
      userId INTEGER,
      UNIQUE(eventId, userId)
    );
  `);
  })
  .catch((err) => {
    console.error(err);
  });

const admins = process.env.BOT_ADMINS;
let eventCreationSteps = {};
let registrationSteps = {};

bot.onText(/\/create_event/, (msg) => {
  if (admins.includes(msg.from.id)) {
    eventCreationSteps[msg.from.id] = { step: 1, chatId: msg.chat.id };
    bot.sendMessage(msg.chat.id, "لطفاً عنوان ایونت را وارد کنید:", {
      reply_to_message_id: msg.message_id,
    });
  } else {
    bot.sendMessage(msg.chat.id, "شما مجوز ایجاد ایونت را ندارید.");
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // ایجاد ایونت
  if (
    eventCreationSteps[userId] &&
    eventCreationSteps[userId].chatId === chatId
  ) {
    const step = eventCreationSteps[userId].step;

    if (step === 1) {
      eventCreationSteps[userId].title = msg.text;
      eventCreationSteps[userId].step++;
      bot.sendMessage(chatId, "لطفاً توضیحات ایونت را وارد کنید:", {
        reply_to_message_id: msg.message_id,
      });
    } else if (step === 2) {
      eventCreationSteps[userId].description = msg.text;
      eventCreationSteps[userId].step++;
      bot.sendMessage(chatId, "لطفاً مکان ایونت را وارد کنید:", {
        reply_to_message_id: msg.message_id,
      });
    } else if (step === 3) {
      eventCreationSteps[userId].location = msg.text;
      eventCreationSteps[userId].step++;
      bot.sendMessage(chatId, "لطفاً زمان ایونت را وارد کنید:", {
        reply_to_message_id: msg.message_id,
      });
    } else if (step === 4) {
      eventCreationSteps[userId].time = msg.text;

      const event = eventCreationSteps[userId];
      delete eventCreationSteps[userId];

      const eventMessage = `عنوان: ${event.title}\nتوضیحات: ${event.description}\nمکان: ${event.location}\nزمان: ${event.time}`;

      const sentMessage = await bot.sendMessage(chatId, eventMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "من شرکت می‌کنم", callback_data: "join_event" }],
          ],
        },
      });

      await db.run(
        "INSERT INTO events (title, description, location, time, messageId) VALUES (?, ?, ?, ?, ?)",
        [
          event.title,
          event.description,
          event.location,
          event.time,
          sentMessage.message_id,
        ]
      );

      bot.sendMessage(chatId, "ایونت با موفقیت ایجاد شد.");
    }
  }

  // ثبت‌نام در ایونت
  if (
    registrationSteps[userId] &&
    registrationSteps[userId].chatId === chatId
  ) {
    const step = registrationSteps[userId].step;
    const eventId = registrationSteps[userId].eventId;

    if (step === 1) {
      registrationSteps[userId].name = msg.text;
      registrationSteps[userId].step++;
      bot.sendMessage(
        chatId,
        "لطفاً شماره تلفن خود را وارد کنید (اگر نمی‌خواهید، عدد صفر را وارد کنید):",
        { reply_to_message_id: msg.message_id }
      );
    } else if (step === 2) {
      const phone = msg.text === "0" ? null : msg.text;
      const name = registrationSteps[userId].name;

      await db.run(
        "INSERT INTO users (userId, name, phone) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET name = excluded.name, phone = excluded.phone",
        [userId, name, phone]
      );
      await db.run(
        "INSERT INTO event_participants (eventId, userId) VALUES (?, ?)",
        [eventId, userId]
      );

      const event = await db.get("SELECT * FROM events WHERE id = ?", [
        eventId,
      ]);
      const participants = await db.all(
        "SELECT users.name, users.phone FROM event_participants JOIN users ON event_participants.userId = users.userId WHERE event_participants.eventId = ?",
        [eventId]
      );

      const updatedMessage = `عنوان: ${event.title}\nتوضیحات: ${
        event.description
      }\nمکان: ${event.location}\nزمان: ${
        event.time
      }\n\nشرکت‌کنندگان:\n${participants
        .map(
          (p, index) =>
            `${index + 1}. ${p.name} ${p.phone ? `(${p.phone})` : ""}`
        )
        .join("\n")}
      `;

      if (registrationSteps[userId] && registrationSteps[userId].messageId) {
        await bot.editMessageText(updatedMessage, {
          chat_id: chatId,
          message_id: registrationSteps[userId].messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: "من شرکت می‌کنم", callback_data: "join_event" }],
            ],
          },
        });

        bot.sendMessage(chatId, "ثبت‌نام شما با موفقیت انجام شد.", {
          reply_to_message_id: msg.message_id,
        });
      }

      delete registrationSteps[userId];
    }
  }
});

bot.on("callback_query", async (callbackQuery) => {
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  const chatId = callbackQuery.message.chat.id;

  const event = await db.get("SELECT * FROM events WHERE messageId = ?", [
    messageId,
  ]);
  if (!event) {
    bot.sendMessage(chatId, "ایونت پیدا نشد.");
    return;
  }

  const participant = await db.get(
    "SELECT * FROM event_participants WHERE eventId = ? AND userId = ?",
    [event.id, userId]
  );
  if (participant) {
    bot.sendMessage(chatId, "شما قبلاً در این ایونت ثبت‌نام کرده‌اید.", {
      reply_to_message_id: callbackQuery.message.message_id,
    });
    return;
  }

  const user = await db.get("SELECT * FROM users WHERE userId = ?", [userId]);

  if (user) {
    await db.run(
      "INSERT INTO event_participants (eventId, userId) VALUES (?, ?)",
      [event.id, userId]
    );

    const participants = await db.all(
      "SELECT users.name, users.phone FROM event_participants JOIN users ON event_participants.userId = users.userId WHERE event_participants.eventId = ?",
      [event.id]
    );

    const updatedMessage = `عنوان: ${event.title}\nتوضیحات: ${
      event.description
    }\nمکان: ${event.location}\nزمان: ${
      event.time
    }\n\nشرکت‌کنندگان:\n${participants
      .map(
        (p, index) => `${index + 1}. ${p.name} ${p.phone ? `(${p.phone})` : ""}`
      )
      .join("\n")}
    `;

    await bot.editMessageText(updatedMessage, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "من شرکت می‌کنم", callback_data: "join_event" }],
        ],
      },
    });

    bot.sendMessage(chatId, "ثبت‌نام شما با موفقیت انجام شد.", {
      reply_to_message_id: callbackQuery.message.message_id,
    });
  } else {
    registrationSteps[userId] = {
      step: 1,
      chatId,
      eventId: event.id,
      messageId,
    };
    bot.sendMessage(chatId, "لطفاً نام و نام خانوادگی خود را وارد کنید:", {
      reply_to_message_id: callbackQuery.message.message_id,
    });
  }
});
