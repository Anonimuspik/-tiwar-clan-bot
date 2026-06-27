// clan-bot.js — Монитор Клана
const { chromium } = require('playwright');
const https = require('https');
const {
    getRandomQuestions, getQuizState, setQuizState,
    formatQuestion, CORRECT_ANSWERS
} = require('./forum_quiz');
const {
    handleAiChatCommand,
    tickAiChat,
    handleLsMessage,
    splitMessage,
} = require('./ai_chat');

const BASE_URL      = 'https://tiwar.ru';
const CLAN_ID       = '41140';
const BOT_NICK      = 'Монитор Клана';
const BOT_USER_ID   = '18170326';
const ADMIN_NICK    = 'Kaneki';
const CLAN_NAME     = 'Багровая Луна';

const GIST_ID      = process.env.GIST_ID;
const GIST_TOKEN   = process.env.GIST_TOKEN;
const COOKIES_JSON = process.env.COOKIES_JSON_MONITOR || process.env.COOKIES_JSON;

function getMsk() {
    const d = new Date();
    d.setMinutes(d.getMinutes() + d.getTimezoneOffset() + 180);
    return d;
}

function todayKey() {
    const d = getMsk();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Страница в XHTML — амперсанды в href всегда экранированы как &amp; (и т.п.).
// Перед навигацией по извлечённой регуляркой ссылке ОБЯЗАТЕЛЬНО раскодировать,
// иначе вместо двух параметров (?conf=X&yes=1) уйдёт один склеенный (?conf=X&amp;yes=1).
function unescapeHtml(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

const SCHEDULE = [
    { time: 600,  type: 'morning' },
    { time: 842,  type: 'morning' },   // ВРЕМЕННО: разовая проверка, удали после теста
    { time: 1000, type: 'before_fight', fight: 'Клановый колизей',  fightTime: '10:30' },
    { time: 1030, type: 'before_fight', fight: 'Клановый турнир',   fightTime: '11:00' },
    { time: 1330, type: 'before_fight', fight: 'Древние алтари',    fightTime: '14:00' },
    { time: 1430, type: 'before_fight', fight: 'Клановый колизей',  fightTime: '15:00' },
    { time: 1830, type: 'before_fight', fight: 'Клановый турнир',   fightTime: '19:00' },
    { time: 2030, type: 'before_fight', fight: 'Древние алтари',    fightTime: '21:00' },
    { time: 2330, type: 'night' },
    { time: 2335, type: 'collect_members' },
    { time: 2350, type: 'collect_exp' },
];

// Переводит HHMM (например 1430) в минуты от начала суток (870)
function hhmmToMinutes(t) {
    return Math.floor(t / 100) * 60 + (t % 100);
}

const RANK_REQUIREMENTS = {
    'Лидер клана': { expPerDay: 0,      battlesPerWeek: 30 },
    'Заместитель': { expPerDay: 0,      battlesPerWeek: 27 },
    'Генерал':     { expPerDay: 450000, battlesPerWeek: 27 },
    'Офицер':      { expPerDay: 250000, battlesPerWeek: 25 },
    'Боец':        { expPerDay: 100000, battlesPerWeek: 23 },
    'Новобранец':  { expPerDay: 70000,  battlesPerWeek: 13 },
};

// ── Квиз состояния ───────────────────────────────────────────────────────────
const QUIZ_TIMEOUT_MS  = 15 * 60 * 1000; // 15 мин блокировка после провала
const QUIZ_ANSWER_MS   = 2  * 60 * 1000; // 2 мин на ответ
const FORUM_DEADLINE   = '30 июня / June 30';

const BOT_RANKS = { 0: 'Участник', 1: 'Ветеран', 2: 'Страж', 3: 'Доверенное лицо', 4: 'Верхушка' };

// ── Gist ─────────────────────────────────────────────────────────────────────

async function gistRequest(method, data = null) {
    return new Promise((resolve, reject) => {
        const body = data ? JSON.stringify(data) : null;
        const options = {
            hostname: 'api.github.com',
            path: `/gists/${GIST_ID}`,
            method,
            headers: {
                'Authorization': `token ${GIST_TOKEN}`,
                'User-Agent': 'tiwar-clan-bot',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            }
        };
        const req = https.request(options, res => {
            let resp = '';
            res.on('data', d => resp += d);
            res.on('end', () => { try { resolve(JSON.parse(resp)); } catch(e) { resolve({}); } });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function loadData() {
    const defaults = { members: {}, weeklyExp: {}, weeklyBattles: {}, announcements: {}, botRanks: {} };
    try {
        console.log('[gist] Загружаем данные...');
        const gist = await gistRequest('GET');
        const raw = gist.files?.['data.json']?.content;
        if (raw) {
            const parsed = JSON.parse(raw);
            const merged = { ...defaults, ...parsed };
            merged.botRanks = { ...(parsed.botRanks || {}) };
            merged.botRanks[ADMIN_NICK] = 4;
            console.log('[gist] Данные загружены, игроков:', Object.keys(merged.members).length);
            return merged;
        }
    } catch(e) { console.log('[gist] Ошибка загрузки:', e.message); }
    defaults.botRanks[ADMIN_NICK] = 4;
    return defaults;
}

async function saveData(data) {
    try {
        if (!data.botRanks) data.botRanks = {};
        data.botRanks[ADMIN_NICK] = 4;
        await gistRequest('PATCH', { files: { 'data.json': { content: JSON.stringify(data, null, 2) } } });
        console.log('[gist] Данные сохранены');
    } catch(e) { console.log('[gist] Ошибка сохранения:', e.message); }
}

// ── Навигация ─────────────────────────────────────────────────────────────────

async function navigate(page, url, wait = 2000) {
    console.log(`[nav] Переходим: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(wait);
    console.log(`[nav] Загружено: ${page.url()}`);
}

async function pageHtml(page) {
    return page.evaluate(() => document.body.innerHTML);
}

// ── Объявление (ПРАВИЛЬНЫЙ ПУТЬ) ──────────────────────────────────────────────

// Заходит на страницу клана и возвращает свежую ссылку "Управление кланом".
// Важно: ссылка содержит одноразовый/привязанный к клику токен ?r=..., поэтому
// её нельзя кэшировать и использовать повторно — каждый раз нужен новый клик.
async function getFreshAdmUrl(page) {
    await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/`, 1500);
    const clanHtml = await pageHtml(page);
    const admLinkMatch = clanHtml.match(/href="(\/clan\/\d+\/\d+\/adm\/[^"]+)"/);
    if (!admLinkMatch) {
        console.log(`[announce] ОШИБКА: ссылка Управление кланом не найдена!`);
        console.log(`[announce] HTML фрагмент (поиск adm): ${clanHtml.substring(clanHtml.indexOf('adm') - 50, clanHtml.indexOf('adm') + 100)}`);
        return null;
    }
    return BASE_URL + unescapeHtml(admLinkMatch[1]);
}

async function sendAnnouncement(page, text) {
    console.log(`[announce] === Отправляем объявление ===`);
    console.log(`[announce] Текст: ${text.substring(0, 80)}...`);

    // Шаг 1: идём на страницу клана и кликаем "Управление кланом"
    console.log(`[announce] Шаг 1-2: переходим на /clan/${CLAN_ID}/ и ищем ссылку Управление кланом...`);
    let admUrl = await getFreshAdmUrl(page);
    if (!admUrl) return;
    console.log(`[announce] Ссылка найдена: ${admUrl}`);

    // Шаг 3: переходим на страницу управления
    console.log(`[announce] Шаг 3: переходим на страницу управления...`);
    await navigate(page, admUrl, 2000);
    let admHtml = await pageHtml(page);

    // Если висит баннер "Клановое объявление: ...Скрыть" от предыдущей отправки —
    // форма ввода не рендерится, пока баннер не закрыт. Закрываем баннер, а затем
    // ОБЯЗАТЕЛЬНО заново кликаем "Управление кланом" с нуля — старую ссылку
    // с использованным ?r=... повторно открыть нельзя.
    if (admHtml.includes('close_clan_msg=true')) {
        console.log(`[announce] Виден баннер последнего объявления — закрываем...`);
        const closeMatch = admHtml.match(/href="([^"]*close_clan_msg=true[^"]*)"/);
        if (closeMatch) {
            const closeHref = unescapeHtml(closeMatch[1]);
            const closeUrl = closeHref.startsWith('http')
                ? closeHref
                : closeHref.startsWith('/')
                    ? BASE_URL + closeHref
                    : admUrl.split('?')[0] + closeHref; // admUrl уже содержит https://tiwar.ru — BASE_URL тут не добавляем
            await navigate(page, closeUrl, 1500);

            console.log(`[announce] Баннер закрыт — заново кликаем Управление кланом...`);
            admUrl = await getFreshAdmUrl(page);
            if (!admUrl) return;
            console.log(`[announce] Новая ссылка: ${admUrl}`);
            await navigate(page, admUrl, 1500);
            admHtml = await pageHtml(page);
        }
    }

    // Шаг 4: ищем поле ввода объявления
    console.log(`[announce] Шаг 4: ищем input[name="text"]...`);
    const inputEl = await page.$('input[name="text"]');
    if (!inputEl) {
        console.log(`[announce] ОШИБКА: поле ввода не найдено!`);
        // Показываем кусок HTML для диагностики
        const idx = admHtml.indexOf('объявление');
        if (idx > -1) {
            console.log(`[announce] HTML вокруг "объявление": ${admHtml.substring(idx - 50, idx + 300)}`);
        } else {
            console.log(`[announce] Слово "объявление" не найдено в HTML`);
            console.log(`[announce] Первые 500 символов HTML: ${admHtml.substring(0, 500)}`);
        }
        return;
    }
    console.log(`[announce] Поле ввода найдено!`);

    // Шаг 5: вводим текст (максимум 126 символов — реальный лимит объявления в игре)
    const finalText = text.substring(0, 126);
    console.log(`[announce] Шаг 5: вводим текст (${finalText.length} символов)`);
    await inputEl.fill(finalText);

    // Шаг 6: отправляем
    console.log(`[announce] Шаг 6: нажимаем Отправить...`);
    const submitBtn = await page.$('input[type="submit"][value="Отправить"]');
    if (submitBtn) {
        await submitBtn.click();
    } else {
        await inputEl.press('Enter');
    }
    await page.waitForTimeout(2000);
    console.log(`[announce] Объявление отправлено!`);
}

function morningText() {
    const t = getMsk();
    const hh = String(t.getHours()).padStart(2,'0');
    const mm = String(t.getMinutes()).padStart(2,'0');
    return `Я Терминал [${hh}:${mm} МСК]: Доброе утро! Хорошего дня! Не забывайте ходить на сражения и пополнять казну для активации и прокачки статуи / Good morning! Have a great day! Don't forget battles & treasury!`;
}
function nightText() {
    const t = getMsk();
    const hh = String(t.getHours()).padStart(2,'0');
    const mm = String(t.getMinutes()).padStart(2,'0');
    return `Я Терминал [${hh}:${mm} МСК]: Всем доброй ночи, надеюсь вы выполнили норму! / Good night everyone, hope you've completed your quota!`;
}
function beforeFightText(fightName, fightTime) {
    const names = {
        'Клановый колизей': 'Клановый колизей / Clan Coliseum',
        'Клановый турнир':  'Клановый турнир / Clan Tournament',
        'Древние алтари':   'Древние алтари / Ancient Altars',
    };
    const t = getMsk();
    const hh = String(t.getHours()).padStart(2,'0');
    const mm = String(t.getMinutes()).padStart(2,'0');
    return `Я Терминал [${hh}:${mm} МСК]: Через 30 мин ${names[fightName]||fightName} (${fightTime}). Прошу всех явиться! / In 30 min, please attend!`;
}

// ── Личные сообщения ──────────────────────────────────────────────────────────

async function sendMail(page, userId, text) {
    console.log(`[mail-send] Пишем userId=${userId}`);
    await navigate(page, `${BASE_URL}/mail/${userId}/`, 2000);
    const textarea = await page.$('textarea[name="text"]');
    if (!textarea) { console.log('[mail-send] textarea не найдена!'); return false; }
    await textarea.fill(text);
    const sendBtn = await page.$('input[name="send_message"]');
    if (sendBtn) { await sendBtn.click(); }
    await page.waitForTimeout(2000);
    console.log('[mail-send] Сообщение отправлено');
    return true;
}

// ── Проверка почты ────────────────────────────────────────────────────────────

async function checkMail(page, data) {
    console.log('[mail] === Проверяем почту ===');
    await navigate(page, BASE_URL, 2000);
    const html = await pageHtml(page);

    if (!html.includes('Новая почта')) {
        console.log('[mail] Новых писем нет');
        return;
    }

    console.log('[mail] Есть новая почта! Переходим в /mail/');
    await navigate(page, `${BASE_URL}/mail/`, 2000);
    const mailHtml = await pageHtml(page);

    const newMailRegex = /href="\/mail\/(\d+)\/\d+\/"/g;
    let match;
    const toProcess = [];

    while ((match = newMailRegex.exec(mailHtml)) !== null) {
        const uid = match[1];
        if (uid === BOT_USER_ID) continue;
        const nearby = mailHtml.substring(match.index, match.index + 400);
        if (nearby.includes('dgreen') && nearby.includes('+')) {
            if (!toProcess.find(x => x.userId === uid)) {
                toProcess.push({ userId: uid });
                console.log(`[mail] Новый диалог с userId=${uid}`);
            }
        }
    }

    if (toProcess.length === 0) {
        console.log('[mail] Нет диалогов с новыми сообщениями');
        return;
    }

    console.log(`[mail] Обрабатываем ${toProcess.length} диалог(ов)`);
    for (const { userId } of toProcess) {
        try {
            await processDialog(page, data, userId);
        } catch(e) {
            console.log(`[mail] ОШИБКА при обработке диалога ${userId}:`, e.message);
        }
    }
}

async function processDialog(page, data, userId) {
    console.log(`[dialog] === Обрабатываем диалог userId=${userId} ===`);
    await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
    const convHtml = await pageHtml(page);

    // Ник из заголовка
    const nickMatch = convHtml.match(/Диалог с ([^<"(]+)/);
    const senderNick = nickMatch ? nickMatch[1].trim() : 'Неизвестный';
    console.log(`[dialog] Отправитель: "${senderNick}"`);

    // Парсим блоки — берём первое сообщение НЕ от бота
    const blockRegex = /href="\/user\/(\d+)\/">([^<]+)<\/a>[\s\S]{0,500}?<span class="white">([\s\S]*?)<\/span>/g;
    const blocks = [...convHtml.matchAll(blockRegex)];
    console.log(`[dialog] Найдено блоков сообщений: ${blocks.length}`);

    let msgText = '';      // lowercase — для сравнения команд
    let msgOrig = '';      // оригинал — для извлечения аргументов (ников)
    for (const block of blocks) {
        const blockUserId = block[1];
        const blockNick = block[2].trim();
        const blockText = block[3].replace(/<[^>]+>/g, '').trim();
        console.log(`[dialog] Блок от userId=${blockUserId} (${blockNick}): "${blockText.substring(0,50)}"`);
        if (blockUserId !== BOT_USER_ID && blockText) {
            msgOrig = blockText.trim();
            msgText = msgOrig.toLowerCase();
            console.log(`[dialog] Берём это сообщение как команду: "${msgText}"`);
            break;
        }
    }

    if (!msgText) {
        console.log('[dialog] Нет сообщений от пользователя (только наши)');
        return;
    }

    // Не отвечаем дважды
    const lastRepliedKey = `lastReplied_${userId}`;
    if (data[lastRepliedKey] === msgText) {
        console.log('[dialog] Уже отвечали на это сообщение, пропускаем');
        return;
    }

    // Проверяем клан
    console.log(`[dialog] Проверяем клан пользователя userId=${userId}...`);
    const isOurClan = await checkUserClan(page, userId);
    console.log(`[dialog] Из нашего клана: ${isOurClan}`);

    // Возвращаемся на диалог
    console.log(`[dialog] Возвращаемся на диалог...`);
    await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);

    if (!isOurClan) {
        console.log('[dialog] Отвечаем: не из нашего клана');
        await sendMailReplyOnPage(page, userId, 'Ты не из нашего клана. / You are not from our clan.');
        data[lastRepliedKey] = msgText;
        return;
    }

    const botRank = data.botRanks[senderNick] ?? 0;
    let member = data.members[senderNick];
    console.log(`[dialog] Ранг бота: ${botRank} (${BOT_RANKS[botRank]}), в базе: ${!!member}`);

    // Если игрок не в базе — загружаем его данные прямо сейчас
    if (!member) {
        console.log(`[dialog] Игрок "${senderNick}" не в базе, пробуем найти на странице клана...`);
        try {
            await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/`, 2000);
            const clanHtml = await pageHtml(page);
            // Ищем ник на всех страницах клана
            let foundMember = null;
            let clanPageNum = 1;
            while (!foundMember) {
                const url = clanPageNum === 1 ? `${BASE_URL}/clan/${CLAN_ID}/` : `${BASE_URL}/clan/${CLAN_ID}//${clanPageNum}`;
                if (clanPageNum > 1) { await navigate(page, url, 2000); }
                const html = clanPageNum === 1 ? clanHtml : await pageHtml(page);
                // Ищем строку с ником
                const escapedNick = senderNick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const nickRe = new RegExp(`href="/(user|clan/\\d+/redact)/(\\d+)/"[^>]*>[^>]*>` + escapedNick + `,\\s*<span[^>]*>(?:<span[^>]*>)?([\\w\\sА-Яа-яёЁ]+)`);
                const m = html.match(nickRe);
                if (m) {
                    foundMember = { userId, gameRank: m[3].trim() };
                    console.log(`[dialog] Найден: userId=${userId}, ранг="${foundMember.gameRank}"`);
                    data.members[senderNick] = { userId, gameRank: foundMember.gameRank, botRank: botRank, joinedTracking: todayKey(), isNew: false };
                    member = data.members[senderNick];
                    break;
                }
                const hasNext = html.includes(`/clan/${CLAN_ID}//${clanPageNum + 1}`);
                if (!hasNext) break;
                clanPageNum++;
            }
            if (!member) {
                console.log(`[dialog] Игрок "${senderNick}" не найден на страницах клана`);
                // Добавляем с userId и неизвестным рангом чтобы команды работали
                data.members[senderNick] = { userId, gameRank: 'Новобранец', botRank: botRank, joinedTracking: todayKey(), isNew: false };
                member = data.members[senderNick];
                console.log(`[dialog] Добавлен с рангом по умолчанию: Новобранец`);
            }
            // Возвращаемся на диалог
            await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
        } catch(e) {
            console.log(`[dialog] Ошибка при поиске игрока:`, e.message);
            await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
        }
    }

    console.log(`[dialog] Обрабатываем команду: "${msgText}"`);

    // Сначала проверяем квиз-команды (/start /ru /en /форум /forum + ответы)
    const quizKeywords = ['/start', '/ru', '/en', '/форум', '/forum', '/готов', '/готова', '/ready'];
    const isQuizState = data.quizStates?.[userId]?.step === 'quiz';
    const isQuizCmd = quizKeywords.some(k => msgText.startsWith(k)) || isQuizState;

    let reply;
    if (isQuizCmd) {
        reply = await handleQuiz(msgText, senderNick, userId, data, page);
        await saveData(data);
    }
    if (!reply) {
        reply = await processCommand(msgText, msgOrig, senderNick, userId, botRank, member, data, page);
    }
    // Если ни квиз ни команда не ответили — пробуем ЛС-режим МАГИ (если включён)
    if (!reply) {
        const lsReply = await handleLsMessage(msgOrig, data);
        if (lsReply) {
            // Длинный ответ разбиваем на части
            const parts = splitMessage(lsReply, 490);
            if (parts.length === 1) {
                reply = lsReply;
            } else {
                // Отправляем все части по одной
                for (const part of parts) {
                    await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 1500);
                    await sendMailReplyOnPage(page, userId, part);
                }
                data[lastRepliedKey] = msgText;
                console.log('[dialog] ЛС-МАГИ: отправлено несколько частей');
                return;
            }
        }
    }

    // Возвращаемся на диалог после processCommand (он мог переключить страницу)
    console.log(`[dialog] Возвращаемся на диалог для отправки ответа...`);
    await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);

    if (reply) {
        await sendMailReplyOnPage(page, userId, reply);
        data[lastRepliedKey] = msgText;
        console.log('[dialog] Ответ отправлен');
    } else {
        console.log('[dialog] Нет ответа для отправки');
    }
}

async function sendMailReplyOnPage(page, userId, text) {
    console.log(`[reply] Ищем textarea на текущей странице...`);
    let textarea = await page.$('textarea[name="text"]');
    if (!textarea) {
        console.log('[reply] textarea не найдена, перезагружаем...');
        await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
        textarea = await page.$('textarea[name="text"]');
        if (!textarea) {
            console.log('[reply] textarea всё ещё не найдена! URL:', page.url());
            const html = await pageHtml(page);
            console.log('[reply] HTML первые 300 символов:', html.substring(0, 300));
            return;
        }
    }
    console.log(`[reply] textarea найдена, вводим текст: "${text.substring(0,60)}"`);
    await textarea.click();
    await textarea.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', {bubbles:true})); }, text);
    const sendBtn = await page.$('input[name="send_message"]');
    if (sendBtn) {
        await sendBtn.click();
        await page.waitForTimeout(2000);
        console.log('[reply] Сообщение отправлено!');
    } else {
        console.log('[reply] Кнопка отправки не найдена!');
    }
}

async function checkUserClan(page, userId) {
    await navigate(page, `${BASE_URL}/user/${userId}/`, 1500);
    const html = await pageHtml(page);
    const found = html.includes(CLAN_NAME);
    console.log(`[clan-check] userId=${userId} в клане "${CLAN_NAME}": ${found}`);
    return found;
}

// ── Живой опыт (по запросу) ───────────────────────────────────────────────────

async function fetchLiveExp(page, senderNick) {
    console.log(`[live-exp] Ищем живой опыт для "${senderNick}" на сайте...`);
    let pageNum = 1;
    while (true) {
        const url = pageNum === 1
            ? `${BASE_URL}/clan/${CLAN_ID}/clanexp/today`
            : `${BASE_URL}/clan/${CLAN_ID}/clanexp/today/${pageNum}`;
        await navigate(page, url, 1500);
        const html = await pageHtml(page);
        // Ник находится между > и </a>, апостроф-спан идёт ПОСЛЕ </a>
        const expRegex = /href="\/user\/\d+\/">([^<]+)<\/a>(?:<span[^>]*>[^<]*<\/span>)?\s*<b>([\d\s']+)<\/b>/g;
        let match;
        while ((match = expRegex.exec(html)) !== null) {
            const nick = match[1].trim();
            if (nick === senderNick) {
                const exp = parseInt(match[2].replace(/[\s']/g, ''), 10);
                console.log(`[live-exp] Найден: ${nick} = ${exp.toLocaleString()}`);
                return exp;
            }
        }
        const hasNext = html.includes(`/clanexp/today/${pageNum + 1}`);
        if (!hasNext) break;
        pageNum++;
    }
    console.log(`[live-exp] "${senderNick}" не найден на страницах опыта`);
    return null;
}

// Живой опыт всех игроков клана (для /топ)
async function fetchAllLiveExp(page) {
    console.log('[live-exp-all] Собираем живой опыт всех игроков...');
    const expMap = {}; // nick → exp
    let pageNum = 1;
    while (true) {
        const url = pageNum === 1
            ? `${BASE_URL}/clan/${CLAN_ID}/clanexp/today`
            : `${BASE_URL}/clan/${CLAN_ID}/clanexp/today/${pageNum}`;
        await navigate(page, url, 1500);
        const html = await pageHtml(page);
        // Логируем кусок HTML для диагностики на первой странице
        if (pageNum === 1) {
            const idx = html.indexOf('/user/');
            if (idx > -1) console.log(`[live-exp-all] HTML образец: ${html.substring(idx - 10, idx + 200).replace(/\n/g,' ')}`);
        }
        // Пробуем оба варианта: с <b> и без (разные страницы могут иметь разную структуру)
        // Вариант 1: <a href="/user/ID/">НИК</a>[span?] <b>ЧИСЛО</b>
        const expRegex1 = /href="\/user\/\d+\/">([^<]+)<\/a>(?:<span[^>]*>[^<]*<\/span>)?\s*<b>([\d\s']+)<\/b>/g;
        // Вариант 2: <a href="/user/ID/">НИК</a>[span?] ЧИСЛО (без <b>)
        const expRegex2 = /href="\/user\/\d+\/">([^<]+)<\/a>(?:<span[^>]*>[^<]*<\/span>)?\s+([\d']+)\s*<br/g;
        let match, found = 0;
        for (const regex of [expRegex1, expRegex2]) {
            regex.lastIndex = 0;
            while ((match = regex.exec(html)) !== null) {
                // Чистим ник: убираем кавычки, апострофы и пробелы по краям
                const nick = match[1].replace(/['"]/g, '').trim();
                const exp = parseInt(match[2].replace(/[\s']/g, ''), 10);
                if (nick !== BOT_NICK && !expMap[nick] && !isNaN(exp)) {
                    expMap[nick] = exp;
                    found++;
                    console.log(`[live-exp-all] ${nick}: ${exp}`);
                }
            }
            if (found > 0) break; // нашли с первым вариантом — второй не нужен
        }
        console.log(`[live-exp-all] Страница ${pageNum}: найдено ${found}`);
        const hasNext = html.includes(`/clanexp/today/${pageNum + 1}`);
        if (!hasNext || found === 0) break;
        pageNum++;
    }
    console.log(`[live-exp-all] Всего игроков с опытом: ${Object.keys(expMap).length}`);
    return expMap;
}

// Получаем ранги всех игроков клана прямо с сайта (для /топ когда data.members пустой)
async function fetchClanRanks(page) {
    console.log('[clan-ranks] Получаем ранги игроков с сайта...');
    const rankMap = {}; // nick → gameRank
    let pageNum = 1;
    while (true) {
        const url = pageNum === 1 ? `${BASE_URL}/clan/${CLAN_ID}/` : `${BASE_URL}/clan/${CLAN_ID}//${pageNum}`;
        await navigate(page, url, 1500);
        const html = await pageHtml(page);
        const memberRegex = /href="\/(?:user|clan\/\d+\/redact)\/(\d+)\/[^"]*"[^>]*>\s*<img[^>]*>((?:[^<,]|<span[^>]*>[^<]*<\/span>)*),\s*<span[^>]*>(?:<span[^>]*>)?([\w\sА-Яа-яёЁ]+)/g;
        let match, found = 0;
        while ((match = memberRegex.exec(html)) !== null) {
            const nick = match[2].replace(/<[^>]+>/g, '').trim();
            const rank = match[3].trim();
            if (nick && nick !== BOT_NICK) { rankMap[nick] = rank; found++; }
        }
        console.log(`[clan-ranks] Страница ${pageNum}: найдено ${found}`);
        const hasNext = html.includes(`/clan/${CLAN_ID}//${pageNum + 1}`);
        if (!hasNext || found === 0) break;
        pageNum++;
    }
    console.log(`[clan-ranks] Всего рангов: ${Object.keys(rankMap).length}`);
    return rankMap;
}

// ── Обработка квиза ──────────────────────────────────────────────────────────

async function handleQuiz(msgRaw, senderNick, userId, data, page) {
    const msg = msgRaw.trim().toLowerCase();
    if (!data.quizStates)  data.quizStates  = {};
    if (!data.quizPassed)  data.quizPassed  = {};
    if (!data.quizBlocked) data.quizBlocked = {};
    if (!data.quizResults) data.quizResults = {};
    const state = data.quizStates[userId] || null;

    // /start
    if (msg === '/start') {
        return 'Я Терминал / I am Terminal\n\nВыберите язык / Choose language:\n/ru — Русский\n/en — English';
    }

    // Выбор языка
    if (msg === '/ru' || msg === '/en') {
        const lang = msg === '/ru' ? 'ru' : 'en';
        data.quizStates[userId] = { lang, step: 'intro' };
        return lang === 'ru'
            ? `Добро пожаловать! 📋\n\nДо ${FORUM_DEADLINE} вам необходимо:\n1. Прочитать форум клана\n2. Пройти тест из 5 вопросов (нужно 3 правильных из 5)\n\nКогда будете готовы — напишите /форум`
            : `Welcome! 📋\n\nBy ${FORUM_DEADLINE} you need to:\n1. Read the clan forum\n2. Pass a 5-question test (need 3 correct out of 5)\n\nWhen ready — type /forum`;
    }

    // /форум или /forum
    if (msg === '/форум' || msg === '/forum') {
        const lang = state?.lang || 'ru';
        const now = Date.now();

        if (data.quizPassed[userId]) {
            return lang === 'ru'
                ? '✅ Вы уже прошли тест! Ждите повышения от лидера.'
                : '✅ You already passed! Await promotion from the leader.';
        }

        if (data.quizBlocked[userId]) {
            const unblockAt = data.quizBlocked[userId];
            if (now < unblockAt) {
                const minLeft = Math.ceil((unblockAt - now) / 60000);
                return lang === 'ru'
                    ? `🔒 Доступ заблокирован. Попробуйте через ${minLeft} мин.`
                    : `🔒 Access blocked. Try again in ${minLeft} min.`;
            }
            delete data.quizBlocked[userId];
        }

        if (!state?.lang) {
            return 'Напишите /start для начала / Type /start to begin';
        }

        const questions = getRandomQuestions();
        data.quizStates[userId] = {
            lang,
            step: 'quiz',
            questions: questions.map(q => q.id),
            current: 0,
            correct: 0,
            questionStartedAt: now,
        };
        const { QUIZ_QUESTIONS } = require('./forum_quiz');
        const firstQ = QUIZ_QUESTIONS.find(q => q.id === questions[0].id) || questions[0];
        return formatQuestion(firstQ, lang, 1, 5);
    }

    // /готов или /ready — просто синоним /форум для тех кто написал после intro
    if (msg === '/готов' || msg === '/готова' || msg === '/ready') {
        if (!state?.lang) return 'Напишите /start / Type /start';
        data.quizStates[userId] = { ...state, step: 'intro' };
        return await handleQuiz('/форум', senderNick, userId, data, page);
    }

    // Ответ на вопрос
    if (state?.step === 'quiz') {
        const { QUIZ_QUESTIONS } = require('./forum_quiz');
        const lang = state.lang;
        const now = Date.now();
        const qId = state.questions[state.current];
        const correctRu = CORRECT_ANSWERS[qId]?.ru || 'б';
        const correctEn = CORRECT_ANSWERS[qId]?.en || 'b';
        const correct = lang === 'ru' ? correctRu : correctEn;

        const elapsed = now - (state.questionStartedAt || now);
        const isTimeout = elapsed > QUIZ_ANSWER_MS;
        // Принимаем и кириллицу и латинские эквиваленты (а=a, б=b, в=v, г=g)
        const latinMap = { 'a': 'а', 'b': 'б', 'v': 'в', 'g': 'г' };
        const normalizedMsg = latinMap[msg] || msg;
        const isCorrect = !isTimeout && (normalizedMsg === correct);

        if (isCorrect) state.correct++;
        const next = state.current + 1;
        state.current = next;
        state.questionStartedAt = now;

        let prefix = '';
        if (isTimeout) prefix = lang === 'ru' ? '⏰ Время вышло, идём дальше.\n\n' : '⏰ Time is up, moving on.\n\n';
        else prefix = isCorrect ? (lang === 'ru' ? '✅ Верно!\n\n' : '✅ Correct!\n\n') : (lang === 'ru' ? '❌ Неверно.\n\n' : '❌ Wrong.\n\n');

        if (next < 5) {
            const nextQ = QUIZ_QUESTIONS.find(q => q.id === state.questions[next]);
            data.quizStates[userId] = state;
            return prefix + formatQuestion(nextQ, lang, next + 1, 5);
        }

        // Финал
        const passed = state.correct >= 3;
        data.quizResults[userId] = { nick: senderNick, passed, correct: state.correct, date: new Date().toISOString() };
        delete data.quizStates[userId];

        if (passed) {
            data.quizPassed[userId] = true;
            // Уведомляем лидера
            if (data.members[ADMIN_NICK]?.userId) {
                await sendMail(page, data.members[ADMIN_NICK].userId,
                    `✅ ${senderNick} прошёл тест форума! Результат: ${state.correct}/5 правильных.`);
            }
            return lang === 'ru'
                ? `🎉 Поздравляем, ${senderNick}! Вы ответили верно на ${state.correct}/5 вопросов!\nВаш результат отправлен лидеру клана. Ждите повышения ранга в Боте! 🏆`
                : `🎉 Congratulations, ${senderNick}! You got ${state.correct}/5 correct!\nYour result was sent to the clan leader. Await your promotion! 🏆`;
        } else {
            data.quizBlocked[userId] = now + QUIZ_TIMEOUT_MS;
            if (data.members[ADMIN_NICK]?.userId) {
                await sendMail(page, data.members[ADMIN_NICK].userId,
                    `❌ ${senderNick} не прошёл тест форума. Результат: ${state.correct}/5.`);
            }
            return lang === 'ru'
                ? `❌ Вы набрали ${state.correct}/5. Нужно минимум 3 правильных.\nПопробуйте снова через 15 минут. Прочитайте форум внимательнее! 📖`
                : `❌ You got ${state.correct}/5. Minimum 3 correct required.\nTry again in 15 minutes. Read the forum more carefully! 📖`;
        }
    }

    return null;
}


async function processCommand(msg, msgOrig, senderNick, userId, botRank, member, data, page) {
    console.log(`[cmd] Команда: "${msg}" от ${senderNick}`);

    // Команды управления ИИ-чатом и форумом
    const aiCmdReply = handleAiChatCommand(msg, botRank, data);
    if (aiCmdReply !== null) { await saveData(data); return aiCmdReply; }

    if (msg.includes('/помощь') || msg.includes('/команды')) {
        console.log('[cmd] → /помощь');
        return buildHelpText(botRank);
    }

    if (msg.includes('/мой опыт')) {
        console.log('[cmd] → /мой опыт');
        if (!member) return 'Вы не найдены в базе данных клана.';
        const exp = getPlayerWeeklyExp(senderNick, data);
        const req = getRequirements(member.gameRank);
        const weeklyNorm = req.expPerDay * 7;
        if (!req.expPerDay) return `Опыт за неделю: ${exp.toLocaleString()}\nДля вашего ранга ограничений по опыту нет.`;
        const pct = Math.round((exp / weeklyNorm) * 100);
        const left = Math.max(0, weeklyNorm - exp);
        return `Опыт за неделю: ${exp.toLocaleString()}\nНорма: ${weeklyNorm.toLocaleString()}\nВыполнено: ${pct}%\n` +
               (left > 0 ? `Осталось: ${left.toLocaleString()}` : 'Норма выполнена!');
    }

    if (msg.includes('/мои сражения')) {
        console.log('[cmd] → /мои сражения');
        if (!member) return 'Вы не найдены в базе данных клана.';
        const battles = getPlayerWeeklyBattles(senderNick, data);
        const req = getRequirements(member.gameRank);
        const pct = Math.round((battles / req.battlesPerWeek) * 100);
        const left = Math.max(0, req.battlesPerWeek - battles);
        return `Ваши сражения за неделю: ${battles}/${req.battlesPerWeek}\nВыполнено: ${pct}%\n` +
               (left > 0 ? `Осталось боёв: ${left}` : 'Норма выполнена!');
    }

    if (msg.includes('/профиль') || msg.includes('/мой профиль')) {
        console.log('[cmd] → /профиль');
        if (!member) return 'Вы не найдены в базе данных клана.';
        const topList = getTopList(data);
        const pos = topList.findIndex(n => n === senderNick) + 1;
        return `${senderNick}\nИгровой ранг: ${member.gameRank}\nРанг в боте: ${BOT_RANKS[botRank]}\nПозиция в топе: #${pos > 0 ? pos : '?'}`;
    }

    if (msg.includes('/в чат от моего имени')) {
        console.log('[cmd] → /в чат');
        const text = msgOrig.replace(/\/в чат от моего имени/i, '').trim();
        if (!text) return 'Напишите текст: /в чат от моего имени текст';
        await sendClanChat(page, `Сообщение от ${senderNick}: ${text}`);
        return 'Сообщение отправлено в чат клана.';
    }

    if (botRank >= 1) {
        if (msg.includes('/топ')) {
            console.log('[cmd] → /топ');
            // 1. Живой опыт
            const liveMap = await fetchAllLiveExp(page);
            const today = todayKey();
            for (const [nick, exp] of Object.entries(liveMap)) {
                if (!data.weeklyExp[nick]) data.weeklyExp[nick] = {};
                data.weeklyExp[nick][today] = exp;
            }
            // 2. Ранги с сайта (чтобы % был у всех, даже если data.members пустой)
            const rankMap = await fetchClanRanks(page);
            // Обновляем data.members рангами (без isNew — они уже в клане)
            for (const [nick, rank] of Object.entries(rankMap)) {
                if (!data.members[nick]) {
                    data.members[nick] = { gameRank: rank, botRank: 0, joinedTracking: today, isNew: false };
                } else {
                    data.members[nick].gameRank = rank;
                }
            }
            // 3. Возвращаемся на диалог
            await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
            // 4. Строим топ — все у кого есть опыт
            const allNicks = new Set([...Object.keys(liveMap), ...Object.keys(data.members)]);
            const ranked = [...allNicks]
                .filter(nick => nick !== BOT_NICK)
                .map(nick => {
                    const exp = getPlayerWeeklyExp(nick, data);
                    const mem = data.members[nick];
                    const gameRank = mem ? mem.gameRank : null;
                    const req = gameRank ? getRequirements(gameRank) : null;
                    const weeklyNorm = (req && req.expPerDay > 0) ? req.expPerDay * 7 : 0;
                    const pct = weeklyNorm > 0 ? Math.round((exp / weeklyNorm) * 100) : null;
                    return { nick, exp, pct };
                })
                .filter(r => r.exp > 0)
                .sort((a, b) => b.exp - a.exp);
            if (!ranked.length) return 'Данных пока нет.';
            const lines = ranked.map((r, i) => {
                const pctStr = r.pct !== null ? ` (${r.pct}%)` : '';
                return `${i+1}. ${r.nick} - ${r.exp.toLocaleString()}${pctStr}`;
            });
            // 5. Отправляем по частям ≤ 590 символов
            let chunk = 'Топ клана за неделю:';
            for (const line of lines) {
                if ((chunk + '\n' + line).length > 590) {
                    await sendMailReplyOnPage(page, userId, chunk);
                    await page.waitForTimeout(3000);
                    await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
                    chunk = line;
                } else {
                    chunk += '\n' + line;
                }
            }
            if (chunk) await sendMailReplyOnPage(page, userId, chunk);
            return null;
        }
        if (msg.includes('/статистика')) {
            console.log('[cmd] → /статистика');
            const targetNick = msgOrig.replace(/\/статистика/i, '').trim();
            if (!targetNick) return 'Укажите ник: /статистика Ник';
            // Ищем сначала в базе, потом прямо на сайте
            let target = data.members[targetNick];
            if (!target) {
                console.log(`[cmd] /статистика: "${targetNick}" не в базе, ищем на сайте...`);
                const rankMap = await fetchClanRanks(page);
                if (rankMap[targetNick]) {
                    data.members[targetNick] = { gameRank: rankMap[targetNick], botRank: 0, joinedTracking: todayKey(), isNew: false };
                    target = data.members[targetNick];
                    await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
                } else {
                    await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
                    return `Игрок "${targetNick}" не найден в клане.`;
                }
            }
            const exp = getPlayerWeeklyExp(targetNick, data);
            const battles = getPlayerWeeklyBattles(targetNick, data);
            const req = getRequirements(target.gameRank);
            const expPct = req.expPerDay ? Math.round((exp/(req.expPerDay*7))*100) : null;
            const batPct = Math.round((battles/req.battlesPerWeek)*100);
            const expLine = req.expPerDay
                ? `Опыт: ${exp.toLocaleString()} / ${(req.expPerDay*7).toLocaleString()} (${expPct}%)`
                : `Опыт: ${exp.toLocaleString()} (без нормы)`;
            return `${targetNick} (${target.gameRank})\n${expLine}\nСражения: ${battles}/${req.battlesPerWeek} (${batPct}%)`;
        }
    }

    if (botRank >= 2) {
        if (msg.includes('/кто не пришёл') || msg.includes('/кто не пришел')) {
            console.log('[cmd] → /кто не пришёл');
            return buildMissingText(data);
        }
        if (msg.includes('/напомни')) {
            console.log('[cmd] → /напомни');
            const targetNick = msgOrig.replace(/\/напомни/i, '').trim();
            const target = data.members[targetNick];
            if (!target) return `Игрок "${targetNick}" не найден.`;
            const req = getRequirements(target.gameRank);
            const exp = getPlayerWeeklyExp(targetNick, data);
            const battles = getPlayerWeeklyBattles(targetNick, data);
            const reminderText = `Привет! Напоминание о норме клана:\nОпыт: ${exp.toLocaleString()} / ${(req.expPerDay*7).toLocaleString()}\nСражения: ${battles} / ${req.battlesPerWeek}\nПостарайся выполнить норму до конца недели!`;
            await sendMail(page, target.userId, reminderText);
            return `Напоминание отправлено ${targetNick}.`;
        }
    }

    if (botRank >= 3) {
        if (msg.includes('/сделай объявление')) {
            console.log('[cmd] → /сделай объявление');
            const text = msgOrig.replace(/\/сделай объявление/i, '').trim();
            if (!text) return 'Напишите текст: /сделай объявление текст';
            await sendAnnouncement(page, text);
            await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
            return 'Объявление отправлено.';
        }
        if (msg.includes('/утро')) {
            console.log('[cmd] → /утро (ручное)');
            await sendAnnouncement(page, morningText());
            await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
            return 'Утреннее объявление отправлено.';
        }
        if (msg.includes('/ночь')) {
            console.log('[cmd] → /ночь (ручное)');
            await sendAnnouncement(page, nightText());
            await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
            return 'Ночное объявление отправлено.';
        }
        if (msg.includes('/предупреждение')) {
            console.log('[cmd] → /предупреждение');
            const targetNick = msgOrig.replace(/\/предупреждение/i, '').trim();
            const target = data.members[targetNick];
            if (!target) return `Игрок "${targetNick}" не найден.`;
            const exp = getPlayerWeeklyExp(targetNick, data);
            const battles = getPlayerWeeklyBattles(targetNick, data);
            const warnText = `Официальное предупреждение!\nВы не выполняете нормы клана.\nОпыт: ${exp.toLocaleString()}\nСражения: ${battles}\nПовысьте активность, иначе вас могут исключить.`;
            await sendMail(page, target.userId, warnText);
            return `Предупреждение отправлено ${targetNick}.`;
        }
    }

    if (botRank >= 4) {
        if (msg.includes('/повысить')) {
            console.log('[cmd] → /повысить');
            const targetNick = msgOrig.replace(/\/повысить/i, '').trim();
            if (!data.members[targetNick]) return `Игрок "${targetNick}" не найден.`;
            const cur = data.botRanks[targetNick] ?? 0;
            if (cur >= 3) return `${targetNick} уже имеет максимальный ранг (${BOT_RANKS[cur]}).`;
            data.botRanks[targetNick] = cur + 1;
            await saveData(data);
            await sendMail(page, data.members[targetNick].userId, `Ваш ранг в боте повышен до "${BOT_RANKS[cur+1]}"! Напишите /профиль чтобы посмотреть.`);
            return `${targetNick} повышен до "${BOT_RANKS[cur+1]}".`;
        }
        if (msg.includes('/понизить')) {
            console.log('[cmd] → /понизить');
            const targetNick = msgOrig.replace(/\/понизить/i, '').trim();
            if (!data.members[targetNick]) return `Игрок "${targetNick}" не найден.`;
            if (targetNick === ADMIN_NICK) return 'Нельзя понизить Верхушку.';
            const cur = data.botRanks[targetNick] ?? 0;
            if (cur <= 0) return `${targetNick} уже на минимальном ранге.`;
            data.botRanks[targetNick] = cur - 1;
            await saveData(data);
            return `${targetNick} понижен до "${BOT_RANKS[cur-1]}".`;
        }
        if (msg.includes('/отчёт') || msg.includes('/отчет')) {
            console.log('[cmd] → /отчёт');
            return buildWeeklyReport(data);
        }
        if (msg.includes('/бан')) {
            console.log('[cmd] → /бан');
            const targetNick = msgOrig.replace(/\/бан/i, '').trim();
            return await banPlayer(page, targetNick, data);
        }
    }

    console.log(`[cmd] Команда не распознана: "${msg}"`);
    return `Команда не найдена. Напишите /помощь для списка команд.`;
}

// ── Сбор данных ───────────────────────────────────────────────────────────────

async function collectMembers(page, data) {
    console.log('[members] === Собираем список членов клана ===');
    const members = {};
    let pageNum = 1;

    while (true) {
        const url = pageNum === 1 ? `${BASE_URL}/clan/${CLAN_ID}/` : `${BASE_URL}/clan/${CLAN_ID}//${pageNum}`;
        await navigate(page, url);
        const html = await pageHtml(page);

        // Парсим ник: может содержать <span class="not_here white">'</span> внутри (напр. Tsukiyama')
        // Ник — всё до запятой после img-тега (включая многословные ники типа "Дикая Ягода")
        const memberRegex = /href="\/(?:user|clan\/\d+\/redact)\/(\d+)\/[^"]*"[^>]*>\s*<img[^>]*>((?:[^<,]|<span[^>]*>[^<]*<\/span>)*),\s*<span[^>]*>(?:<span[^>]*>)?([\w\sА-Яа-яёЁ]+)/g;
        let match, found = 0;
        while ((match = memberRegex.exec(html)) !== null) {
            const userId = match[1];
            // Убираем <span...>'</span> из ника (офлайн апостроф)
            const nick = match[2].replace(/<[^>]+>/g, '').trim();
            const rank = match[3].trim();
            if (nick === BOT_NICK) continue;
            members[nick] = { userId, gameRank: rank };
            found++;
        }
        console.log(`[members] Страница ${pageNum}: найдено ${found} игроков`);

        const hasNext = html.includes(`/clan/${CLAN_ID}//${pageNum + 1}`);
        if (!hasNext || found === 0) break;
        pageNum++;
    }

    console.log(`[members] Всего найдено: ${Object.keys(members).length}`);
    const today = todayKey();
    for (const [nick, info] of Object.entries(members)) {
        if (!data.members[nick]) {
            data.members[nick] = { userId: info.userId, gameRank: info.gameRank, botRank: 0, joinedTracking: today, isNew: true };
            console.log(`[members] Новый игрок: ${nick} (${info.gameRank})`);
        } else {
            data.members[nick].gameRank = info.gameRank;
            data.members[nick].userId = info.userId;
            data.members[nick].isNew = false;
        }
    }
    for (const nick of Object.keys(data.members)) {
        if (!members[nick]) { console.log(`[members] Покинул клан: ${nick}`); delete data.members[nick]; }
    }
}

async function collectExp(page, data) {
    console.log('[exp] === Собираем опыт за сегодня ===');
    const today = todayKey();
    let pageNum = 1;

    while (true) {
        const url = pageNum === 1 ? `${BASE_URL}/clan/${CLAN_ID}/clanexp/today` : `${BASE_URL}/clan/${CLAN_ID}/clanexp/today/${pageNum}`;
        await navigate(page, url);
        const html = await pageHtml(page);

        // Учитываем <span class="not_here">'</span> между </a> и <b> (офлайн игроки)
        const expRegex = /href="\/user\/(\d+)\/">([^<]+?)(?:<span[^>]*>[^<]*<\/span>)*<\/a>(?:<span[^>]*>[^<]*<\/span>)?\s*<b>([\d\s']+)<\/b>/g;
        let match, found = 0;
        while ((match = expRegex.exec(html)) !== null) {
            const nick = match[2].trim(), exp = parseInt(match[3].replace(/[\s']/g, ''), 10);
            if (nick === BOT_NICK || !data.members[nick] || data.members[nick].isNew) continue;
            if (!data.weeklyExp[nick]) data.weeklyExp[nick] = {};
            data.weeklyExp[nick][today] = exp;
            console.log(`[exp] ${nick}: ${exp.toLocaleString()}`);
            found++;
        }

        const hasNext = html.includes(`/clanexp/today/${pageNum + 1}`);
        if (!hasNext || found === 0) break;
        pageNum++;
    }
    console.log('[exp] Опыт собран');
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

function getWeekDates() {
    const dates = [], now = getMsk();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
    return dates;
}
function getPlayerWeeklyExp(nick, data) {
    const exp = data.weeklyExp[nick] || {};
    return getWeekDates().reduce((s, d) => s + (exp[d] || 0), 0);
}
function getPlayerWeeklyBattles(nick, data) { return data.weeklyBattles[nick]?.total || 0; }
function getRequirements(gameRank) { return RANK_REQUIREMENTS[gameRank] || RANK_REQUIREMENTS['Новобранец']; }
function getTopList(data) {
    return Object.keys(data.members).filter(n => !data.members[n].isNew)
        .sort((a, b) => getPlayerWeeklyExp(b, data) - getPlayerWeeklyExp(a, data));
}
function buildTopText(data) {
    const top = getTopList(data).slice(0, 10);
    if (!top.length) return 'Данных пока нет.';
    return 'Топ клана по опыту за неделю:\n' + top.map((n,i) => `${i+1}. ${n} - ${getPlayerWeeklyExp(n,data).toLocaleString()}`).join('\n');
}
function buildMissingText(data) {
    const today = todayKey();
    const missing = Object.entries(data.members).filter(([n,m]) => !m.isNew && !data.weeklyBattles[n]?.dates?.includes(today)).map(([n]) => n);
    return missing.length ? `Не пришли на последнее сражение:\n${missing.join(', ')}` : 'Все присутствовали!';
}
function buildHelpText(botRank) {
    let t = `Ваш ранг: ${BOT_RANKS[botRank]}\nКоманды:\n/start — запуск бота\n/форум (/forum) — тест форума\n/помощь\n/мой опыт за неделю\n/мои сражения за неделю\n/профиль\n/в чат от моего имени (текст)\n`;
    if (botRank >= 1) t += '/топ\n/статистика (ник)\n';
    if (botRank >= 2) t += '/кто не пришёл\n/напомни (ник)\n';
    if (botRank >= 3) t += '/сделай объявление (текст)\n/предупреждение (ник)\n/ии клан чат вкл|выкл\n/ии чат вкл|выкл\n/узнай о игре вкл|выкл\n/расскажи что узнала\n/ии статус\n';
    if (botRank >= 4) t += '/повысить (ник)\n/понизить (ник)\n/бан (ник)\n/отчёт\n';
    return t;
}
function buildWeeklyReport(data) {
    const ok = [], no = [];
    for (const [nick, member] of Object.entries(data.members)) {
        if (member.isNew) continue;
        const req = getRequirements(member.gameRank);
        const exp = getPlayerWeeklyExp(nick, data), battles = getPlayerWeeklyBattles(nick, data);
        const weeklyNorm = req.expPerDay * 7;
        const expOk = !req.expPerDay || exp >= weeklyNorm, battleOk = battles >= req.battlesPerWeek;
        if (expOk && battleOk) {
            const note = [req.expPerDay && exp>weeklyNorm ? `+${(exp-weeklyNorm).toLocaleString()} оп` : '', battles>req.battlesPerWeek ? `+${battles-req.battlesPerWeek} боёв` : ''].filter(Boolean).join(', ');
            ok.push(`${nick} (${note||'норма'})`);
        } else {
            const lacks = [req.expPerDay&&exp<weeklyNorm ? `-${(weeklyNorm-exp).toLocaleString()} оп` : '', battles<req.battlesPerWeek ? `-${req.battlesPerWeek-battles} боёв` : ''].filter(Boolean).join(', ');
            no.push(`${nick}: ${lacks}`);
        }
    }
    return `НЕДЕЛЬНЫЙ ОТЧЁТ\n\nВыполнили (${ok.length}):\n${ok.join('\n')||'Никто'}\n\nНе выполнили (${no.length}):\n${no.join('\n')||'Все молодцы!'}`;
}

async function sendClanChat(page, text) {
    console.log('[chat] Отправляем в чат клана:', text.substring(0,50));
    await navigate(page, `${BASE_URL}/chat/clan/`);
    const input = await page.$('input[type="text"], textarea');
    if (!input) { console.log('[chat] Поле ввода не найдено!'); return; }
    await input.fill(text);
    await input.press('Enter');
    await page.waitForTimeout(1500);
}

async function sendTitansChat(page, text) {
    console.log('[titans-chat] Отправляем в чат Титанов:', text.substring(0,50));
    await navigate(page, 'https://tiwar.ru/chat/titans/changeRoom/?r=23346998');
    const input = await page.$('input[type="text"], textarea');
    if (!input) { console.log('[titans-chat] Поле ввода не найдено!'); return; }
    await input.fill(text);
    await input.press('Enter');
    await page.waitForTimeout(1500);
}

async function sendFridayReport(page, data) {
    console.log('[report] Отправляем пятничный отчёт...');
    const report = buildWeeklyReport(data);
    const lines = report.split('\n');
    let chunk = '';
    const parts = [];
    for (const line of lines) {
        if ((chunk + line).length > 128) { if (chunk) parts.push(chunk.trim()); chunk = line + '\n'; }
        else chunk += line + '\n';
    }
    if (chunk.trim()) parts.push(chunk.trim());
    for (const part of parts) { await sendAnnouncement(page, part); await page.waitForTimeout(3000); }
    data.weeklyExp = {}; data.weeklyBattles = {};
    for (const nick of Object.keys(data.members)) data.members[nick].isNew = false;
    await saveData(data);
}

async function banPlayer(page, targetNick, data) {
    console.log(`[ban] Исключаем: ${targetNick}`);

    // Шаг 1: идём на страницу клана и ищем ссылку "Управление кланом" (ADM)
    await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/`, 2000);
    let html = await pageHtml(page);
    const admMatch = html.match(/href="(\/clan\/\d+\/\d+\/adm\/[^"]+)"/);
    if (!admMatch) {
        console.log(`[ban] ADM ссылка не найдена — нет прав`);
        return `Нет прав для исключения игроков.`;
    }
    const admHref = unescapeHtml(admMatch[1]);
    // admHref вида /clan/41140/5/adm/?r=...
    // Нам нужно просто зайти на ADM, там будет список с redact-ссылками
    const admUrl = BASE_URL + admHref;
    console.log(`[ban] Переходим на ADM: ${admUrl}`);
    await navigate(page, admUrl, 2000);

    // Шаг 2: ищем userId игрока по страницам клана.
    // После визита на ADM ссылки на управление каждым игроком выглядят так:
    // <a href="/clan/41140/redact/ID/"><img ...>НИК[<span>'</span>]?, <span class="white">РАНГ
    // Берём userId прямо из этой ссылки — он и нужен для шага 3.
    let targetId = null;
    let pageNum = 1;
    while (!targetId) {
        const url = pageNum === 1 ? `${BASE_URL}/clan/${CLAN_ID}/` : `${BASE_URL}/clan/${CLAN_ID}//${pageNum}`;
        await navigate(page, url, 1500);
        html = await pageHtml(page);
        const nickFound = html.includes(targetNick);
        console.log(`[ban] Стр. ${pageNum}: ник "${targetNick}" ${nickFound ? 'НАЙДЕН' : 'нет'}`);
        if (nickFound) {
            const escapedNick = targetNick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // href="/clan/41140/redact/ID/"><img ...>НИК[<span>'</span>]?,
            const userRegex = new RegExp(
                `href="/clan/${CLAN_ID}/redact/(\\d+)/"[^>]*><img[^>]*>` +
                escapedNick + `(?:<span[^>]*>[^<]*<\/span>)?\\s*,`,
                'g'
            );
            const userMatches = [...html.matchAll(userRegex)];
            console.log(`[ban] Совпадений userId (redact): ${userMatches.length}`);
            if (userMatches.length > 0) {
                targetId = userMatches[0][1];
                console.log(`[ban] userId=${targetId}`);
                break;
            }
            // Запасной: ищем любой /clan/.../redact/ID/ рядом с ником в радиусе 150 символов
            const idx = html.indexOf('>' + targetNick);
            if (idx > -1) {
                const nearby = html.substring(Math.max(0, idx - 150), idx + 50);
                const idMatch = nearby.match(new RegExp(`/clan/${CLAN_ID}/redact/(\\d+)/`));
                if (idMatch) {
                    targetId = idMatch[1];
                    console.log(`[ban] userId=${targetId} (запасной метод)`);
                    break;
                }
            }
        }
        const hasNext = html.includes(`/clan/${CLAN_ID}//${pageNum + 1}`);
        if (!hasNext) break;
        pageNum++;
    }

    if (!targetId) {
        return `Игрок "${targetNick}" не найден в клане.`;
    }

    // Шаг 3: переходим на redact страницу игрока (доступна после ADM)
    console.log(`[ban] Переходим на redact: /clan/${CLAN_ID}/redact/${targetId}/`);
    await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/redact/${targetId}/`, 2000);
    html = await pageHtml(page);

    // Шаг 4: ищем ссылку "Исключить из клана"
    const deleteMatch = html.match(/href="(\/clan\/[^"]*\/redact\/\d+\/delete\/[^"]*)"/);
    if (!deleteMatch) {
        console.log(`[ban] Кнопка исключения не найдена. HTML: ${html.substring(0, 300)}`);
        return `Не удалось найти кнопку исключения для ${targetNick}.`;
    }
    const deleteHref = unescapeHtml(deleteMatch[1]);
    console.log(`[ban] Кнопка исключения: ${deleteHref}`);
    await navigate(page, BASE_URL + deleteHref, 2000);

    // Шаг 5: подтверждаем "Да, уверен"
    html = await pageHtml(page);
    const confirmMatch = html.match(/href="([^"]*yes=1[^"]*)"/);
    if (!confirmMatch) {
        console.log(`[ban] Кнопка подтверждения не найдена`);
        return `Ошибка подтверждения исключения.`;
    }
    const confirmHref = unescapeHtml(confirmMatch[1]);
    console.log(`[ban] Подтверждаем: ${confirmHref}`);
    await navigate(page, BASE_URL + confirmHref, 2000);

    // Шаг 6: проверяем, что игрок действительно исключён, а не просто залогировали "успешно"
    const checkHtml = await pageHtml(page);
    const stillThere = checkHtml.includes(targetNick);
    if (stillThere) {
        console.log(`[ban] ВНИМАНИЕ: после подтверждения ник "${targetNick}" всё ещё встречается на странице — исключение, похоже, НЕ сработало`);
    }

    delete data.members[targetNick];
    await saveData(data);

    if (stillThere) {
        console.log(`[ban] ${targetNick} — подтверждение не дало результата`);
        return `Не удалось подтвердить исключение ${targetNick} — проверьте вручную, возможно ссылка была неверной.`;
    }
    console.log(`[ban] ${targetNick} исключён успешно`);
    return `Игрок ${targetNick} исключён из клана.`;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
    console.log('[clan-bot] =============================');
    console.log('[clan-bot] Запуск:', new Date().toISOString());
    console.log('[clan-bot] =============================');

    if (!GIST_ID || !GIST_TOKEN) { console.error('[clan-bot] Не заданы GIST_ID или GIST_TOKEN!'); process.exit(1); }

    const rawCookies = JSON.parse(COOKIES_JSON);
    const cookies = rawCookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain || 'tiwar.ru', path: c.path || '/',
        expires: c.expirationDate || c.expires || -1,
        httpOnly: c.httpOnly || false, secure: c.secure || false,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'Lax'),
    }));

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    const data = await loadData();
    data.announcements = data.announcements || {};

    const RUN_MS = 340 * 60 * 1000;
    const endAt  = Date.now() + RUN_MS;
    const TICK   = 5 * 1000;
    let lastExpRefresh = 0;
    const CATCHUP_WINDOW_MIN = 90; // если бот не успел в момент X, всё равно отправит, если прошло не больше 90 мин

    console.log(`[clan-bot] Буду работать до: ${new Date(endAt).toISOString()}`);

    while (Date.now() < endAt) {
        const now = getMsk();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const dow  = now.getDay();
        const dateKey = todayKey();

        // Раз в час обновляем опыт в памяти (без записи в Gist)
        if (Date.now() - lastExpRefresh > 60 * 60 * 1000) {
            try {
                console.log('[exp-refresh] Обновляем опыт в памяти...');
                const liveMap = await fetchAllLiveExp(page);
                const today = todayKey();
                for (const [nick, exp] of Object.entries(liveMap)) {
                    if (!data.weeklyExp[nick]) data.weeklyExp[nick] = {};
                    data.weeklyExp[nick][today] = exp;
                }
                lastExpRefresh = Date.now();
                console.log(`[exp-refresh] Обновлено ${Object.keys(liveMap).length} игроков`);
            } catch(e) {
                console.log('[exp-refresh] Ошибка:', e.message);
            }
        }

        for (const item of SCHEDULE) {
            const key = `${dateKey}_${item.type}_${item.time}`;
            const itemMin = hhmmToMinutes(item.time);
            const lateBy = nowMin - itemMin; // сколько минут прошло с момента, когда задача должна была сработать

            // Флаг "отправлено" хранится в Gist (data.announcements), а не в памяти —
            // значит переживает перезапуск GitHub Actions. Догоняем задачу, если прошло
            // не больше CATCHUP_WINDOW_MIN минут с назначенного времени и она ещё не выполнена.
            if (!data.announcements[key] && lateBy >= 0 && lateBy <= CATCHUP_WINDOW_MIN) {
                // Сразу помечаем и сохраняем в Gist ДО выполнения — чтобы параллельный
                // запуск (если такой всё же возник) не отправил то же самое дважды.
                data.announcements[key] = true;
                await saveData(data);

                console.log(`[schedule] Выполняем задачу: ${item.type} (${item.time}), опоздание: ${lateBy} мин`);

                if (item.type === 'morning') {
                    await sendAnnouncement(page, morningText());
                } else if (item.type === 'night') {
                    await sendAnnouncement(page, nightText());
                    if (dow === 5) await sendFridayReport(page, data);
                } else if (item.type === 'before_fight') {
                    await sendAnnouncement(page, beforeFightText(item.fight, item.fightTime));
                } else if (item.type === 'collect_members') {
                    await collectMembers(page, data); await saveData(data);
                } else if (item.type === 'collect_exp') {
                    await collectExp(page, data); await saveData(data);
                }

                for (const k of Object.keys(data.announcements)) {
                    if (!k.startsWith(dateKey)) delete data.announcements[k];
                }
                await saveData(data);
            }
        }

        try {
            await checkMail(page, data);
        } catch(e) {
            console.log('[mail] ОШИБКА:', e.message);
            console.log('[mail] Stack:', e.stack?.substring(0, 200));
            // Сбрасываем страницу после таймаута чтобы tickAiChat работал нормально
            try {
                console.log('[mail] Восстанавливаем страницу после ошибки...');
                await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch(e2) {
                console.log('[mail] Не удалось восстановить страницу:', e2.message);
            }
        }

        // AI-чат + форум тик (каждые 5 сек)
        try {
            await tickAiChat(page, sendClanChat, sendTitansChat, data);
        } catch(e) {
            console.log('[ai-chat] ОШИБКА в тике:', e.message);
        }
        // Одно сохранение на тик (mail + ai-chat вместе)
        await saveData(data);

        await page.waitForTimeout(TICK);
    }

    console.log('[clan-bot] Завершение нормальное.');
    await browser.close();
})().catch(err => {
    console.error('[clan-bot] Критическая ошибка:', err.message);
    console.error('[clan-bot] Stack:', err.stack);
    process.exit(1);
});
