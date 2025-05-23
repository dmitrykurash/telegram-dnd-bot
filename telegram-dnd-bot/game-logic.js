const deepseek = require('./deepseek');
const fs = require('fs');
const path = require('path');

const THEMES_DIR = path.join(__dirname, 'themes');
let activeVotes = {};
let deadPlayers = {};
let stepTimers = {};
let stepResponded = {};

function getAllThemes() {
  return fs.readdirSync(THEMES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, f)));
      return { id: f.replace('.json', ''), ...data };
    });
}

function startThemeVoting(bot, chatId, db, logger) {
  const themes = getAllThemes();
  const inlineKeyboard = themes.map((t, idx) => [{ text: t.name, callback_data: `vote_theme_${idx}` }]);
  activeVotes[chatId] = { votes: {}, started: Date.now(), themes };
  bot.sendMessage(chatId, 'Выберите тему для нового приключения! Голосуйте кнопками ниже. Если никто не проголосует за 30 минут — я выберу сам.', {
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
  setTimeout(() => finishVoting(bot, chatId, db, logger), 30 * 60 * 1000);
}

function handleVote(bot, query, db, logger) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  if (!activeVotes[chatId]) return;
  const idx = parseInt(query.data.replace('vote_theme_', ''));
  activeVotes[chatId].votes[userId] = idx;
  bot.answerCallbackQuery({ callback_query_id: query.id, text: `Голос учтён: ${activeVotes[chatId].themes[idx].name}` });
}

function finishVoting(bot, chatId, db, logger) {
  const vote = activeVotes[chatId];
  if (!vote) return;
  const counts = {};
  Object.values(vote.votes).forEach(idx => { counts[idx] = (counts[idx] || 0) + 1; });
  let max = 0, leaders = [];
  for (const idx in counts) {
    if (counts[idx] > max) { max = counts[idx]; leaders = [idx]; }
    else if (counts[idx] === max) { leaders.push(idx); }
  }
  let chosenIdx;
  if (leaders.length === 0) {
    chosenIdx = Math.floor(Math.random() * vote.themes.length);
    logger.info('Никто не проголосовал, тема выбрана случайно');
  } else if (leaders.length > 1) {
    chosenIdx = parseInt(leaders[Math.floor(Math.random() * leaders.length)]);
    logger.info('Ничья, тема выбрана случайно из лидеров');
  } else {
    chosenIdx = parseInt(leaders[0]);
  }
  const theme = vote.themes[chosenIdx];
  db.saveState(chatId, { theme: theme.id, history: [], step: 0 });
  bot.sendMessage(chatId, `Тема выбрана: <b>${theme.name}</b>\n\n${theme.intro}`, { parse_mode: 'HTML' });
  startFirstStep(bot, chatId, db, logger);
  delete activeVotes[chatId];
}

async function startFirstStep(bot, chatId, db, logger) {
  const state = await db.loadState(chatId);
  if (!state || !state.theme) return;
  const themes = getAllThemes();
  const theme = themes.find(t => t.id === state.theme);
  let prompt;
  if (theme.id === 'dungeons-python') {
    prompt = `Ты — ведущий эпического путешествия во времени в Россию 90-х с чёрным юмором. Начни приключение для игроков: придумай необычную, угарную ситуацию, вдохновляйся реальными историями из 90-х, добавляй неожиданные повороты. Стиль D&D только в механике, не в мире. Не предлагай варианты ответов, не подсказывай игрокам, что делать. Не используй *, **, _ и другие символы для выделения текста. Просто обычный текст, не более 700 символов.`;
  } else {
    prompt = `Ты — ведущий D&D с чёрным юмором. Начни приключение во вселенной: ${theme.name}. Используй сарказм, чёрный юмор, немного пошлости, вовлеки игроков, придумай первую ситуацию, требующую решения. Не предлагай варианты ответов, не подсказывай игрокам, что делать. Не используй *, **, _ и другие символы для выделения текста. Просто обычный текст, не более 700 символов.`;
  }
  const intro = await deepseek.askDeepSeek([
    { role: 'system', content: prompt }
  ]);
  state.history.push({ type: 'situation', text: intro });
  state.step = 1;
  db.saveState(chatId, state);
  bot.sendMessage(chatId, `${intro}`);
}

function extractMentions(text) {
  const regex = /@([a-zA-Z0-9_]+)/g;
  let match, result = [];
  while ((match = regex.exec(text)) !== null) {
    result.push(match[1]);
  }
  return result;
}

function handlePlayerMessage(bot, msg, db, logger) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  db.loadState(chatId).then(async state => {
    if (!state || !state.theme || !state.step) return;
    if (deadPlayers[chatId] && deadPlayers[chatId][userId] && deadPlayers[chatId][userId] > state.step) {
      bot.sendMessage(chatId, `@${msg.from.username || msg.from.first_name}, ты пока вне игры! Жди воскрешения.`);
      return;
    }
    const mentions = extractMentions(msg.text || '');
    state.history.push({ type: 'action', user: userId, username: msg.from.username, text: msg.text, mentions, step: state.step });
    db.saveState(chatId, state);
    logger.info(`Ответ игрока ${msg.from.username}: ${msg.text}`);

    // Саркастический комментарий к ответу
    const commentPrompt = `Ты — ведущий максимально агрессивного и неприличного roast-style шоу, как комик на прожарке. Прокомментируй с жёстким сарказмом, чёрным юмором, обидно, агрессивно, иногда даже грубо, но не переходи на запрещённые темы. Не используй эмодзи, не используй *, **, _ и другие символы для выделения текста, не предлагай варианты ответов. Ответ должен быть не длиннее 300 символов. Очень редко можешь похвалить, но в основном — прожарь игрока. Вот действие игрока: "${msg.text}". Не повторяй сам ответ, а именно прокомментируй.`;
    const comment = await deepseek.askDeepSeek([
      { role: 'system', content: commentPrompt }
    ]);
    bot.sendMessage(chatId, `@${msg.from.username || msg.from.first_name}, ${comment}`);

    // Отметить, что игрок ответил на этот шаг
    stepResponded[chatId] = stepResponded[chatId] || {};
    stepResponded[chatId][userId] = true;

    // Проверить, все ли участники ответили (кроме бота)
    const membersCount = await bot.getChatMemberCount(chatId);
    const uniqueResponded = Object.keys(stepResponded[chatId] || {}).length;
    if (uniqueResponded >= membersCount - 1) {
      clearTimeout(stepTimers[chatId]);
      await summarizeStep(bot, chatId, db, logger);
    }
  });
}

