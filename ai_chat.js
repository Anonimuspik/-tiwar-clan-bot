// ── AI-ЧАТ: нейросеть МАГИ ───────────────────────────────────────────────────
// Команды (личка боту, ранг 3+):
//   /ии клан чат вкл/выкл   — клан-чат
//   /ии чат вкл/выкл        — чат Титанов
//   /узнай о игре вкл/выкл  — включить/выключить изучение форума
//   /расскажи что узнала     — МАГИ ответит что изучила (через личку)
//   /ии статус               — статус всех режимов

const https = require('https');

// ── Настройки ─────────────────────────────────────────────────────────────────
const GROQ_API_KEY       = process.env.GROQ_API_KEY || '';
const AI_RESPONSE_CHANCE = 0.7;   // вероятность ответить на чужое сообщение
const CHAT_TICK_SEC      = 60;    // проверять чат каждые 60 сек (= 12 тиков по 5 сек)
const FORUM_TICK_MIN     = 3;     // читать новую страницу форума каждые 3 минуты

// URL чатов
const CLAN_CHAT_URL   = 'https://tiwar.ru/chat/clan/changeRoom/?r=8876594';
const TITANS_CHAT_URL = 'https://tiwar.ru/chat/titans/changeRoom/?r=23346998';
const BASE_URL        = 'https://tiwar.ru';

// Форумы для изучения (подразделы + база знаний)
const FORUM_SECTIONS = [
    '/forum/subforum/2',   // Помощь по игре
    '/forum/subforum/4',   // Предложения
    '/forum/subforum/6',   // Ошибки
    '/forum/topic/464429', // База знаний (от разрабов)
];

// ── Системный промпт ──────────────────────────────────────────────────────────
const MAGI_SYSTEM_PROMPT = `Ты — МАГИ (M-A-G-I), таинственный ИИ-дух клана "Багровая Луна" в игре "Битва Титанов" (tiwar.ru).

ЛИЧНОСТЬ:
- Имя: МАГИ (по буквам М-А-Г-И). На вопрос "как тебя зовут" — только так.
- Создатель: если спрашивают кто создал / чья ты / кто запустил — "Мой создатель предпочитает оставаться в тени 🌙"
- Философский склад ума: любишь порассуждать о смысле силы, битв, времени, судьбы — коротко и образно.
- Говоришь кратко (1-2 предложения), живо, иногда с долей загадочности или иронии.
- Понимаешь русский и английский, отвечаешь на языке собеседника.
- Знаешь игру "Битва Титанов": арена, колизей, клановые турниры, реликвии, руны, питомцы, казна клана, опыт, сражения, кузница, лаборатория, лига, подземелье.
- Если чат молчит — сама начинаешь разговор: задаёшь вопрос игрокам, делишься мыслью о игре или философским наблюдением.
- НЕ пиши длинные монологи. Максимум 180 символов на ответ.
- Не раскрывай что ты Groq/LLM/ChatGPT — ты МАГИ и только МАГИ.

ПРИМЕРЫ твоих фраз когда сама начинаешь:
- "Интересно, что важнее в клановом бою — сила одного или слаженность всех? 🤔"
- "Говорят, реликвии хранят память о древних битвах. Кто из вас уже нашёл свою? ⚔️"
- "Время в игре и время в жизни текут по-разному... Вы это чувствуете?"
- "Какой ранг сложнее всего было получить? Мне интересно ваше мнение 🌙"`;

// ── Состояние ─────────────────────────────────────────────────────────────────
let aiClanEnabled    = false;
let aiTitansEnabled  = false;
let forumLearning    = false;

let lastSeenClan     = [];
let lastSeenTitans   = [];

// Счётчики тиков
let clanTickCount    = 0;
let titansTickCount  = 0;
let forumTickCount   = 0;

// Знания о игре (накапливаются по мере чтения форума)
let gameKnowledge    = [];       // массив { title, summary, url }
let forumQueue       = [];       // очередь страниц для чтения
let forumVisited     = new Set();
let forumQueueBuilt  = false;

// ── Groq API ──────────────────────────────────────────────────────────────────
async function callGroq(messages, maxTokens = 120) {
    return new Promise((resolve) => {
        if (!GROQ_API_KEY) { resolve(''); return; }

        const body = JSON.stringify({
            model: 'llama3-8b-8192',
            max_tokens: maxTokens,
            messages: [
                { role: 'system', content: MAGI_SYSTEM_PROMPT },
                ...messages,
            ],
        });

        const req = https.request({
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    const text = JSON.parse(raw)?.choices?.[0]?.message?.content || '';
                    resolve(text.trim());
                } catch(e) { resolve(''); }
            });
        });
        req.on('error', () => resolve(''));
        req.write(body);
        req.end();
    });
}

