// clan-bot.js — Монитор Клана
// Аккаунт: Монитор Клана (18170326)
// Хранилище: GitHub Gist (JSON)

const { chromium } = require('playwright');
const https = require('https');

// ── Константы ────────────────────────────────────────────────────────────────

const BASE_URL     = 'https://tiwar.ru';
const CLAN_ID      = '41140';
const BOT_NICK     = 'Монитор Клана';
const ADMIN_NICK   = 'Kaneki';
const ADMIN_USER_ID = '23411823';
const CLAN_NAME    = 'Багровая Луна';

const GIST_ID      = process.env.GIST_ID;       // ID вашего Gist
const GIST_TOKEN   = process.env.GIST_TOKEN;    // GitHub Personal Access Token
const COOKIES_JSON = process.env.COOKIES_JSON;  // Куки Монитора Клана

// МСК = UTC+3
function getMsk() {
    const d = new Date();
    d.setMinutes(d.getMinutes() + d.getTimezoneOffset() + 180);
    return d;
}

function mskHHMM() {
    const d = getMsk();
    return d.getHours() * 100 + d.getMinutes();
}

function mskDayOfWeek() { // 0=вс,1=пн,...,5=пт,6=сб
    return getMsk().getDay();
}

function todayKey() {
    const d = getMsk();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Расписание объявлений (МСК, HHMM) ────────────────────────────────────────

const SCHEDULE = [
    { time: 600,  type: 'morning' },
    { time: 1000, type: 'before_fight', fight: 'Клановый колизей',  fightTime: '10:30' },
    { time: 1030, type: 'before_fight', fight: 'Клановый турнир',   fightTime: '11:00' },
    { time: 1430, type: 'before_fight', fight: 'Клановый колизей',  fightTime: '15:00' },
    { time: 1330, type: 'before_fight', fight: 'Древние алтари',    fightTime: '14:00' },
    { time: 1830, type: 'before_fight', fight: 'Клановый турнир',   fightTime: '19:00' },
    { time: 2030, type: 'before_fight', fight: 'Древние алтари',    fightTime: '21:00' },
    { time: 2330, type: 'night' },
    { time: 2335, type: 'collect_members' }, // собираем ники и звания
    { time: 2350, type: 'collect_exp' },     // собираем опыт
];

// ── Требования по рангам (игровым) ───────────────────────────────────────────

const RANK_REQUIREMENTS = {
    'Лидер клана': { expPerDay: 0,      battlesPerWeek: 30, label: 'Лидер' },
    'Заместитель': { expPerDay: 0,      battlesPerWeek: 27, label: 'Заместитель' },
    'Генерал':     { expPerDay: 450000, battlesPerWeek: 27, label: 'Генерал' },
    'Офицер':      { expPerDay: 250000, battlesPerWeek: 25, label: 'Офицер' },
    'Боец':        { expPerDay: 100000, battlesPerWeek: 23, label: 'Боец' },
    'Новобранец':  { expPerDay: 70000,  battlesPerWeek: 13, label: 'Новобранец' },
};

const TOTAL_BATTLES_PER_WEEK = 42; // 6 сражений в день × 7 дней

// ── Ранги бота ────────────────────────────────────────────────────────────────

const BOT_RANKS = {
    0: 'Участник',
    1: 'Ветеран',
    2: 'Страж',
    3: 'Доверенное лицо',
    4: 'Верхушка',
};

// ── GitHub Gist API ───────────────────────────────────────────────────────────

async function gistRequest(method, data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/gists/${GIST_ID}`,
            method,
            headers: {
                'Authorization': `token ${GIST_TOKEN}`,
                'User-Agent': 'tiwar-clan-bot',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            }
        };
        const req = https.request(options, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch(e) { resolve({}); }
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function loadData() {
    const defaults = {
        members: {},
        weeklyExp: {},
        weeklyBattles: {},
        announcements: {},
        botRanks: {},
    };
    try {
        const gist = await gistRequest('GET');
        const raw = gist.files?.['data.json']?.content;
        if (raw) {
            const parsed = JSON.parse(raw);
            const merged = { ...defaults, ...parsed };
            merged.botRanks = { ...(parsed.botRanks || {}) };
            merged.botRanks[ADMIN_NICK] = 4;
            return merged;
        }
    } catch(e) {
        console.log('[gist] Ошибка загрузки:', e.message);
    }
    defaults.botRanks[ADMIN_NICK] = 4;
    return defaults;
}

async function saveData(data) {
    try {
        if (!data.botRanks) data.botRanks = {};
        data.botRanks[ADMIN_NICK] = 4; // всегда фиксируем
        await gistRequest('PATCH', {
            files: { 'data.json': { content: JSON.stringify(data, null, 2) } }
        });
        console.log('[gist] Данные сохранены');
    } catch(e) {
        console.log('[gist] Ошибка сохранения:', e.message);
    }
}

// ── Playwright helpers ────────────────────────────────────────────────────────

async function navigate(page, url, wait = 2000) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(wait);
}

async function pageText(page) {
    return page.evaluate(() => document.body.innerHTML);
}

// ── Парсинг членов клана (ники + звания) ─────────────────────────────────────

async function collectMembers(page, data) {
    console.log('[members] Собираем список членов клана...');
    const members = {};
    let pageNum = 1;

    while (true) {
        const url = pageNum === 1
            ? `${BASE_URL}/clan/${CLAN_ID}/`
            : `${BASE_URL}/clan/${CLAN_ID}//${pageNum}`;
        await navigate(page, url);
        const html = await pageText(page);

        // Парсим игроков: ник, userId, звание
        const memberRegex = /href="\/(?:user|clan\/\d+\/redact)\/(\d+)\/"[^>]*>.*?alt="">([\w\s\-А-Яа-яёЁ]+),\s*<span[^>]*>(?:<span[^>]*>)?([\w\sА-Яа-яёЁ]+)/g;
        let match;
        let found = 0;
        while ((match = memberRegex.exec(html)) !== null) {
            const userId = match[1];
            const nick   = match[2].trim();
            const rank   = match[3].trim();
            if (nick === BOT_NICK) continue;
            members[nick] = { userId, gameRank: rank };
            found++;
        }

        // Проверяем есть ли следующая страница
        const hasNext = html.includes(`/clan/${CLAN_ID}//${pageNum + 1}`);
        if (!hasNext || found === 0) break;
        pageNum++;
    }

    console.log(`[members] Найдено ${Object.keys(members).length} игроков`);

    const today = todayKey();
    for (const [nick, info] of Object.entries(members)) {
        if (!data.members[nick]) {
            // Новый игрок — начинаем отслеживать со следующей недели
            data.members[nick] = {
                userId: info.userId,
                gameRank: info.gameRank,
                botRank: data.botRanks[nick] ?? 0,
                joinedTracking: today,
                isNew: true,
            };
            console.log(`[members] Новый игрок: ${nick} (${info.gameRank})`);
        } else {
            // Обновляем звание и userId
            data.members[nick].gameRank = info.gameRank;
            data.members[nick].userId   = info.userId;
            data.members[nick].isNew    = false;
        }
    }

    // Убираем выбывших
    for (const nick of Object.keys(data.members)) {
        if (!members[nick]) {
            console.log(`[members] Игрок покинул клан: ${nick}`);
            delete data.members[nick];
        }
    }
}