async function summarizeStep(bot, chatId, db, logger) {
  const state = await db.loadState(chatId);
  const actions = state.history.filter(e => e.type === 'action' && e.step === state.step);
  let summaryPrompt;
  if (actions.length === 0) {
    summaryPrompt = `Ты — ведущий D&D с чёрным юмором. Никто не сделал ничего в ответ на ситуацию. Подведи итог раунда с сарказмом и чёрным юмором, высмей бездействие.`;
  } else {
    const actionsText = actions.map(a => `@${a.username}: ${a.text}`).join('\n');
    summaryPrompt = `Ты — ведущий D&D с чёрным юмором. Подведи итог действий игроков:\n${actionsText}\nДобавь сарказма, чёрного юмора, иногда похвали, но чаще поддразни. В конце напиши: 'Что же будет дальше — узнаете в следующем шаге.'`;
  }
  const summary = await deepseek.askDeepSeek([
    { role: 'system', content: summaryPrompt }
  ]);
  bot.sendMessage(chatId, summary);
  // Сбросить отметки ответивших
  stepResponded[chatId] = {};
}

function init(bot, db, logger) {
  // Приветствие при добавлении в группу
  bot.on('new_chat_members', async (msg) => {
    // Всегда приветствуем новых участников, если среди них есть не только бот
    let members = msg.new_chat_members.map(m => m.first_name || m.username || 'кто-то');
    if (members.length === 0) return;
    const welcomePrompt = `Ты — ведущий D&D с чёрным юмором. Поприветствуй новых игроков: ${members.join(', ')}. 
    Используй сарказм и чёрный юмор, намекни на возможную "смерть" персонажей, но оставайся дружелюбным. 
    Сделай отсылку к D&D и настольным играм.
    Добавь упоминание через @ для организатора группы: @${msg.from.username || msg.from.first_name}.
    Ответ должен быть не длиннее 2-3 предложений.`;
    try {
      const welcome = await deepseek.askDeepSeek([
        { role: 'system', content: welcomePrompt }
      ]);
      bot.sendMessage(msg.chat.id, 
        `\u{1F47B} <b>Я — ваш ведущий D&D с чёрным юмором!</b>\n\n${welcome}\n\n` +
        `Готовьтесь к боли, сарказму и неожиданным поворотам. Пишите /start, чтобы начать страдать!`, 
        { parse_mode: 'HTML' }
      );
      // Отправить короткое описание игры
      try {
        const aboutPrompt = `Ты — ведущий D&D с чёрным юмором. Кратко и простым языком (1-2 предложения) объясни новым игрокам, что ты ведущий, что будет происходить (игра, приключения, чёрный юмор, можно умереть, но весело), и что им нужно делать (писать свои действия, использовать /start). Не используй сложные слова, добавь сарказм.`;
        const about = await deepseek.askDeepSeek([
          { role: 'system', content: aboutPrompt }
        ]);
        bot.sendMessage(msg.chat.id, about);
      } catch (e) {
        bot.sendMessage(msg.chat.id, 'Я ведущий этой D&D-игры. Буду придумывать вам приключения, шутить и иногда "убивать" персонажей. Просто пишите свои действия и не бойтесь умереть — тут это весело!');
      }
    } catch (error) {
      logger.error('Error generating welcome message:', error);
      const fallbackJokes = [
        `@${msg.from.username || msg.from.first_name}, ты теперь официально в игре, поздравляю, но не надейся на лёгкую жизнь!`,
        `Вас тут много, но выживут не все. Особенно если будете слушать советы @${msg.from.username || msg.from.first_name}.`,
        `Если кто-то думал, что это будет обычный D&D — вы ошиблись чатом. Тут даже кубики плачут.`,
        `В этой игре можно умереть... от смеха. Или от тупости соседа.`,
        `@${members.join(', @')}, добро пожаловать в клуб мазохистов!`
      ];
      bot.sendMessage(msg.chat.id, 
        `\u{1F47B} <b>Я — ваш ведущий D&D с чёрным юмором!</b>\n\n${fallbackJokes[Math.floor(Math.random()*fallbackJokes.length)]}\n\n` +
        `Готовьтесь к боли, сарказму и неожиданным поворотам. Пишите /start, чтобы начать страдать!`, 
        { parse_mode: 'HTML' }
      );
      // Отправить короткое описание игры (fallback)
      bot.sendMessage(msg.chat.id, 'Я ведущий этой D&D-игры. Буду придумывать вам приключения, шутить и иногда "убивать" персонажей. Просто пишите свои действия и не бойтесь умереть — тут это весело!');
    }
  });

  bot.on('callback_query', (query) => {
    if (query.data.startsWith('vote_theme_')) {
      handleVote(bot, query, db, logger);
      // Проверка: если проголосовали все участники (кроме бота)
      bot.getChatAdministrators(query.message.chat.id).then(admins => {
        const adminIds = admins.map(a => a.user.id);
        bot.getChatMemberCount(query.message.chat.id).then(count => {
          const votes = activeVotes[query.message.chat.id]?.votes || {};
          // -1 потому что бот тоже в чате
          if (Object.keys(votes).length >= count - 1) {
            finishVoting(bot, query.message.chat.id, db, logger);
          }
        });
      });
    } else if (query.data === 'next_step') {
      nextStep(bot, query.message.chat.id, db, logger);
      bot.answerCallbackQuery({ callback_query_id: query.id, text: 'Следующий шаг!' });
    }
  });
  bot.on('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
      handlePlayerMessage(bot, msg, db, logger);
    }
  });
}

