// clan-bot.js — Монитор Клана
const { chromium } = require('playwright');
const https = require('https');

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

const SCHEDULE = [
    { time: 600,  type: 'morning' },
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

const RANK_REQUIREMENTS = {
    'Лидер клана': { expPerDay: 0,      battlesPerWeek: 30 },
    'Заместитель': { expPerDay: 0,      battlesPerWeek: 27 },
    'Генерал':     { expPerDay: 450000, battlesPerWeek: 27 },
    'Офицер':      { expPerDay: 250000, battlesPerWeek: 25 },
    'Боец':        { expPerDay: 100000, battlesPerWeek: 23 },
    'Новобранец':  { expPerDay: 70000,  battlesPerWeek: 13 },
};

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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(wait);
    console.log(`[nav] Загружено: ${page.url()}`);
}

async function pageHtml(page) {
    return page.evaluate(() => document.body.innerHTML);
}

// ── Объявление (ПРАВИЛЬНЫЙ ПУТЬ) ──────────────────────────────────────────────

async function sendAnnouncement(page, text) {
    console.log(`[announce] === Отправляем объявление ===`);
    console.log(`[announce] Текст: ${text.substring(0, 80)}...`);

    // Шаг 1: идём на страницу клана
    console.log(`[announce] Шаг 1: переходим на /clan/${CLAN_ID}/`);
    await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/`, 2000);
    const clanHtml = await pageHtml(page);

    // Шаг 2: ищем ссылку "Управление кланом"
    console.log(`[announce] Шаг 2: ищем ссылку Управление кланом...`);
    const admLinkMatch = clanHtml.match(/href="(\/clan\/\d+\/\d+\/adm\/[^"]+)"/);
    if (!admLinkMatch) {
        console.log(`[announce] ОШИБКА: ссылка Управление кланом не найдена!`);
        console.log(`[announce] HTML фрагмент (поиск adm): ${clanHtml.substring(clanHtml.indexOf('adm') - 50, clanHtml.indexOf('adm') + 100)}`);
        return;
    }
    const admUrl = BASE_URL + admLinkMatch[1];
    console.log(`[announce] Ссылка найдена: ${admUrl}`);

    // Шаг 3: переходим на страницу управления
    console.log(`[announce] Шаг 3: переходим на страницу управления...`);
    await navigate(page, admUrl, 2000);
    const admHtml = await pageHtml(page);

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

    // Шаг 5: вводим текст
    const finalText = text.substring(0, 132);
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
    return 'Я Терминал: Доброе утро! Хорошего дня! Не забывайте ходить на сражения и пополнять казну / Good morning! Have a great day! Don\'t forget battles & treasury!';
}
function nightText() {
    return 'Я Терминал: Всем доброй ночи, надеюсь вы выполнили норму! / Good night everyone, hope you\'ve completed your quota!';
}
function beforeFightText(fightName, fightTime) {
    const names = {
        'Клановый колизей': 'Клановый колизей / Clan Coliseum',
        'Клановый турнир':  'Клановый турнир / Clan Tournament',
        'Древние алтари':   'Древние алтари / Ancient Altars',
    };
    return `Я Терминал: Через 30 мин ${names[fightName]||fightName} (${fightTime}). Прошу всех явиться! / In 30 min, please attend!`;
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

    let msgText = '';
    for (const block of blocks) {
        const blockUserId = block[1];
        const blockNick = block[2].trim();
        const blockText = block[3].replace(/<[^>]+>/g, '').trim();
        console.log(`[dialog] Блок от userId=${blockUserId} (${blockNick}): "${blockText.substring(0,50)}"`);
        if (blockUserId !== BOT_USER_ID && blockText) {
            msgText = blockText.toLowerCase().trim();
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
    const reply = await processCommand(msgText, senderNick, userId, botRank, member, data, page);

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

async function processCommand(msg, senderNick, userId, botRank, member, data, page) {
    console.log(`[cmd] Команда: "${msg}" от ${senderNick}`);

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
        const text = msg.replace('/в чат от моего имени', '').trim();
        if (!text) return 'Напишите текст: /в чат от моего имени текст';
        await sendClanChat(page, `Сообщение от ${senderNick}: ${text}`);
        return 'Сообщение отправлено в чат клана.';
    }

    if (botRank >= 1) {
        if (msg.includes('/топ')) {
            console.log('[cmd] → /топ');
            // Собираем живой опыт, обновляем память, НЕ пишем в Gist
            const liveMap = await fetchAllLiveExp(page);
            const today = todayKey();
            for (const [nick, exp] of Object.entries(liveMap)) {
                if (!data.weeklyExp[nick]) data.weeklyExp[nick] = {};
                data.weeklyExp[nick][today] = exp;
            }
            // Возвращаемся на диалог
            await navigate(page, `${BASE_URL}/mail/${userId}/0/`, 2000);
            const members = Object.keys(data.members).filter(n => !data.members[n].isNew);
            const ranked = members.map(nick => {
                const exp = getPlayerWeeklyExp(nick, data);
                const req = getRequirements(data.members[nick].gameRank);
                const weeklyNorm = req.expPerDay * 7;
                const pct = weeklyNorm ? Math.round((exp / weeklyNorm) * 100) : null;
                return { nick, exp, pct };
            }).sort((a, b) => b.exp - a.exp).slice(0, 15);
            if (!ranked.length) return 'Данных пока нет.';
            const lines = ranked.map((r, i) => {
                const pctStr = r.pct !== null ? ` (${r.pct}%)` : '';
                return `${i+1}. ${r.nick} - ${r.exp.toLocaleString()}${pctStr}`;
            });
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
            const targetNick = msg.replace('/статистика', '').trim();
            if (!targetNick) return 'Укажите ник: /статистика Ник';
            const target = data.members[targetNick];
            if (!target) return `Игрок "${targetNick}" не найден в клане.`;
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
            const targetNick = msg.replace('/напомни', '').trim();
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
            const text = msg.replace('/сделай объявление', '').trim();
            if (!text) return 'Напишите текст: /сделай объявление текст';
            await sendAnnouncement(page, text);
            return 'Объявление отправлено.';
        }
        if (msg.includes('/предупреждение')) {
            console.log('[cmd] → /предупреждение');
            const targetNick = msg.replace('/предупреждение', '').trim();
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
            const targetNick = msg.replace('/повысить', '').trim();
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
            const targetNick = msg.replace('/понизить', '').trim();
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
            const targetNick = msg.replace('/бан', '').trim();
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
        const memberRegex = /href="\/(?:user|clan\/\d+\/redact)\/(\d+)\/[^"]*"[^>]*>[^<]*<img[^>]*>((?:[^<]|<span[^>]*>[^<]*<\/span>)+?),\s*<span[^>]*>(?:<span[^>]*>)?([\w\sА-Яа-яёЁ]+)/g;
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
    let t = `Ваш ранг: ${BOT_RANKS[botRank]}\nКоманды:\n/помощь\n/мой опыт за неделю\n/мои сражения за неделю\n/профиль\n/в чат от моего имени (текст)\n`;
    if (botRank >= 1) t += '/топ\n/статистика (ник)\n';
    if (botRank >= 2) t += '/кто не пришёл\n/напомни (ник)\n';
    if (botRank >= 3) t += '/сделай объявление (текст)\n/предупреждение (ник)\n';
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
    let pageNum = 1;
    while (true) {
        const url = pageNum === 1 ? `${BASE_URL}/clan/${CLAN_ID}/` : `${BASE_URL}/clan/${CLAN_ID}//${pageNum}`;
        await navigate(page, url);
        const html = await pageHtml(page);
        if (html.includes(targetNick)) {
            const allMatches = [...html.matchAll(new RegExp(`href="/clan/${CLAN_ID}/redact/(\\d+)/"[\\s\\S]{0,200}?>${targetNick.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')},`,'g'))];
            if (allMatches.length > 0) {
                const targetId = allMatches[0][1];
                console.log(`[ban] Найден userId=${targetId}`);
                await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/redact/${targetId}/`);
                const deleteLink = await page.$(`a[href*="/redact/${targetId}/delete/"]`);
                if (deleteLink) {
                    const href = await deleteLink.getAttribute('href');
                    await navigate(page, BASE_URL + href);
                    const confirmLink = await page.$(`a[href*="yes=1"]`);
                    if (confirmLink) {
                        await confirmLink.click(); await page.waitForTimeout(2000);
                        delete data.members[targetNick]; await saveData(data);
                        return `Игрок ${targetNick} исключён из клана.`;
                    }
                }
            }
        }
        const hasNext = html.includes(`/clan/${CLAN_ID}//${pageNum + 1}`);
        if (!hasNext) break;
        pageNum++;
    }
    return `Игрок "${targetNick}" не найден в клане.`;
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
    const sentToday = new Set(Object.keys(data.announcements || {}));

    const RUN_MS = 340 * 60 * 1000;
    const endAt  = Date.now() + RUN_MS;
    const TICK   = 5 * 1000;
    let lastExpRefresh = 0;

    console.log(`[clan-bot] Буду работать до: ${new Date(endAt).toISOString()}`);

    while (Date.now() < endAt) {
        const now = getMsk();
        const hhmm = now.getHours() * 100 + now.getMinutes();
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
            if (hhmm >= item.time && hhmm < item.time + 2 && !sentToday.has(key)) {
                sentToday.add(key);
                data.announcements = data.announcements || {};
                data.announcements[key] = true;
                console.log(`[schedule] Выполняем задачу: ${item.type} (${item.time})`);

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
            }
        }

        try {
            await checkMail(page, data);
        } catch(e) {
            console.log('[mail] ОШИБКА:', e.message);
            console.log('[mail] Stack:', e.stack?.substring(0, 200));
        }
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
