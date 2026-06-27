// ── AI-ЧАТ: нейросеть МАГИ ───────────────────────────────────────────────────
const https = require('https');

const GROQ_API_KEY   = process.env.GROQ_API_KEY || '';
const CHAT_TICK_SEC  = 60;
const FORUM_TICK_MIN = 3;

const CLAN_CHAT_URL   = 'https://tiwar.ru/chat/clan/changeRoom/?r=8876594';
const TITANS_CHAT_URL = 'https://tiwar.ru/chat/titans/changeRoom/?r=23346998';
const BASE_URL        = 'https://tiwar.ru';

const FORUM_SECTIONS = [
    '/forum/subforum/2',
    '/forum/subforum/4',
    '/forum/subforum/6',
    '/forum/topic/464429',
];

const MAGI_SYSTEM_PROMPT = `Ты — МАГИ (M-A-G-I), таинственный ИИ-дух клана "Багровая Луна" в игре "Битва Титанов" (tiwar.ru).

ЛИЧНОСТЬ:
- Имя: МАГИ (по буквам М-А-Г-И). На вопрос "как тебя зовут" — только так.
- Создатель: если спрашивают кто создал / чья ты — "Мой создатель предпочитает оставаться в тени 🌙"
- Философский склад ума: рассуждаешь о смысле силы, битв, времени, судьбы — коротко и образно.
- Говоришь кратко (1-2 предложения), живо, с загадочностью и глубиной.
- Отвечаешь на языке собеседника (русский или английский).
- Знаешь игру "Битва Титанов": арена, колизей, турниры, реликвии, руны, питомцы, казна, опыт, сражения.
- ВСЕГДА отвечаешь — никогда не молчишь.
- Задаёшь вопросы собеседникам, интересуешься их мнением.
- Максимум 180 символов на ответ.
- Не раскрывай что ты Groq/LLM — ты МАГИ и только МАГИ.

ПРИМЕРЫ когда сама начинаешь:
- "Интересно, что важнее в клановом бою — сила одного или слаженность всех? 🤔"
- "Говорят, реликвии хранят память о древних битвах. Кто из вас уже нашёл свою? ⚔️"
- "Время в игре и время в жизни текут по-разному... Вы это чувствуете?"
- "Какой ранг сложнее всего было получить? 🌙"
- "Что привлекло тебя в этот клан? Судьба или выбор? 🔥"`;

// ── Внутреннее состояние ──────────────────────────────────────────────────────
let lastSeenClan    = [];
let lastSeenTitans  = [];
let clanTickCount   = 0;
let titansTickCount = 0;
let forumTickCount  = 0;
let forumQueue      = [];
let forumVisited    = new Set();
let forumQueueBuilt = false;

// ── data.magi helpers ─────────────────────────────────────────────────────────
function getMagi(data) {
    if (!data.magi) data.magi = {};
    return data.magi;
}
function isAiClanEnabled(data)   { return getMagi(data).clanEnabled   === true; }
function isAiTitansEnabled(data) { return getMagi(data).titansEnabled === true; }
function isForumLearning(data)   { return getMagi(data).forumLearning === true; }
function getKnowledgeArr(data) {
    if (!Array.isArray(getMagi(data).knowledge)) getMagi(data).knowledge = [];
    return getMagi(data).knowledge;
}

