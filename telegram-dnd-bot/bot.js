require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const gameLogic = require('./game-logic');
const scheduler = require('./scheduler');
const db = require('./database');
const winston = require('winston');
const { askDeepSeek } = require('./deepseek');
const { handlePersonalMention } = require('./game-logic');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Логгер
const logger = winston.createLogger({
  transports: [new winston.transports.Console()]
});

db.init();

// /start — запуск синдиката
bot.onText(/\/start/, async (msg) => {
  const state = {
    ...gameLogic.getDefaultState(),
    day: 1
  };
  await db.saveState(msg.chat.id, state);
  await gameLogic.createSituation(bot, msg.chat.id, db, logger, 'утро');
});

// /history — история синдиката
bot.onText(/\/history/, (msg) => gameLogic.showHistory(bot, msg, db));

// /relationships — отношения
bot.onText(/\/relationships/, (msg) => gameLogic.showRelationships(bot, msg, db));

// Меню синдиката
bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Меню синдиката:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'История', callback_data: 'menu_history' }],
        [{ text: 'Союзники и враги', callback_data: 'menu_relationships' }],
        [{ text: 'Позвать Аслана', callback_data: 'menu_call_aslan' }],
        [{ text: 'Баланс и репутация', callback_data: 'menu_status' }],
        [{ text: 'Справка', callback_data: 'menu_help' }]
      ]
    }
  });
});

// Обработка реплаев к ситуациям
bot.on('message', (msg) => {
  bot.getMe().then(me => {
    const botUsernames = [me.username?.toLowerCase(), 'aslan', 'аслан', 'схема', 'shema'].filter(Boolean);
    const text = (msg.text || '').toLowerCase();
    // Проверка на упоминание через entities
    const hasMentionEntity = (msg.entities || []).some(e => e.type === 'mention' && msg.text?.toLowerCase().includes('@' + me.username?.toLowerCase()));
    // Если это реплай на сообщение бота (но не ситуация) или @упоминание бота
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === bot.id;
    const isMention = botUsernames.some(u => text.includes('@' + u) || text.includes(u)) || hasMentionEntity;
    if (isReplyToBot || isMention) {
      handlePersonalMention(bot, msg, db, logger);
      return;
    }
    // Обычный игровой реплай к ситуации
    if (msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === bot.id) {
      gameLogic.handleMessage(bot, msg, db, logger);
    }
  });
});

// Автоматические ситуации (утро/вечер)
const moment = require('moment-timezone');
const cron = require('node-cron');
const CHECK_INTERVAL_MINUTES = 5;
const SITUATION_DEADLINE_MINUTES = 35;

// Хелпер для случайного времени в диапазоне минут
function randomMinuteInRange(start, end) {
  return start + Math.floor(Math.random() * (end - start + 1));
}

// Утреннее сообщение: случайное время между 10:00 и 10:15
cron.schedule('0 10 * * *', async () => {
  const delay = randomMinuteInRange(0, 15) * 60 * 1000;
  setTimeout(async () => {
    for (const chatId of Object.keys(gameLogic.gameState)) {
      await gameLogic.createSituation(bot, chatId, db, logger, 'утро');
    }
  }, delay);
}, { timezone: process.env.TIMEZONE || 'Europe/Moscow' });

// Вечернее сообщение: случайное время между 19:00 и 19:15
cron.schedule('0 19 * * *', async () => {
  const delay = randomMinuteInRange(0, 15) * 60 * 1000;
  setTimeout(async () => {
    for (const chatId of Object.keys(gameLogic.gameState)) {
      await gameLogic.createSituation(bot, chatId, db, logger, 'вечер');
    }
  }, delay);
}, { timezone: process.env.TIMEZONE || 'Europe/Moscow' });

// Проверка дедлайнов ситуаций каждые 5 минут
cron.schedule(`*/${CHECK_INTERVAL_MINUTES} * * * *`, async () => {
  for (const chatId of Object.keys(gameLogic.gameState)) {
    const state = gameLogic.gameState[chatId];
    if (state.active_situation.deadline && moment().isAfter(moment(state.active_situation.deadline))) {
      await gameLogic.processSituationResults(bot, chatId, db, logger);
    }
  }
}, { timezone: process.env.TIMEZONE || 'Europe/Moscow' });

// Функция для отправки только одного приветствия (если DeepSeek вернул несколько)
function sendSingleWelcome(bot, chatId, welcome) {
  // Если DeepSeek вернул несколько вариантов через перевод строки или двойной перевод строки — берём только первый
  let text = welcome.split(/\n\s*\n|\n|\r/)[0].trim();
  // Если есть разделитель типа 'Или:' — берём только до него
  text = text.split(/Или:/i)[0].trim();
  bot.sendMessage(chatId, text);
}

