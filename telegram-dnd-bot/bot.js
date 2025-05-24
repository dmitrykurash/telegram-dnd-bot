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
  // Получить username бота
  bot.getMe().then(me => {
    const botUsernames = [me.username?.toLowerCase(), 'aslan', 'аслан', 'схема', 'shema'].filter(Boolean);
    const text = (msg.text || '').toLowerCase();
    // Если это реплай на сообщение бота (но не ситуация) или @упоминание бота
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === bot.id;
    const isMention = botUsernames.some(u => text.includes('@' + u) || text.includes(u));
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
cron.schedule('0 9 * * *', async () => {
  // Для всех чатов, где есть активная игра
  for (const chatId of Object.keys(gameLogic.gameState)) {
    await gameLogic.createSituation(bot, chatId, db, logger, 'утро');
  }
}, { timezone: process.env.TIMEZONE || 'Europe/Moscow' });
cron.schedule('0 19 * * *', async () => {
  for (const chatId of Object.keys(gameLogic.gameState)) {
    await gameLogic.createSituation(bot, chatId, db, logger, 'вечер');
  }
}, { timezone: process.env.TIMEZONE || 'Europe/Moscow' });

// Таймауты: раз в час проверяем дедлайны
cron.schedule('0 * * * *', async () => {
  for (const chatId of Object.keys(gameLogic.gameState)) {
    const state = gameLogic.gameState[chatId];
    if (state.active_situation.deadline && moment().isAfter(moment(state.active_situation.deadline))) {
      await gameLogic.processSituationResults(bot, chatId, db, logger);
    }
  }
}, { timezone: process.env.TIMEZONE || 'Europe/Moscow' });

// Приветствие при добавлении бота в группу
bot.on('new_chat_members', async (msg) => {
  const botId = (await bot.getMe()).id;
  const isBotAdded = msg.new_chat_members.some(m => m.id === botId);
  if (isBotAdded) {
    // Пробуем сгенерировать приветствие через DeepSeek
    let welcome;
    try {
      welcome = await askDeepSeek([
        { role: 'user', content: 'Ты — Аслан "Схема", виртуальный криминальный авторитет. Придумай очень короткое приветствие (1-2 предложения максимум) для группы, куда тебя только что добавили. Используй кавказский акцент, юмор, стиль: "братва", "валлах", "схемы", "деньги". Не повторяйся, вариативно.' }
      ]);
    } catch (e) {
      // Фоллбэк — случайная заготовка
      const variants = [
        'Вай, здарова, братва! Теперь тут порядок будет, валлах.',
        'Ассаламу алейкум, дарагие! Аслан "Схема" на связи, деньги будут — не переживайте.',
        'Опа, кто тут собрался? Теперь все вопросы по схеме, брат!',
        'Ну что, братва, теперь у вас есть свой человек по всем вопросам. Валлах, не подведу!',
        'Зашёл, увидел, навёл порядок. Деньги — сюда, проблемы — туда!'
      ];
      welcome = variants[Math.floor(Math.random() * variants.length)];
    }
    bot.sendMessage(msg.chat.id, welcome);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  if (query.data === 'menu_history') {
    await gameLogic.showHistory(bot, query.message, db);
  } else if (query.data === 'menu_relationships') {
    await gameLogic.showRelationships(bot, query.message, db);
  } else if (query.data === 'menu_call_aslan') {
    // Сначала приветствие через DeepSeek
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
    await bot.sendMessage(chatId, welcome);
    // Затем генерируем новую ситуацию
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
  // Сначала приветствие через DeepSeek
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
  await bot.sendMessage(msg.chat.id, welcome);
  // Генерируем новую ситуацию
  await gameLogic.createSituation(bot, msg.chat.id, db, logger, 'от Аслана');
});

logger.info('Синдикат-бот запущен!');