// ── Парсинг кланового опыта за сегодня ───────────────────────────────────────

async function collectExp(page, data) {
    console.log('[exp] Собираем опыт за сегодня...');
    const today = todayKey();
    let pageNum = 1;

    while (true) {
        const url = pageNum === 1
            ? `${BASE_URL}/clan/${CLAN_ID}/clanexp/today`
            : `${BASE_URL}/clan/${CLAN_ID}/clanexp/today/${pageNum}`;
        await navigate(page, url);
        const html = await pageText(page);

        // <a href="/user/USERID/">NICK</a> <b>EXP</b>
        const expRegex = /href="\/user\/(\d+)\/">([\w\s\-А-Яа-яёЁ']+)<\/a>\s*<b>([\d\s']+)<\/b>/g;
        let match;
        let found = 0;
        while ((match = expRegex.exec(html)) !== null) {
            const nick = match[2].trim();
            const exp  = parseInt(match[3].replace(/[\s']/g, ''), 10);
            if (nick === BOT_NICK) continue;
            if (!data.members[nick] || data.members[nick].isNew) continue;

            if (!data.weeklyExp[nick]) data.weeklyExp[nick] = {};
            data.weeklyExp[nick][today] = exp;
            found++;
        }

        const hasNext = html.includes(`/clanexp/today/${pageNum + 1}`);
        if (!hasNext || found === 0) break;
        pageNum++;
    }

    console.log('[exp] Опыт собран');
}

// ── Подсчёт статистики игрока ─────────────────────────────────────────────────

function getWeekDates() {
    const dates = [];
    const now = getMsk();
    // Неделя — последние 7 дней
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
    return dates;
}

function getPlayerWeeklyExp(nick, data) {
    const dates = getWeekDates();
    const expByDay = data.weeklyExp[nick] || {};
    let total = 0;
    for (const d of dates) {
        total += expByDay[d] || 0;
    }
    return total;
}

function getPlayerWeeklyBattles(nick, data) {
    return data.weeklyBattles[nick]?.total || 0;
}

function getRequirements(gameRank) {
    return RANK_REQUIREMENTS[gameRank] || RANK_REQUIREMENTS['Новобранец'];
}

function getExpNormPercent(nick, data) {
    const member = data.members[nick];
    if (!member) return null;
    const req = getRequirements(member.gameRank);
    if (!req.expPerDay) return 100; // лидер/зам — без лимита
    const weeklyNorm = req.expPerDay * 7;
    const exp = getPlayerWeeklyExp(nick, data);
    return Math.round((exp / weeklyNorm) * 100);
}

function getBattleNormPercent(nick, data) {
    const member = data.members[nick];
    if (!member) return null;
    const req = getRequirements(member.gameRank);
    const battles = getPlayerWeeklyBattles(nick, data);
    return Math.round((battles / req.battlesPerWeek) * 100);
}

// ── Отправка объявления ───────────────────────────────────────────────────────

async function sendAnnouncement(page, text) {
    console.log(`[announce] Отправляем: ${text}`);
    await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/1/adm/?r=149897`);
    const input = await page.$('input[name="text"]');
    if (!input) { console.log('[announce] Поле ввода не найдено!'); return; }
    await input.fill(text.substring(0, 132));
    await input.press('Enter');
    await page.waitForTimeout(2000);
    console.log('[announce] Объявление отправлено');
}

// ── Текст объявлений ─────────────────────────────────────────────────────────

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
    const fn = names[fightName] || fightName;
    return `Я Терминал: Через 30 мин ${fn} (${fightTime}). Прошу всех явиться по возможности! / In 30 min ${fn}. Please attend if possible!`;
}

// ── Отправка личного сообщения ────────────────────────────────────────────────

async function sendMail(page, userId, text) {
    console.log(`[mail] Пишем userId=${userId}: ${text.substring(0,50)}...`);
    await navigate(page, `${BASE_URL}/mail/${userId}/`);
    const textarea = await page.$('textarea[name="text"]');
    if (!textarea) { console.log('[mail] Поле ввода не найдено!'); return false; }
    await textarea.fill(text);
    const sendBtn = await page.$('input[name="send_message"]');
    if (sendBtn) await sendBtn.click();
    await page.waitForTimeout(2000);
    return true;
}

// ── Чтение почты и обработка команд ──────────────────────────────────────────

async function checkMail(page, data) {
    await navigate(page, BASE_URL);
    const html = await pageText(page);

    // Проверяем есть ли новая почта
    if (!html.includes('Новая почта') && !html.includes('/mail/')) return;

    await navigate(page, `${BASE_URL}/mail/`);
    const mailHtml = await pageText(page);

    // Ищем диалоги с новыми сообщениями (dgreen +N)
    const newMailRegex = /href="\/mail\/(\d+)\/\d+\/"[^>]*>.*?dgreen">\+(\d+)/gs;
    let match;
    const toProcess = [];

    while ((match = newMailRegex.exec(mailHtml)) !== null) {
        toProcess.push({ userId: match[1], count: parseInt(match[2]) });
    }

    if (toProcess.length === 0) return;

    console.log(`[mail] Новых диалогов: ${toProcess.length}`);

    for (const { userId } of toProcess) {
        await navigate(page, `${BASE_URL}/mail/${userId}/0/`);
        const convHtml = await pageText(page);

        // Определяем ник отправителя
        const nickMatch = convHtml.match(/class="yellow">([\w\s\-А-Яа-яёЁ']+)<\/span>/);
        if (!nickMatch) continue;
        const senderNick = nickMatch[1].trim();

        // Последнее входящее сообщение
        const msgMatch = convHtml.match(/class="white">([\s\S]*?)<\/span>/);
        if (!msgMatch) continue;
        const msgText = msgMatch[1].trim().toLowerCase();

        // Проверяем — из нашего клана?
        const isOurClan = await checkUserClan(page, userId);
        await navigate(page, `${BASE_URL}/mail/${userId}/0/`);

        if (!isOurClan) {
            await sendMailReply(page, userId, 'Ты кто? / Who are you?');
            continue;
        }

        // Получаем бот-ранг
        const botRank = data.botRanks[senderNick] ?? 0;
        const member  = data.members[senderNick];

        // Обрабатываем команду
        const reply = await processCommand(msgText, senderNick, userId, botRank, member, data, page);
        if (reply) {
            await sendMailReply(page, userId, reply);
        }

        // Возвращаемся в почту
        await navigate(page, `${BASE_URL}/mail/`);
    }
}

async function checkUserClan(page, userId) {
    await navigate(page, `${BASE_URL}/user/${userId}/`, 1500);
    const html = await pageText(page);
    return html.includes(CLAN_NAME);
}

async function sendMailReply(page, userId, text) {
    const textarea = await page.$('textarea[name="text"]');
    if (!textarea) {
        await navigate(page, `${BASE_URL}/mail/${userId}/0/`);
        const ta = await page.$('textarea[name="text"]');
        if (!ta) return;
        await ta.fill(text);
    } else {
        await textarea.fill(text);
    }
    const sendBtn = await page.$('input[name="send_message"]');
    if (sendBtn) await sendBtn.click();
    await page.waitForTimeout(2000);
}

// ── Обработка команд ──────────────────────────────────────────────────────────

async function processCommand(msg, senderNick, userId, botRank, member, data, page) {
    // /помощь
    if (msg.includes('/помощь')) {
        return buildHelpText(botRank);
    }

    // /мой опыт за неделю
    if (msg.includes('/мой опыт')) {
        if (!member) return 'Вы не найдены в базе данных клана.';
        const exp = getPlayerWeeklyExp(senderNick, data);
        const pct = getExpNormPercent(senderNick, data);
        const req = getRequirements(member.gameRank);
        const weeklyNorm = req.expPerDay * 7;
        const left = Math.max(0, weeklyNorm - exp);
        return `📊 Ваш опыт за неделю: ${exp.toLocaleString()}\n` +
               `Норма (${member.gameRank}): ${weeklyNorm.toLocaleString()}\n` +
               `Выполнено: ${pct}%\n` +
               (left > 0 ? `Осталось набрать: ${left.toLocaleString()}` : '✅ Норма выполнена!');
    }

    // /мои сражения за неделю
    if (msg.includes('/мои сражения')) {
        if (!member) return 'Вы не найдены в базе данных клана.';
        const battles = getPlayerWeeklyBattles(senderNick, data);
        const pct = getBattleNormPercent(senderNick, data);
        const req = getRequirements(member.gameRank);
        const left = Math.max(0, req.battlesPerWeek - battles);
        return `⚔️ Ваши сражения за неделю: ${battles}/${req.battlesPerWeek}\n` +
               `Выполнено: ${pct}%\n` +
               (left > 0 ? `Осталось боёв: ${left}` : '✅ Норма выполнена!');
    }

    // /профиль
    if (msg.includes('/профиль')) {
        if (!member) return 'Вы не найдены в базе данных клана.';
        const topList = getTopList(data);
        const pos = topList.findIndex(n => n === senderNick) + 1;
        return `👤 ${senderNick}\n` +
               `Игровой ранг: ${member.gameRank}\n` +
               `Ранг в боте: ${BOT_RANKS[botRank]}\n` +
               `Позиция в топе клана: #${pos > 0 ? pos : '?'}`;
    }

    // /в чат от моего имени (текст)
    if (msg.includes('/в чат от моего имени')) {
        const text = msg.replace('/в чат от моего имени', '').trim();
        if (!text) return 'Напишите текст после команды /в чат от моего имени';
        await sendClanChat(page, `Сообщение от ${senderNick}: ${text}`);
        return '✅ Сообщение отправлено в чат клана.';
    }

    // ── Ранг 1+ ──────────────────────────────────────────────────────────────

    if (botRank >= 1) {
        if (msg.includes('/топ')) {
            return buildTopText(data);
        }
        if (msg.includes('/статистика')) {
            const targetNick = msg.replace('/статистика', '').trim();
            if (!targetNick) return 'Укажите ник: /статистика Ник';
            const target = data.members[targetNick];
            if (!target) return `Игрок "${targetNick}" не найден в клане.`;
            const exp = getPlayerWeeklyExp(targetNick, data);
            const battles = getPlayerWeeklyBattles(targetNick, data);
            const expPct = getExpNormPercent(targetNick, data);
            const battlePct = getBattleNormPercent(targetNick, data);
            return `📊 ${targetNick} (${target.gameRank})\n` +
                   `Опыт за неделю: ${exp.toLocaleString()} (${expPct}%)\n` +
                   `Сражения: ${battles} (${battlePct}%)`;
        }
    }

    // ── Ранг 2+ ──────────────────────────────────────────────────────────────

    if (botRank >= 2) {
        if (msg.includes('/кто не пришёл')) {
            return buildMissingText(data);
        }
        if (msg.includes('/напомни')) {
            const targetNick = msg.replace('/напомни', '').trim();
            const target = data.members[targetNick];
            if (!target) return `Игрок "${targetNick}" не найден.`;
            const exp = getPlayerWeeklyExp(targetNick, data);
            const battles = getPlayerWeeklyBattles(targetNick, data);
            const req = getRequirements(target.gameRank);
            const reminderText = `Привет! Напоминание о норме клана:\n` +
                `Опыт за неделю: ${exp.toLocaleString()} / ${(req.expPerDay*7).toLocaleString()}\n` +
                `Сражения: ${battles} / ${req.battlesPerWeek}\n` +
                `Постарайся выполнить норму до конца недели! 💪`;
            await sendMail(page, target.userId, reminderText);
            return `✅ Напоминание отправлено игроку ${targetNick}.`;
        }
    }

    // ── Ранг 3+ ──────────────────────────────────────────────────────────────

    if (botRank >= 3) {
        if (msg.includes('/сделай объявление')) {
            const text = msg.replace('/сделай объявление', '').trim();
            if (!text) return 'Напишите текст: /сделай объявление текст';
            await sendAnnouncement(page, text);
            return '✅ Объявление отправлено.';
        }
        if (msg.includes('/предупреждение')) {
            const targetNick = msg.replace('/предупреждение', '').trim();
            const target = data.members[targetNick];
            if (!target) return `Игрок "${targetNick}" не найден.`;
            const warnText = `⚠️ Официальное предупреждение!\n` +
                `Вы не выполняете нормы активности клана.\n` +
                `Опыт: ${getPlayerWeeklyExp(targetNick, data).toLocaleString()}\n` +
                `Сражения: ${getPlayerWeeklyBattles(targetNick, data)}\n` +
                `Пожалуйста, повысьте активность, иначе вас могут исключить.`;
            await sendMail(page, target.userId, warnText);
            return `✅ Предупреждение отправлено ${targetNick}.`;
        }
    }

    // ── Ранг 4 (Верхушка) ────────────────────────────────────────────────────

    if (botRank >= 4) {
        if (msg.includes('/повысить')) {
            const targetNick = msg.replace('/повысить', '').trim();
            if (!data.members[targetNick]) return `Игрок "${targetNick}" не найден.`;
            const cur = data.botRanks[targetNick] ?? 0;
            if (cur >= 3) return `${targetNick} уже имеет максимальный ранг (${BOT_RANKS[cur]}).`;
            data.botRanks[targetNick] = cur + 1;
            await saveData(data);
            await sendMail(page, data.members[targetNick].userId,
                `🎉 Ваш ранг в боте повышен до "${BOT_RANKS[cur+1]}"! Вы заслужили. Напишите /профиль чтобы посмотреть текущий ранг.`);
            return `✅ ${targetNick} повышен до ранга "${BOT_RANKS[cur+1]}".`;
        }

        if (msg.includes('/понизить')) {
            const targetNick = msg.replace('/понизить', '').trim();
            if (!data.members[targetNick]) return `Игрок "${targetNick}" не найден.`;
            if (targetNick === ADMIN_NICK) return 'Нельзя понизить Верхушку.';
            const cur = data.botRanks[targetNick] ?? 0;
            if (cur <= 0) return `${targetNick} уже на минимальном ранге.`;
            data.botRanks[targetNick] = cur - 1;
            await saveData(data);
            return `✅ ${targetNick} понижен до ранга "${BOT_RANKS[cur-1]}".`;
        }

        if (msg.includes('/отчёт')) {
            return buildWeeklyReport(data);
        }

        if (msg.includes('/бан')) {
            const targetNick = msg.replace('/бан', '').trim();
            const result = await banPlayer(page, targetNick, data);
            return result;
        }
    }

    return null; // неизвестная команда — не отвечаем
}

// ── Чат клана ─────────────────────────────────────────────────────────────────

async function sendClanChat(page, text) {
    await navigate(page, `${BASE_URL}/chat/clan/`);
    const input = await page.$('input[type="text"], textarea');
    if (!input) return;
    await input.fill(text);
    await input.press('Enter');
    await page.waitForTimeout(1500);
}

// ── Топ по опыту ─────────────────────────────────────────────────────────────

function getTopList(data) {
    return Object.keys(data.members)
        .filter(n => !data.members[n].isNew)
        .sort((a, b) => getPlayerWeeklyExp(b, data) - getPlayerWeeklyExp(a, data));
}

function buildTopText(data) {
    const top = getTopList(data).slice(0, 10);
    if (top.length === 0) return 'Данных пока нет.';
    let text = '🏆 Топ клана по опыту за неделю:\n';
    top.forEach((nick, i) => {
        const exp = getPlayerWeeklyExp(nick, data);
        text += `${i+1}. ${nick} — ${exp.toLocaleString()}\n`;
    });
    return text;
}

// ── Кто не пришёл на последнее сражение ──────────────────────────────────────

function buildMissingText(data) {
    // Используем данные о сражениях (когда будет реализовано)
    const today = todayKey();
    const missing = [];
    for (const [nick, member] of Object.entries(data.members)) {
        if (member.isNew) continue;
        const battles = data.weeklyBattles[nick];
        if (!battles?.dates?.includes(today)) {
            missing.push(nick);
        }
    }
    if (missing.length === 0) return '✅ Все члены клана присутствовали на последнем сражении!';
    return `❌ Не пришли на последнее сражение:\n${missing.join(', ')}`;
}

// ── Помощь по рангу ───────────────────────────────────────────────────────────

function buildHelpText(botRank) {
    let text = `📋 Ваш ранг: ${BOT_RANKS[botRank]}\nДоступные команды:\n`;
    text += '/помощь — список команд\n';
    text += '/мой опыт за неделю\n';
    text += '/мои сражения за неделю\n';
    text += '/профиль\n';
    text += '/в чат от моего имени (текст)\n';
    if (botRank >= 1) {
        text += '/топ — топ клана по опыту\n';
        text += '/статистика (ник) — статистика игрока\n';
    }
    if (botRank >= 2) {
        text += '/кто не пришёл\n';
        text += '/напомни (ник)\n';
    }
    if (botRank >= 3) {
        text += '/сделай объявление (текст)\n';
        text += '/предупреждение (ник)\n';
    }
    if (botRank >= 4) {
        text += '/повысить (ник)\n';
        text += '/понизить (ник)\n';
        text += '/бан (ник)\n';
        text += '/отчёт — недельный отчёт\n';
    }
    return text;
}

// ── Недельный отчёт (пятница) ────────────────────────────────────────────────

function buildWeeklyReport(data) {
    const fulfilled = [];
    const notFulfilled = [];

    for (const [nick, member] of Object.entries(data.members)) {
        if (member.isNew) continue;
        const req = getRequirements(member.gameRank);
        const exp = getPlayerWeeklyExp(nick, data);
        const battles = getPlayerWeeklyBattles(nick, data);
        const weeklyNorm = req.expPerDay * 7;
        const expOk = !req.expPerDay || exp >= weeklyNorm;
        const battleOk = battles >= req.battlesPerWeek;

        if (expOk && battleOk) {
            const expOver = req.expPerDay ? exp - weeklyNorm : null;
            const batOver = battles - req.battlesPerWeek;
            let note = [];
            if (expOver !== null && expOver > 0) note.push(`+${expOver.toLocaleString()} опыта`);
            if (batOver > 0) note.push(`+${batOver} боёв`);
            fulfilled.push(`${nick} (${note.join(', ') || 'норма'})`);
        } else {
            let lacks = [];
            if (req.expPerDay && exp < weeklyNorm) lacks.push(`не хватает ${(weeklyNorm-exp).toLocaleString()} опыта`);
            if (battles < req.battlesPerWeek) lacks.push(`не хватает ${req.battlesPerWeek-battles} боёв`);
            notFulfilled.push(`${nick}: ${lacks.join(', ')}`);
        }
    }

    let report = '📊 НЕДЕЛЬНЫЙ ОТЧЁТ КЛАНА\n\n';
    report += `✅ Выполнили норму (${fulfilled.length}):\n`;
    report += fulfilled.length ? fulfilled.join('\n') : 'Никто';
    report += `\n\n❌ Не выполнили норму (${notFulfilled.length}):\n`;
    report += notFulfilled.length ? notFulfilled.join('\n') : 'Все молодцы!';
    return report;
}

// ── Пятничный отчёт в объявления ─────────────────────────────────────────────

async function sendFridayReport(page, data) {
    console.log('[report] Отправляем пятничный отчёт...');
    const report = buildWeeklyReport(data);
    // Разбиваем на части по 132 символа
    const parts = [];
    const lines = report.split('\n');
    let chunk = '';
    for (const line of lines) {
        if ((chunk + line).length > 128) {
            if (chunk) parts.push(chunk.trim());
            chunk = line + '\n';
        } else {
            chunk += line + '\n';
        }
    }
    if (chunk.trim()) parts.push(chunk.trim());

    for (const part of parts) {
        await sendAnnouncement(page, part);
        await page.waitForTimeout(3000);
    }

    // Сбрасываем счётчики для новой недели
    data.weeklyExp = {};
    data.weeklyBattles = {};
    for (const nick of Object.keys(data.members)) {
        data.members[nick].isNew = false;
    }
    await saveData(data);
}

// ── Исключение из клана ───────────────────────────────────────────────────────

async function banPlayer(page, targetNick, data) {
    console.log(`[ban] Исключаем: ${targetNick}`);
    let pageNum = 1;
    let found = false;

    while (!found) {
        const url = pageNum === 1
            ? `${BASE_URL}/clan/${CLAN_ID}/`
            : `${BASE_URL}/clan/${CLAN_ID}//${pageNum}`;
        await navigate(page, url);
        const html = await pageText(page);

        if (html.includes(targetNick)) {
            // Ищем userId по нику
            const re = new RegExp(`href="/clan/${CLAN_ID}/redact/(\\d+)/"[^>]*>[^>]*>([^,]+),`);
            const match = re.exec(html);
            if (match) {
                const targetId = match[1];
                // Переходим на страницу исключения
                await navigate(page, `${BASE_URL}/clan/${CLAN_ID}/redact/${targetId}/`);
                const deleteBtn = await page.$(`a[href*="/redact/${targetId}/delete/"]`);
                if (deleteBtn) {
                    const href = await deleteBtn.getAttribute('href');
                    await navigate(page, BASE_URL + href);
                    const confirmLink = await page.$(`a[href*="yes=1"]`);
                    if (confirmLink) {
                        await confirmLink.click();
                        await page.waitForTimeout(2000);
                        delete data.members[targetNick];
                        await saveData(data);
                        found = true;
                        return `✅ Игрок ${targetNick} исключён из клана.`;
                    }
                }
            }
        }

        const hasNext = html.includes(`/clan/${CLAN_ID}//${pageNum + 1}`);
        if (!hasNext) break;
        pageNum++;
    }

    return `❌ Игрок "${targetNick}" не найден в клане.`;
}

// ── Основной цикл ─────────────────────────────────────────────────────────────

(async () => {
    console.log('[clan-bot] Запуск:', new Date().toISOString());

    if (!GIST_ID || !GIST_TOKEN) {
        console.error('[clan-bot] Не заданы GIST_ID или GIST_TOKEN!');
        process.exit(1);
    }

    const rawCookies = JSON.parse(COOKIES_JSON);
    const cookies = rawCookies.map(c => ({
        name: c.name, value: c.value,
        domain: c.domain || 'tiwar.ru', path: c.path || '/',
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
    page.on('console', msg => console.log('[page]', msg.text()));

    const data = await loadData();
    const sentToday = new Set(Object.keys(data.announcements || {}));

    const RUN_MS = 340 * 60 * 1000;
    const endAt  = Date.now() + RUN_MS;
    const TICK   = 5 * 1000; // проверяем каждые 5 секунд

    while (Date.now() < endAt) {
        const now = getMsk();
        const hhmm = now.getHours() * 100 + now.getMinutes();
        const dow  = now.getDay(); // 5 = пятница
        const dateKey = todayKey();

        // ── Расписание объявлений ─────────────────────────────────────────────
        for (const item of SCHEDULE) {
            const key = `${dateKey}_${item.type}_${item.time}`;
            if (hhmm >= item.time && hhmm < item.time + 2 && !sentToday.has(key)) {
                sentToday.add(key);
                data.announcements = data.announcements || {};
                data.announcements[key] = true;

                if (item.type === 'morning') {
                    await sendAnnouncement(page, morningText());
                } else if (item.type === 'night') {
                    await sendAnnouncement(page, nightText());
                    // Пятничный отчёт
                    if (dow === 5) await sendFridayReport(page, data);
                } else if (item.type === 'before_fight') {
                    await sendAnnouncement(page, beforeFightText(item.fight, item.fightTime));
                } else if (item.type === 'collect_members') {
                    await collectMembers(page, data);
                    await saveData(data);
                } else if (item.type === 'collect_exp') {
                    await collectExp(page, data);
                    await saveData(data);
                }

                // Чистим старые ключи (старше 2 дней)
                for (const k of Object.keys(data.announcements)) {
                    if (!k.startsWith(dateKey)) delete data.announcements[k];
                }
            }
        }

        // ── Проверка почты каждые 5 минут ────────────────────────────────────
        const mailKey = `${dateKey}_mail_${Math.floor(Date.now() / 5000)}`;
        if (!sentToday.has(mailKey)) {
            sentToday.add(mailKey);
            await checkMail(page, data);
            await saveData(data);
        }

        await page.waitForTimeout(TICK);
    }

    console.log('[clan-bot] Завершение.');
    await browser.close();
})().catch(err => {
    console.error('[clan-bot] Критическая ошибка:', err);
    process.exit(1);
});