async function nextStep(bot, chatId, db, logger) {
  const state = await db.loadState(chatId);
  if (!state || !state.theme) return;
  const themes = getAllThemes();
  const theme = themes.find(t => t.id === state.theme);
  let lastSituation = state.history.filter(e => e.type === 'situation').slice(-1)[0]?.text || '';
  let lastActions = state.history.filter(e => e.type === 'action').map(e => e.text).join('\n');
  const users = [...new Set(state.history.filter(e => e.type === 'action').map(e => e.user))];
  let killUser = null;
  if (users.length > 0 && Math.random() < 0.4) {
    const alive = users.filter(u => !deadPlayers[chatId] || !deadPlayers[chatId][u] || deadPlayers[chatId][u] <= state.step);
    if (alive.length > 0) {
      killUser = alive[Math.floor(Math.random() * alive.length)];
      deadPlayers[chatId] = deadPlayers[chatId] || {};
      deadPlayers[chatId][killUser] = state.step + 2;
    }
  }
  if (deadPlayers[chatId]) {
    for (const [uid, until] of Object.entries(deadPlayers[chatId])) {
      if (until <= state.step) delete deadPlayers[chatId][uid];
    }
  }
  let killMsg = '';
  if (killUser) {
    const killed = state.history.find(e => e.user === killUser)?.username || 'один из игроков';
    killMsg = `\nP.S. ${killed} временно выбывает из игры! Но не переживай, тебя скоро воскресит чёрный юмор.`;
  }
  let prompt;
  if (theme.id === 'dungeons-python') {
    prompt = `Ты — ведущий эпического путешествия во времени в Россию 90-х с чёрным юмором. Продолжи приключение: придумай необычную, угарную ситуацию, вдохновляйся реальными историями из 90-х, добавляй неожиданные повороты. Стиль D&D только в механике, не в мире. Последняя ситуация: ${lastSituation}\nОтветы игроков: ${lastActions}${killMsg}\nНе предлагай варианты ответов, не подсказывай игрокам, что делать. Не используй *, **, _ и другие символы для выделения текста. Просто обычный текст, не более 700 символов.`;
  } else {
    prompt = `Ты — ведущий D&D с чёрным юмором. Продолжи приключение во вселенной: ${theme.name}. Последняя ситуация: ${lastSituation}\nОтветы игроков: ${lastActions}${killMsg}\nСделай новый поворот, добавь юмора, язвительности, можешь "убить" кого-то на 1-2 хода, но потом вернуть. Не предлагай варианты ответов, не подсказывай игрокам, что делать. Не используй *, **, _ и другие символы для выделения текста. Просто обычный текст, не более 700 символов.`;
  }
  const next = await deepseek.askDeepSeek([
    { role: 'system', content: prompt }
  ]);
  state.history.push({ type: 'situation', text: next });
  state.step++;
  db.saveState(chatId, state);
  bot.sendMessage(chatId, `${next}`);
  // После отправки ситуации:
  // Установить таймер на 30 минут для подведения итогов
  clearTimeout(stepTimers[chatId]);
  stepTimers[chatId] = setTimeout(() => summarizeStep(bot, chatId, db, logger), 30 * 60 * 1000);
}

module.exports = { init, startThemeVoting, startFirstStep };