// Приветствие при добавлении бота в группу
bot.on('new_chat_members', async (msg) => {
  const botId = (await bot.getMe()).id;
  const isBotAdded = msg.new_chat_members.some(m => m.id === botId);
  if (isBotAdded) {
    let welcome;
    try {
      welcome = await askDeepSeek([
        { role: 'user', content: 'Ты — Аслан "Схема", виртуальный криминальный авторитет. Придумай очень короткое приветствие (1-2 предложения максимум) для группы, куда тебя только что добавили. Используй кавказский акцент, юмор, стиль: "братва", "валлах", "схемы", "деньги". Не повторяйся, вариативно.' }
      ]);
    } catch (e) {
      const variants = [
        'Вай, здарова, братва! Теперь тут порядок будет, валлах.',
        'Ассаламу алейкум, дарагие! Аслан "Схема" на связи, деньги будут — не переживайте.',
        'Опа, кто тут собрался? Теперь все вопросы по схеме, брат!',
        'Ну что, братва, теперь у вас есть свой человек по всем вопросам. Валлах, не подведу!',
        'Зашёл, увидел, навёл порядок. Деньги — сюда, проблемы — туда!'
      ];
      welcome = variants[Math.floor(Math.random() * variants.length)];
    }
    sendSingleWelcome(bot, msg.chat.id, welcome);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  if (query.data === 'menu_history') {
    await gameLogic.showHistory(bot, query.message, db);
  } else if (query.data === 'menu_relationships') {
    await gameLogic.showRelationships(bot, query.message, db);
  } else if (query.data === 'menu_call_aslan') {
    let welcome;
    try {
      welcome = await askDeepSeek([
        { role: 'user', content: 'Ты — Аслан "Схема", виртуальный криминальный авторитет. Придумай короткое приветствие (1-2 предложения максимум) для всей группы, когда тебя позвали. Используй кавказский акцент, юмор, стиль: "братва", "валлах", "схемы", "деньги". Не повторяйся, вариативно. Учитывай последние события, если они есть.' }
      ]);
    } catch (e) {
      const variants = [
        'Вай, здарова, братва! Кто звал Аслана — теперь тут порядок будет, валлах.',
        'Ассаламу алейкум, дарагие! Аслан "Схема" на связи, деньги будут — не переживайте.',
        'Опа, кто тут собрался? Теперь все вопросы по схеме, брат!',
        'Ну что, братва, теперь у вас есть свой человек по всем вопросам. Валлах, не подведу!',
        'Зашёл, увидел, навёл порядок. Деньги — сюда, проблемы — туда!'
      ];
      welcome = variants[Math.floor(Math.random() * variants.length)];
    }
    sendSingleWelcome(bot, chatId, welcome);
    await gameLogic.createSituation(bot, chatId, db, logger, 'от Аслана');
  } else if (query.data === 'menu_status') {
    const state = await gameLogic.loadState(chatId, db);
    bot.sendMessage(chatId, `Баланс: ${state.money}₽\nРепутация: ${state.reputation}`);
  } else if (query.data === 'menu_help') {
    bot.sendMessage(chatId, 'Доступные команды: /start, /history, /relationships, /menu. Обращайся к Аслану через @ или реплай!');
  }
  bot.answerCallbackQuery({ callback_query_id: query.id });
});

bot.onText(/\/callaslan/, async (msg) => {
  let welcome;
  try {
    welcome = await askDeepSeek([
      { role: 'user', content: 'Ты — Аслан "Схема", виртуальный криминальный авторитет. Придумай короткое приветствие (1-2 предложения максимум) для всей группы, когда тебя позвали. Используй кавказский акцент, юмор, стиль: "братва", "валлах", "схемы", "деньги". Не повторяйся, вариативно. Учитывай последние события, если они есть.' }
    ]);
  } catch (e) {
    const variants = [
      'Вай, здарова, братва! Кто звал Аслана — теперь тут порядок будет, валлах.',
      'Ассаламу алейкум, дарагие! Аслан "Схема" на связи, деньги будут — не переживайте.',
      'Опа, кто тут собрался? Теперь все вопросы по схеме, брат!',
      'Ну что, братва, теперь у вас есть свой человек по всем вопросам. Валлах, не подведу!',
      'Зашёл, увидел, навёл порядок. Деньги — сюда, проблемы — туда!'
    ];
    welcome = variants[Math.floor(Math.random() * variants.length)];
  }
  sendSingleWelcome(bot, msg.chat.id, welcome);
  await gameLogic.createSituation(bot, msg.chat.id, db, logger, 'от Аслана');
});

logger.info('Синдикат-бот запущен!');
