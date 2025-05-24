const deepseek = require('./deepseek');
const { ASLAN_SYSTEM_PROMPT } = require('./deepseek');
const moment = require('moment-timezone');

// Новая структура состояния для синдиката
let gameState = {};

const SITUATION_DEADLINE_MINUTES = 35;
const AUTO_SUMMARY_RESPONSES = 3;
const AUTO_SUMMARY_DELAY_MINUTES = 2;
let autoSummaryTimers = {};

function getDefaultState() {
  return {
    day: 1,
    money: 10000,
    reputation: 5,
    problems: [],
    allies: {},
    enemies: {},
    history: [],
    active_situation: {
      message_id: null,
      text: '',
      responses: [],
      deadline: null
    },
    personal_dialogs: {} // user_id: [{from, text, timestamp}]
  };
}

function saveState(chatId, state, db) {
  gameState[chatId] = state;
  db.saveState(chatId, state);
}

async function loadState(chatId, db) {
  if (gameState[chatId]) return gameState[chatId];
  const state = await db.loadState(chatId);
  if (state) gameState[chatId] = state;
  return state || getDefaultState();
}

// Создание новой ситуации (утро/вечер)
async function createSituation(bot, chatId, db, logger, timeOfDay) {
  const state = await loadState(chatId, db);
  // Контекст для генерации
  const context = {
    day: state.day,
    recent_events: state.history.slice(-5),
    ongoing_problems: state.problems,
    relationships: {
      allies: state.allies,
      enemies: state.enemies
    }
  };
  const prompt = `Создай новую ситуацию для дня ${state.day} (${timeOfDay}).\nУчти недавние события: ${JSON.stringify(context.recent_events)}\nТекущие проблемы: ${JSON.stringify(context.ongoing_problems)}\nСитуация должна логично вытекать из предыдущих решений. НЕ давай варианты ответов, только опиши ситуацию.`;
  const situationText = await deepseek.askDeepSeek([
    { role: 'user', content: prompt }
  ]);
  const msg = await bot.sendMessage(chatId, situationText);
  state.active_situation = {
    message_id: msg.message_id,
    text: situationText,
    responses: [],
    deadline: moment().add(SITUATION_DEADLINE_MINUTES, 'minutes').toISOString()
  };
  saveState(chatId, state, db);
  // Сбросить авто-таймер для итогов
  if (autoSummaryTimers[chatId]) {
    clearTimeout(autoSummaryTimers[chatId]);
    delete autoSummaryTimers[chatId];
  }
}

// Сбор ответов игроков через реплай
async function handleMessage(bot, message, db, logger) {
  if (message.reply_to_message && message.reply_to_message.from && message.reply_to_message.from.id === (await bot.getMe()).id) {
    const chatId = message.chat.id;
    const state = await loadState(chatId, db);
    if (!state.active_situation || state.active_situation.message_id !== message.reply_to_message.message_id) return;
    // Сохраняем ответ
    state.active_situation.responses.push({
      player_name: message.from.first_name,
      user_id: message.from.id,
      response: message.text
    });
    saveState(chatId, state, db);
    bot.replyTo(message, `Э, ${message.from.first_name}, понял тэбя, брат! Интэрэсная идея... 🤔`);

    // Короткий комментарий от Аслана (1-2 предложения, иногда мнение)
    try {
      const commentPrompt = `Ты — Аслан "Схема". Коротко (1-2 предложения, не более 120 символов) прокомментируй ответ игрока: "${message.text}". Не повторяй сам ответ, просто выскажи мнение или пошути, иногда можешь промолчать. Не используй звёздочки, не описывай действия.`;
      const comment = await deepseek.askDeepSeek([
        { role: 'user', content: commentPrompt }
      ]);
      if (comment && comment.trim().length > 0 && Math.random() < 0.85) { // иногда промолчать
        await bot.sendMessage(chatId, comment, { reply_to_message_id: message.message_id });
      }
    } catch (e) { /* ignore */ }

    // Если ответило хотя бы 3 разных человека — запускаем таймер на 2 минуты для итогов
    const uniqueUsers = [...new Set(state.active_situation.responses.map(r => r.user_id))];
    if (uniqueUsers.length === AUTO_SUMMARY_RESPONSES && !autoSummaryTimers[chatId]) {
      autoSummaryTimers[chatId] = setTimeout(async () => {
        await processSituationResults(bot, chatId, db, logger);
        delete autoSummaryTimers[chatId];
      }, AUTO_SUMMARY_DELAY_MINUTES * 60 * 1000);
    }

    // Если все участники (кроме бота) уже ответили — сразу подводим итог
    try {
      const members = await bot.getChatAdministrators(chatId);
      const botId = (await bot.getMe()).id;
      const allMembers = await bot.getChatMembersCount(chatId);
      const realPlayers = allMembers - 1; // минус бот
      if (uniqueUsers.length >= realPlayers && realPlayers > 0) {
        if (autoSummaryTimers[chatId]) {
          clearTimeout(autoSummaryTimers[chatId]);
          delete autoSummaryTimers[chatId];
        }
        await processSituationResults(bot, chatId, db, logger);
      }
    } catch (e) { /* ignore */ }
  }
}