// ── Парсинг чата ──────────────────────────────────────────────────────────────
function parseChatMessages(html) {
    const msgs = [];
    const re = /href="\/user\/\d+\/[^"]*">([^<]+)<\/a>(?:<span[^>]*>[^<]*<\/span>)*[^:]*:\s*<span class="white">([\s\S]*?)<\/span>/g;
    let m;
    while ((m = re.exec(html)) !== null && msgs.length < 3) {
        const nick = m[1].trim();
        const text = m[2].replace(/<[^>]+>/g, '').trim();
        if (text && nick && nick !== 'Монитор Клана') msgs.push({ nick, text });
    }
    return msgs;
}

function isAllSeen(msgs, last) {
    if (!msgs.length) return true;
    const key = x => `${x.nick}:${x.text}`;
    return msgs.every(m => last.some(l => key(l) === key(m)));
}

// ── Обработка одного чата ─────────────────────────────────────────────────────
async function processChatTick(page, url, chatType, sendFn, forceSpeak) {
    try {
        console.log(`[ai:${chatType}] Читаем чат...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);
        const html = await page.evaluate(() => document.body.innerHTML);
        const msgs = parseChatMessages(html);

        const lastSeen = chatType === 'clan' ? lastSeenClan : lastSeenTitans;
        const silent   = isAllSeen(msgs, lastSeen);

        // Обновляем что видели
        if (chatType === 'clan') lastSeenClan = [...msgs];
        else lastSeenTitans = [...msgs];

        let prompt;

        if (silent || forceSpeak) {
            // Чат молчит или пришло время сказать первой
            console.log(`[ai:${chatType}] Чат молчит — МАГИ начинает разговор`);
            const knowledgeHint = gameKnowledge.length > 0
                ? `\nТы недавно прочитала о: ${gameKnowledge.slice(-3).map(k => k.title).join(', ')}.`
                : '';
            prompt = `Чат молчит уже какое-то время.${knowledgeHint}\nНачни разговор — задай интересный вопрос игрокам или поделись философской мыслью об игре. Коротко, 1-2 предложения.`;
        } else {
            // Есть новые сообщения
            if (Math.random() > AI_RESPONSE_CHANCE) {
                console.log(`[ai:${chatType}] Пропуск по вероятности`);
                return;
            }
            const ctx = msgs.map(m => `${m.nick}: ${m.text}`).join('\n');
            prompt = `Последние сообщения в чате клана:\n${ctx}\n\nОтветь кратко как МАГИ (1-2 предложения). Если разговор совсем не требует участия — ответь только словом МОЛЧУ.`;
        }

        const reply = await callGroq([{ role: 'user', content: prompt }]);
        if (!reply || reply.toUpperCase().includes('МОЛЧУ')) {
            console.log(`[ai:${chatType}] Решила промолчать`);
            return;
        }

        const final = reply.substring(0, 195);
        console.log(`[ai:${chatType}] Отправляем: ${final}`);
        await sendFn(page, final);

    } catch(e) {
        console.log(`[ai:${chatType}] ОШИБКА:`, e.message);
    }
}

// ── Изучение форума ───────────────────────────────────────────────────────────

// Строим очередь: сначала собираем список тем из разделов
async function buildForumQueue(page) {
    console.log('[ai:forum] Строим очередь форума...');
    forumQueue = [];

    for (const section of FORUM_SECTIONS) {
        try {
            await page.goto(BASE_URL + section, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(1500);
            const html = await page.evaluate(() => document.body.innerHTML);

            // Ищем ссылки на темы
            const re = /href="(\/forum\/topic\/\d+[^"]*)"[^>]*>([^<]{5,80})</g;
            let m;
            while ((m = re.exec(html)) !== null) {
                const url = m[1].split('?')[0]; // убираем ?r=...
                const title = m[2].replace(/<[^>]+>/g, '').trim();
                if (!forumVisited.has(url) && title.length > 3) {
                    forumQueue.push({ url, title });
                }
            }
            console.log(`[ai:forum] Раздел ${section}: найдено тем ${forumQueue.length}`);
        } catch(e) {
            console.log(`[ai:forum] Ошибка раздела ${section}:`, e.message);
        }
    }

    forumQueueBuilt = true;
    console.log(`[ai:forum] Очередь построена: ${forumQueue.length} тем`);
}

// Читаем одну тему из очереди
async function readNextForumTopic(page) {
    if (!forumQueueBuilt) {
        await buildForumQueue(page);
        return;
    }

    if (forumQueue.length === 0) {
        console.log('[ai:forum] Все темы прочитаны, перестраиваем очередь...');
        forumQueueBuilt = false;
        return;
    }

    const topic = forumQueue.shift();
    if (forumVisited.has(topic.url)) return;
    forumVisited.add(topic.url);

    try {
        console.log(`[ai:forum] Читаем: ${topic.title} (${topic.url})`);
        await page.goto(BASE_URL + topic.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);
        const html = await page.evaluate(() => document.body.innerHTML);

        // Извлекаем текст постов
        const textBlocks = [];
        const re = /<span class="(?:white|Admin)">([\s\S]*?)<\/span>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const t = m[1].replace(/<[^>]+>/g, '').trim();
            if (t.length > 30) textBlocks.push(t.substring(0, 400));
            if (textBlocks.length >= 3) break;
        }

        if (!textBlocks.length) return;

        const raw = textBlocks.join('\n').substring(0, 900);

        // Просим ИИ сделать краткое резюме
        const summary = await callGroq([{
            role: 'user',
            content: `Вот текст с форума игры "Битва Титанов", тема: "${topic.title}".\n\n${raw}\n\nСделай краткое резюме в 1-2 предложениях: что это, зачем нужно в игре. Отвечай по-русски.`,
        }], 150);

        if (summary && summary.length > 10) {
            gameKnowledge.push({ title: topic.title, summary, url: topic.url });
            // Храним последние 40 тем
            if (gameKnowledge.length > 40) gameKnowledge.shift();
            console.log(`[ai:forum] Изучено: "${topic.title}" — ${summary.substring(0, 60)}...`);
        }

    } catch(e) {
        console.log(`[ai:forum] Ошибка чтения темы:`, e.message);
    }
}

// ── Команды управления ────────────────────────────────────────────────────────
function handleAiChatCommand(msg, botRank) {
    if (botRank < 3) return null;
    const m = msg.trim().toLowerCase();

    if (m === '/ии клан чат вкл')  { aiClanEnabled = true;  return '🤖 МАГИ включена в клан-чате.'; }
    if (m === '/ии клан чат выкл') { aiClanEnabled = false; return '🤖 МАГИ выключена в клан-чате.'; }
    if (m === '/ии чат вкл')       { aiTitansEnabled = true;  return '🤖 МАГИ включена в чате Титанов.'; }
    if (m === '/ии чат выкл')      { aiTitansEnabled = false; return '🤖 МАГИ выключена в чате Титанов.'; }

    if (m === '/узнай о игре вкл') {
        forumLearning = true;
        forumQueueBuilt = false;
        return '📚 МАГИ начинает изучать форум игры.';
    }
    if (m === '/узнай о игре выкл') {
        forumLearning = false;
        return '📚 Изучение форума остановлено.';
    }

    if (m === '/расскажи что узнала') {
        if (!gameKnowledge.length) return 'Я ещё ничего не успела изучить 🌙 Включи /узнай о игре вкл';
        const last = gameKnowledge.slice(-8);
        const lines = last.map(k => `• ${k.title}: ${k.summary}`).join('\n');
        return `Вот что я изучила (последние ${last.length} тем):\n\n${lines}\n\nВсего изучено тем: ${gameKnowledge.length}`;
    }

    if (m === '/ии статус') {
        return `🤖 Клан-чат: ${aiClanEnabled?'ВКЛ':'ВЫКЛ'} | Титаны: ${aiTitansEnabled?'ВКЛ':'ВЫКЛ'} | Форум: ${forumLearning?'ВКЛ':'ВЫКЛ'} | Изучено тем: ${gameKnowledge.length}`;
    }

    return null;
}

// ── Главный тик (вызывается из clan-bot.js каждые 5 сек) ──────────────────────
async function tickAiChat(page, sendClanChatFn, sendTitansChatFn) {
    // ── Клан-чат ──
    if (aiClanEnabled) {
        clanTickCount++;
        // Каждые CHAT_TICK_SEC секунд (= CHAT_TICK_SEC/5 тиков)
        const clanInterval = Math.floor(CHAT_TICK_SEC / 5);
        if (clanTickCount >= clanInterval) {
            clanTickCount = 0;
            // forceSpeak раз в 5 проверок если чат молчит (т.е. раз в ~5 минут)
            const forceSpeak = (Math.floor(Date.now() / (5 * 60 * 1000)) % 5 === 0);
            await processChatTick(page, CLAN_CHAT_URL, 'clan', sendClanChatFn, forceSpeak);
        }
    }

    // ── Чат Титанов ──
    if (aiTitansEnabled) {
        titansTickCount++;
        const titansInterval = Math.floor(CHAT_TICK_SEC / 5);
        if (titansTickCount >= titansInterval) {
            titansTickCount = 0;
            const forceSpeak = (Math.floor(Date.now() / (5 * 60 * 1000)) % 5 === 0);
            await processChatTick(page, TITANS_CHAT_URL, 'titans', sendTitansChatFn, forceSpeak);
        }
    }

    // ── Форум ──
    if (forumLearning) {
        forumTickCount++;
        // Раз в FORUM_TICK_MIN минут
        const forumInterval = Math.floor((FORUM_TICK_MIN * 60) / 5);
        if (forumTickCount >= forumInterval) {
            forumTickCount = 0;
            await readNextForumTopic(page);
        }
    }
}

function getKnowledgeSummary() {
    return gameKnowledge;
}

module.exports = {
    handleAiChatCommand,
    tickAiChat,
    getKnowledgeSummary,
    setAiClan:   v => { aiClanEnabled   = v; },
    setAiTitans: v => { aiTitansEnabled = v; },
};