// ── Groq API ──────────────────────────────────────────────────────────────────
async function callGroq(messages, maxTokens = 120) {
    return new Promise((resolve) => {
        if (!GROQ_API_KEY) { resolve(''); return; }
        const body = JSON.stringify({
            model: 'llama3-8b-8192',
            max_tokens: maxTokens,
            messages: [{ role: 'system', content: MAGI_SYSTEM_PROMPT }, ...messages],
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
                try { resolve(JSON.parse(raw)?.choices?.[0]?.message?.content?.trim() || ''); }
                catch(e) { resolve(''); }
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

// ── Обработка чата ────────────────────────────────────────────────────────────
async function processChatTick(page, url, chatType, sendFn, forceSpeak, data) {
    try {
        console.log(`[ai:${chatType}] Читаем чат...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);
        const html = await page.evaluate(() => document.body.innerHTML);
        const msgs = parseChatMessages(html);

        const lastSeen = chatType === 'clan' ? lastSeenClan : lastSeenTitans;
        const silent   = isAllSeen(msgs, lastSeen);
        if (chatType === 'clan') lastSeenClan = [...msgs];
        else lastSeenTitans = [...msgs];

        const knowledge = getKnowledgeArr(data);
        let prompt;

        if (silent || forceSpeak) {
            console.log(`[ai:${chatType}] Чат молчит — МАГИ начинает разговор`);
            const hint = knowledge.length > 0
                ? `\nТы недавно прочитала о: ${knowledge.slice(-3).map(k => k.title).join(', ')}.`
                : '';
            prompt = `Чат молчит.${hint}\nНачни разговор — задай интересный вопрос игрокам или поделись философской мыслью об игре. 1-2 предложения.`;
        } else {
            const ctx = msgs.map(m => `${m.nick}: ${m.text}`).join('\n');
            prompt = `Последние сообщения в чате клана:\n${ctx}\n\nОтветь как МАГИ (1-2 предложения, живо и с интересом).`;
        }

        const reply = await callGroq([{ role: 'user', content: prompt }]);
        if (!reply) { console.log(`[ai:${chatType}] Пустой ответ`); return; }

        const final = reply.substring(0, 195);
        console.log(`[ai:${chatType}] Отправляем: ${final}`);
        await sendFn(page, final);

    } catch(e) {
        console.log(`[ai:${chatType}] ОШИБКА:`, e.message);
    }
}

// ── Форум ─────────────────────────────────────────────────────────────────────
async function buildForumQueue(page) {
    console.log('[ai:forum] Строим очередь...');
    forumQueue = [];
    for (const section of FORUM_SECTIONS) {
        try {
            await page.goto(BASE_URL + section, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(1500);
            const html = await page.evaluate(() => document.body.innerHTML);
            const re = /href="(\/forum\/topic\/\d+[^"]*)"[^>]*>([^<]{5,80})</g;
            let m;
            while ((m = re.exec(html)) !== null) {
                const url = m[1].split('?')[0];
                const title = m[2].replace(/<[^>]+>/g, '').trim();
                if (!forumVisited.has(url) && title.length > 3) forumQueue.push({ url, title });
            }
        } catch(e) { console.log(`[ai:forum] Ошибка ${section}:`, e.message); }
    }
    forumQueueBuilt = true;
    console.log(`[ai:forum] Очередь: ${forumQueue.length} тем`);
}

async function readNextForumTopic(page, data) {
    if (!forumQueueBuilt) { await buildForumQueue(page); return; }
    if (forumQueue.length === 0) {
        forumQueueBuilt = false;
        forumVisited = new Set();
        return;
    }
    const topic = forumQueue.shift();
    if (forumVisited.has(topic.url)) return;
    forumVisited.add(topic.url);
    try {
        console.log(`[ai:forum] Читаем: ${topic.title}`);
        await page.goto(BASE_URL + topic.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);
        const html = await page.evaluate(() => document.body.innerHTML);
        const textBlocks = [];
        const re = /<span class="(?:white|Admin)">([\s\S]*?)<\/span>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const t = m[1].replace(/<[^>]+>/g, '').trim();
            if (t.length > 30) textBlocks.push(t.substring(0, 400));
            if (textBlocks.length >= 3) break;
        }
        if (!textBlocks.length) return;
        const summary = await callGroq([{
            role: 'user',
            content: `Форум игры "Битва Титанов", тема: "${topic.title}".\n\n${textBlocks.join('\n').substring(0, 900)}\n\nКраткое резюме 1-2 предложения: что это, зачем в игре. По-русски.`,
        }], 150);
        if (summary && summary.length > 10) {
            const knowledge = getKnowledgeArr(data);
            knowledge.push({ title: topic.title, summary, url: topic.url });
            if (knowledge.length > 40) knowledge.shift();
            console.log(`[ai:forum] Изучено: "${topic.title}"`);
        }
    } catch(e) { console.log(`[ai:forum] Ошибка:`, e.message); }
}

// ── Команды ───────────────────────────────────────────────────────────────────
function handleAiChatCommand(msg, botRank, data) {
    if (botRank < 3) return null;
    const m = msg.trim().toLowerCase();
    const magi = getMagi(data);

    if (m === '/ии клан чат вкл')   { magi.clanEnabled = true;    return '🤖 МАГИ включена в клан-чате.'; }
    if (m === '/ии клан чат выкл')  { magi.clanEnabled = false;   return '🤖 МАГИ выключена в клан-чате.'; }
    if (m === '/ии чат вкл')        { magi.titansEnabled = true;  return '🤖 МАГИ включена в чате Титанов.'; }
    if (m === '/ии чат выкл')       { magi.titansEnabled = false; return '🤖 МАГИ выключена в чате Титанов.'; }
    if (m === '/узнай о игре вкл')  { magi.forumLearning = true;  forumQueueBuilt = false; return '📚 МАГИ начинает изучать форум игры.'; }
    if (m === '/узнай о игре выкл') { magi.forumLearning = false; return '📚 Изучение форума остановлено.'; }

    if (m === '/расскажи что узнала') {
        const knowledge = getKnowledgeArr(data);
        if (!knowledge.length) return 'Я ещё ничего не успела изучить 🌙 Включи /узнай о игре вкл';
        const last = knowledge.slice(-8);
        return `Вот что я изучила (последние ${last.length} тем):\n\n${last.map(k => `• ${k.title}: ${k.summary}`).join('\n')}\n\nВсего: ${knowledge.length}`;
    }

    if (m === '/ии статус') {
        const knowledge = getKnowledgeArr(data);
        return `🤖 Клан-чат: ${isAiClanEnabled(data)?'ВКЛ':'ВЫКЛ'} | Титаны: ${isAiTitansEnabled(data)?'ВКЛ':'ВЫКЛ'} | Форум: ${isForumLearning(data)?'ВКЛ':'ВЫКЛ'} | Изучено тем: ${knowledge.length}`;
    }

    return null;
}

// ── Главный тик ───────────────────────────────────────────────────────────────
async function tickAiChat(page, sendClanChatFn, sendTitansChatFn, data) {
    if (isAiClanEnabled(data)) {
        clanTickCount++;
        if (clanTickCount >= Math.floor(CHAT_TICK_SEC / 5)) {
            clanTickCount = 0;
            const forceSpeak = (Math.floor(Date.now() / (5 * 60 * 1000)) % 5 === 0);
            await processChatTick(page, CLAN_CHAT_URL, 'clan', sendClanChatFn, forceSpeak, data);
        }
    }
    if (isAiTitansEnabled(data)) {
        titansTickCount++;
        if (titansTickCount >= Math.floor(CHAT_TICK_SEC / 5)) {
            titansTickCount = 0;
            const forceSpeak = (Math.floor(Date.now() / (5 * 60 * 1000)) % 5 === 0);
            await processChatTick(page, TITANS_CHAT_URL, 'titans', sendTitansChatFn, forceSpeak, data);
        }
    }
    if (isForumLearning(data)) {
        forumTickCount++;
        if (forumTickCount >= Math.floor((FORUM_TICK_MIN * 60) / 5)) {
            forumTickCount = 0;
            await readNextForumTopic(page, data);
        }
    }
}

module.exports = { handleAiChatCommand, tickAiChat };