// Новый обработчик персональных обращений к Аслану
async function handlePersonalMention(bot, message, db, logger) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const state = await loadState(chatId, db);
  state.personal_dialogs[userId] = state.personal_dialogs[userId] || [];
  // Добавляем сообщение пользователя в историю диалога
  state.personal_dialogs[userId].push({
    from: 'user',
    text: message.text,
    timestamp: Date.now()
  });
  // Извлекаем упоминания
  const mentionRegex = /@([a-zA-Z0-9_]+)/g;
  const mentions = [];
  let match;
  while ((match = mentionRegex.exec(message.text)) !== null) {
    mentions.push(match[1]);
  }
  // Формируем контекст последних 5 сообщений диалога
  const dialogHistory = state.personal_dialogs[userId].slice(-5).map(d => (d.from === 'user' ? `Пользователь: ${d.text}` : `Аслан: ${d.text}`)).join('\n');
  // Генерируем ответ
  const prompt = `Ты — Аслан "Схема". Пользователь обратился к тебе лично. Вот последние сообщения диалога:\n${dialogHistory}\n\nВНИМАНИЕ:\n- Не используй описания действий в стиле *улыбается*, *щурится*, *почёсывает бороду* и т.п. Не пиши ничего в звёздочках, не описывай жесты, только речь!\n- Пиши как живой человек, будто ты реально в чате.\n- Если в сообщении есть @username, обязательно обращайся к этому человеку по тегу (@username) в своём ответе, чтобы все видели, кому ты отвечаешь.\n${mentions.length ? `В сообщении упомянуты: ${mentions.map(u => '@' + u).join(', ')}. Используй эти теги в ответе!` : ''}\n\nОтветь коротко, с юмором, в своём стиле. Если вопрос касается денег, схем, синдиката или сюжета — обязательно запомни это для будущих событий.`;
  const reply = await deepseek.askDeepSeek([
    { role: 'user', content: prompt }
  ]);
  // Добавляем ответ Аслана в историю диалога
  state.personal_dialogs[userId].push({
    from: 'aslan',
    text: reply,
    timestamp: Date.now()
  });
  saveState(chatId, state, db);
  // Отвечаем через reply, а не через @username
  let mentionText = '';
  if (mentions.length) {
    // Исключаем самого автора из списка тегов
    const mentionTags = mentions.filter(u => u !== (message.from.username || '')).map(u => '@' + u);
    if (mentionTags.length) {
      mentionText = mentionTags.join(' ') + ' ';
    }
  }
  await bot.replyTo(message, `${mentionText}${reply}`);
  // Если вопрос явно связан с сюжетом — добавляем в историю синдиката
  if (/деньг|синдикат|схем|проблем|сюжет|истори|дело|братва|враг|союзник|план/i.test(message.text)) {
    state.history.push({
      day: state.day,
      event: `[Личный диалог с @${message.from.username || message.from.first_name}]: ${message.text} => ${reply}`,
      player_decisions: [],
      consequences: null,
      timestamp: Date.now()
    });
    saveState(chatId, state, db);
  }
}

// Обработка ситуации после сбора ответов
async function processSituationResults(bot, chatId, db, logger) {
  if (autoSummaryTimers[chatId]) {
    clearTimeout(autoSummaryTimers[chatId]);
    delete autoSummaryTimers[chatId];
  }
  const state = await loadState(chatId, db);
  const responses = state.active_situation.responses;
  const context = {
    history: state.history.slice(-10),
    current_state: {
      money: state.money,
      reputation: state.reputation,
      problems: state.problems
    },
    player_responses: responses,
    character: 'Аслан Схема'
  };
  const prompt = `Ты Аслан Схема. Вот текущая ситуация синдиката:\n${JSON.stringify(context)}\n\nИгроки предложили следующее:\n${responses.map(r => r.player_name + ': ' + r.response).join('\n')}\n\nСоздай развитие событий, учитывая ВСЕ предложения игроков. Помни предыдущие события и решения. Ответь с акцентом и юмором.`;
  const resultText = await deepseek.askDeepSeek([
    { role: 'user', content: prompt }
  ]);
  // Обновляем историю
  state.history.push({
    day: state.day,
    event: resultText,
    player_decisions: responses,
    consequences: null,
    timestamp: moment().toISOString()
  });
  // Сброс активной ситуации, переход к следующему дню
  state.day += 1;
  state.active_situation = {
    message_id: null,
    text: '',
    responses: [],
    deadline: null
  };
  saveState(chatId, state, db);
  await bot.sendMessage(chatId, resultText);
}

// Команды истории и отношений
async function showHistory(bot, message, db) {
  const state = await loadState(message.chat.id, db);
  const history = state.history.slice(-10).map(e => `День ${e.day}: ${e.event}`).join('\n');
  await bot.sendMessage(message.chat.id, history || 'История пока пуста, брат.');
}

async function showRelationships(bot, message, db) {
  const state = await loadState(message.chat.id, db);
  const allies = Object.keys(state.allies).length ? Object.keys(state.allies).join(', ') : 'нет союзников';
  const enemies = Object.keys(state.enemies).length ? Object.keys(state.enemies).join(', ') : 'нет врагов';
  await bot.sendMessage(message.chat.id, `Союзники: ${allies}\nВраги: ${enemies}`);
}

module.exports = {
  getDefaultState,
  createSituation,
  handleMessage,
  handlePersonalMention,
  processSituationResults,
  showHistory,
  showRelationships,
  gameState
};
