require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const gameLogic = require('./game-logic');
const scheduler = require('./scheduler');
const db = require('./database');
const winston = require('winston');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Логгер
const logger = winston.createLogger({
  transports: [new winston.transports.Console()]
});

// Команды и обработчики
bot.onText(/\/start/, (msg) => {
  gameLogic.startThemeVoting(bot, msg.chat.id, db, logger);
});

bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Меню:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Сменить тему', callback_data: 'menu_theme' }],
        [{ text: 'Продолжить игру', callback_data: 'menu_continue' }],
        [{ text: 'Статус игры', callback_data: 'menu_status' }],
        [{ text: 'Помощь', callback_data: 'menu_help' }]
      ]
    }
  });
});

bot.onText(/\/theme/, (msg) => {
  gameLogic.startThemeVoting(bot, msg.chat.id, db, logger);
});

bot.onText(/\/continue/, (msg) => {
  gameLogic.nextStep(bot, msg.chat.id, db, logger);
});

bot.onText(/\/status/, async (msg) => {
  const state = await db.loadState(msg.chat.id);
  if (!state || !state.theme) {
    bot.sendMessage(msg.chat.id, 'Игра ещё не начата. Используйте /start.');
    return;
  }
  const step = state.step || 0;
  const theme = state.theme;
  const lastSituation = state.history.filter(e => e.type === 'situation').slice(-1)[0]?.text || '';
  bot.sendMessage(msg.chat.id, `Тема: ${theme}\nШаг: ${step}\nПоследняя ситуация: ${lastSituation}`);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `Я — D&D бот с чёрным юмором!\n\n/start — начать игру и выбрать тему\n/menu — меню\n/theme — сменить тему\n/continue — продолжить игру\n/status — статус игры\n/help — справка\n\nПиши свои действия текстом, упоминай других игроков через @username, и не бойся умереть — тут это весело!`);
});

// Обработка inline-кнопок меню
bot.on('callback_query', async (query) => {
  if (query.data === 'menu_theme') {
    gameLogic.startThemeVoting(bot, query.message.chat.id, db, logger);
    bot.answerCallbackQuery({ callback_query_id: query.id });
  } else if (query.data === 'menu_continue') {
    gameLogic.nextStep(bot, query.message.chat.id, db, logger);
    bot.answerCallbackQuery({ callback_query_id: query.id });
  } else if (query.data === 'menu_status') {
    const state = await db.loadState(query.message.chat.id);
    if (!state || !state.theme) {
      bot.sendMessage(query.message.chat.id, 'Игра ещё не начата. Используйте /start.');
    } else {
      const step = state.step || 0;
      const theme = state.theme;
      const lastSituation = state.history.filter(e => e.type === 'situation').slice(-1)[0]?.text || '';
      bot.sendMessage(query.message.chat.id, `Тема: ${theme}\nШаг: ${step}\nПоследняя ситуация: ${lastSituation}`);
    }
    bot.answerCallbackQuery({ callback_query_id: query.id });
  } else if (query.data === 'menu_help') {
    bot.sendMessage(query.message.chat.id, `Я — D&D бот с чёрным юмором!\n\n/start — начать игру и выбрать тему\n/menu — меню\n/theme — сменить тему\n/continue — продолжить игру\n/status — статус игры\n/help — справка\n\nПиши свои действия текстом, упоминай других игроков через @username, и не бойся умереть — тут это весело!`);
    bot.answerCallbackQuery({ callback_query_id: query.id });
  }
});

gameLogic.init(bot, db, logger);
scheduler.init(bot, db, logger);

db.init();

logger.info('D&D Bot запущен!');
