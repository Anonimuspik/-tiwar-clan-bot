// ── ФОРУМ-КВИЗ: вопросы, язык, состояния ────────────────────────────────────

const QUIZ_QUESTIONS = [
    // ── Тема 1: Отсутствие ───────────────────────────────────────────────────
    {
        id: 'abs1',
        ru: {
            q: 'Через сколько дней отсутствия без предупреждения вас могут исключить из клана?',
            a: ['А) 3 дня', 'Б) 5 дней', 'В) 7 дней', 'Г) 10 дней'],
            correct: 'б',
        },
        en: {
            q: 'After how many days of absence without notice can you be excluded from the clan?',
            a: ['A) 3 days', 'B) 5 days', 'C) 7 days', 'D) 10 days'],
            correct: 'b',
        },
    },
    {
        id: 'abs2',
        ru: {
            q: 'Правило об отсутствии распространяется на...',
            a: ['А) Только новобранцев', 'Б) Только рядовых бойцов', 'В) Все звания включая заместителя', 'Г) Только офицеров и выше'],
            correct: 'в',
        },
        en: {
            q: 'The absence rule applies to...',
            a: ['A) Recruits only', 'B) Regular fighters only', 'C) All ranks including deputy', 'D) Officers and above only'],
            correct: 'c',
        },
    },
    {
        id: 'abs3',
        ru: {
            q: 'Куда нужно сообщить об отсутствии?',
            a: ['А) Никуда, просто уйти', 'Б) В тему на форуме или лично руководству', 'В) Только в общий чат', 'Г) Только заместителю'],
            correct: 'б',
        },
        en: {
            q: 'Where should you report your absence?',
            a: ['A) Nowhere, just leave', 'B) In the forum topic or personally to leadership', 'C) Only in clan chat', 'D) Only to the deputy'],
            correct: 'b',
        },
    },
    {
        id: 'abs4',
        ru: {
            q: 'Зачем предупреждать клан об отсутствии?',
            a: ['А) Чтобы получить награду', 'Б) Это не нужно', 'В) Чтобы руководство не приняло это за потерю интереса', 'Г) Чтобы получить временный ранг выше'],
            correct: 'в',
        },
        en: {
            q: 'Why should you warn the clan about your absence?',
            a: ['A) To get a reward', 'B) It is not necessary', 'C) So leadership does not mistake it for loss of interest', 'D) To get a temporary higher rank'],
            correct: 'c',
        },
    },
    {
        id: 'abs5',
        ru: {
            q: 'Что происходит если вы предупредили клан об отсутствии?',
            a: ['А) Вас всё равно исключат', 'Б) Вы сохраните своё место в клане', 'В) Вас понизят в звании', 'Г) Ничего не изменится'],
            correct: 'б',
        },
        en: {
            q: 'What happens if you warned the clan about your absence?',
            a: ['A) You will still be excluded', 'B) You will keep your place in the clan', 'C) You will be demoted', 'D) Nothing changes'],
            correct: 'b',
        },
    },

    // ── Тема 2: Ранги ────────────────────────────────────────────────────────
    {
        id: 'rank1',
        ru: {
            q: 'Сколько клановых боёв в неделю должен проводить Боец?',
            a: ['А) 13 боёв', 'Б) 20 боёв', 'В) 23 боя', 'Г) 27 боёв'],
            correct: 'в',
        },
        en: {
            q: 'How many clan battles per week should a Fighter attend?',
            a: ['A) 13 battles', 'B) 20 battles', 'C) 23 battles', 'D) 27 battles'],
            correct: 'c',
        },
    },
    {
        id: 'rank2',
        ru: {
            q: 'Какой минимальный кланового опыта в день нужен Офицеру?',
            a: ['А) 70 000', 'Б) 100 000', 'В) 250 000', 'Г) 450 000'],
            correct: 'в',
        },
        en: {
            q: 'What is the minimum daily clan exp required for an Officer?',
            a: ['A) 70,000', 'B) 100,000', 'C) 250,000', 'D) 450,000'],
            correct: 'c',
        },
    },
    {
        id: 'rank3',
        ru: {
            q: 'Сколько дней нужно провести в клане чтобы стать Генералом?',
            a: ['А) 10 дней', 'Б) 20 дней', 'В) 30 дней', 'Г) 50 дней'],
            correct: 'б',
        },
        en: {
            q: 'How many days in the clan are required to become a General?',
            a: ['A) 10 days', 'B) 20 days', 'C) 30 days', 'D) 50 days'],
            correct: 'b',
        },
    },
    {
        id: 'rank4',
        ru: {
            q: 'Какой минимальный клановый опыт в день у Новобранца?',
            a: ['А) 50 000', 'Б) 70 000', 'В) 100 000', 'Г) 150 000'],
            correct: 'б',
        },
        en: {
            q: 'What is the minimum daily clan exp for a Recruit?',
            a: ['A) 50,000', 'B) 70,000', 'C) 100,000', 'D) 150,000'],
            correct: 'b',
        },
    },
    {
        id: 'rank5',
        ru: {
            q: 'Сколько боёв в неделю нужно Офицеру?',
            a: ['А) 13 боёв', 'Б) 20 боёв', 'В) 25 боёв', 'Г) 30 боёв'],
            correct: 'в',
        },
        en: {
            q: 'How many battles per week does an Officer need?',
            a: ['A) 13 battles', 'B) 20 battles', 'C) 25 battles', 'D) 30 battles'],
            correct: 'c',
        },
    },

    // ── Тема 3: Сражения ─────────────────────────────────────────────────────
    {
        id: 'fight1',
        ru: {
            q: 'За сколько минут до начала нужно вступить в Клановый Колизей и Турнир?',
            a: ['А) За 1 минуту', 'Б) За 5 минут', 'В) За 10 минут', 'Г) В любое время'],
            correct: 'б',
        },
        en: {
            q: 'How many minutes before start should you join Clan Coliseum and Tournament?',
            a: ['A) 1 minute before', 'B) 5 minutes before', 'C) 10 minutes before', 'D) Any time'],
            correct: 'b',
        },
    },
    {
        id: 'fight2',
        ru: {
            q: 'Почему уход в AFK во время Колизея/Турнира вредит команде?',
            a: ['А) Вы теряете опыт', 'Б) Общая сила влияет на сложность противников', 'В) Вас автоматически исключат', 'Г) Не вредит никак'],
            correct: 'б',
        },
        en: {
            q: 'Why does going AFK during Coliseum/Tournament harm the team?',
            a: ['A) You lose exp', 'B) Total power affects enemy difficulty', 'C) You get auto-excluded', 'D) It does not harm anyone'],
            correct: 'b',
        },
    },
    {
        id: 'fight3',
        ru: {
            q: 'На каком сражении можно участвовать в любое время?',
            a: ['А) Клановый Турнир', 'Б) Клановый Колизей', 'В) Древний Алтарь', 'Г) Ни на каком'],
            correct: 'в',
        },
        en: {
            q: 'In which battle can you participate at any time?',
            a: ['A) Clan Tournament', 'B) Clan Coliseum', 'C) Ancient Altar', 'D) None of them'],
            correct: 'c',
        },
    },
    {
        id: 'fight4',
        ru: {
            q: 'Что нужно использовать при AFK на Древнем Алтаре?',
            a: ['А) Зелье силы', 'Б) Питомца с ответным ударом', 'В) Щит защиты', 'Г) Ничего не нужно'],
            correct: 'б',
        },
        en: {
            q: 'What must you use when going AFK at the Ancient Altar?',
            a: ['A) A power potion', 'B) A pet with counter-attack', 'C) A defense shield', 'D) Nothing is needed'],
            correct: 'b',
        },
    },
    {
        id: 'fight5',
        ru: {
            q: 'Зачем вступать в Колизей/Турнир за 5 минут до начала?',
            a: ['А) Чтобы получить бонус', 'Б) Чтобы не мешать союзникам', 'В) Это не обязательно', 'Г) Чтобы выбрать противника'],
            correct: 'б',
        },
        en: {
            q: 'Why join Coliseum/Tournament 5 minutes before the start?',
            a: ['A) To get a bonus', 'B) To not interfere with allies', 'C) It is not required', 'D) To choose an opponent'],
            correct: 'b',
        },
    },
];

// Правильные ответы по id
const CORRECT_ANSWERS = {};
for (const q of QUIZ_QUESTIONS) {
    CORRECT_ANSWERS[q.id] = { ru: q.ru.correct, en: q.en.correct };
}

// Выбрать 5 случайных вопросов из 15
function getRandomQuestions() {
    const shuffled = [...QUIZ_QUESTIONS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 5);
}

// Получить состояние квиза пользователя
function getQuizState(data, userId) {
    if (!data.quizStates) data.quizStates = {};
    return data.quizStates[userId] || null;
}

function setQuizState(data, userId, state) {
    if (!data.quizStates) data.quizStates = {};
    data.quizStates[userId] = state;
}

// Форматировать вопрос для отправки
function formatQuestion(q, lang, index, total) {
    const d = q[lang];
    const prefix = lang === 'ru'
        ? `Вопрос ${index}/${total}:\n${d.q}\n\n`
        : `Question ${index}/${total}:\n${d.q}\n\n`;
    const answers = d.a.join('\n');
    const timer = lang === 'ru'
        ? '\n\n⏱ На ответ — 2 минуты.\nНапишите букву: а(a) / б(b) / в(v) / г(g)\n⚠ Если следующий ответ — та же буква, напишите латинскую (игра блокирует одинаковые сообщения подряд)'
        : '\n\n⏱ 2 minutes to answer.\nType the letter: a(а) / b(б) / v(в) / g(г)\n⚠ If next answer is the same letter, use the Latin version (the game blocks identical messages in a row)';
    return prefix + answers + timer;
}

module.exports = {
    QUIZ_QUESTIONS,
    CORRECT_ANSWERS,
    getRandomQuestions,
    getQuizState,
    setQuizState,
    formatQuestion,
};
