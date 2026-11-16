/* ═══════════════════════════════════════════════════════
   CSE Reviewer — app.js  v5.0
   Features: Timer (per-question / full-exam / none),
             Wrong Answer Review, Retry Wrong,
             Bookmarks/Flag, Weak Topic Radar,
             Question Map, Light/Dark theme, Exam mode
═══════════════════════════════════════════════════════ */

const API_URL            = 'api.php';
const QUESTIONS_URL      = 'questions.json';
const LOCAL_STORAGE_KEY  = 'cse_reviewer_progress';
const SESSION_SEED_KEY   = 'cse_reviewer_seed';
const THEME_KEY          = 'cse_theme';
const SAVE_EXPIRY_MS     = 4 * 60 * 60 * 1000;
const API_TOKEN_ENDPOINT = API_URL + '?action=token';
const PASS_MARK          = 80;

/* ── STATE ── */
let data             = null;
let topics           = [];
let displayQuestions = [];
let currentIndex     = 0;
let answers          = {};
let bookmarks        = new Set();
let mode             = 'practice';
let currentCategory  = 'all';
let currentUsername  = '';
let csrfToken        = null;
let sessionSeed      = null;

/* timer */
let timerMode      = 'per-question'; // 'per-question' | 'full-exam' | 'none'
let timerSeconds   = 0;
let timerMax       = 0;
let timerInterval  = null;
let resumeSeconds  = null;

/* retry mode */
let isRetryMode    = false;
let retryQuestions = [];

/* ── CONSTANTS ── */
const LETTERS = ['A','B','C','D'];
const CAT_COLORS = {
  verbal:     '#4f8ef7',
  analytical: '#a66bf5',
  numerical:  '#2fbf80',
  geninfo:    '#f0a032',
  filipino:   '#ee5f5f'
};
const PER_Q_SECONDS = 60;

/* ══════════════════════════════════════════
   THEME
══════════════════════════════════════════ */
function applyThemeUI() {
  const t = document.documentElement.getAttribute('data-theme') || 'dark';
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = t === 'dark' ? '🌙' : '☀️';
  const meta = document.getElementById('meta-theme');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0d1117' : '#f4f6fb');
}

function toggleTheme() {
  const cur  = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyThemeUI();
}
applyThemeUI();

/* ══════════════════════════════════════════
   UTILS
══════════════════════════════════════════ */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shuffleQuestionChoices(q) {
  const correctText     = q.choices[q.answer];
  const shuffledChoices = shuffle(q.choices);
  const shuffledAnswer  = shuffledChoices.indexOf(correctText);
  return { ...q, shuffledChoices, shuffledAnswer };
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return function() {
    value += 0x6D2B79F5;
    let t = Math.imul(value ^ value >>> 15, 1 | value);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed(arr, seed) {
  const rng = seededRandom(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(String(str).replace(' ', 'T'));
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' })
    + ' ' + d.toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit' });
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function loadCsrfToken() {
  try {
    const resp = await fetch(API_TOKEN_ENDPOINT);
    const json = await resp.json();
    if (json.success && json.data && json.data.csrf_token) {
      csrfToken = json.data.csrf_token;
    }
  } catch (e) {
    console.warn('Could not fetch CSRF token', e);
    csrfToken = null;
  }
}

function loadSavedProgress() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return null;
    if (Date.now() - (saved.timestamp || 0) > SAVE_EXPIRY_MS) {
      clearSavedProgress();
      return null;
    }
    return saved;
  } catch (e) {
    console.warn('Could not load saved quiz progress', e);
    return null;
  }
}

function restoreSavedProgress() {
  const saved = loadSavedProgress();
  if (!saved || saved.username !== currentUsername) return false;
  if (!Array.isArray(saved.displayQuestions) || !saved.answers) return false;

  displayQuestions  = saved.displayQuestions;
  answers           = saved.answers;
  bookmarks         = new Set(saved.bookmarks || []);
  currentCategory   = saved.currentCategory || 'all';
  currentIndex      = saved.currentIndex || 0;
  mode              = saved.mode || mode;
  timerMode         = saved.timerMode || timerMode;
  sessionSeed       = saved.sessionSeed || sessionSeed;
  isRetryMode       = saved.isRetryMode || false;
  resumeSeconds     = (timerMode === 'full-exam' && typeof saved.timerSeconds === 'number' && saved.timerSeconds > 0)
                        ? saved.timerSeconds : null;
  return true;
}

function saveProgress() {
  if (!currentUsername || displayQuestions.length === 0) return;
  try {
    const payload = {
      username: currentUsername,
      timestamp: Date.now(),
      displayQuestions,
      answers,
      bookmarks: Array.from(bookmarks),
      currentCategory,
      currentIndex,
      mode,
      timerMode,
      timerSeconds,
      sessionSeed,
      isRetryMode
    };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Could not save progress', e);
  }
}

function clearSavedProgress() {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    localStorage.removeItem(SESSION_SEED_KEY);
  } catch (e) {}
}

/* ══════════════════════════════════════════
   USERNAME / START
══════════════════════════════════════════ */
function startWithUsername() {
  const input = document.getElementById('username-input');
  const err   = document.getElementById('username-error');
  const val   = input.value.trim();
  if (!val || !/^[a-zA-Z0-9 _\-\.]{1,30}$/.test(val)) {
    err.style.display = 'block';
    input.focus();
    return;
  }
  err.style.display = 'none';
  currentUsername = val;

  const timerSel = document.querySelector('input[name="timer-mode"]:checked');
  timerMode = timerSel ? timerSel.value : 'per-question';

  document.getElementById('user-chip').textContent = '👤 ' + val;
  document.getElementById('username-screen').style.display = 'none';
  document.getElementById('topnav').style.display = 'flex';
  document.getElementById('loading').style.display = 'block';
  loadQuestions();
}

function selectTimerOption(value) {
  document.querySelectorAll('.timer-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === value);
  });
  const radio = document.querySelector(`input[name="timer-mode"][value="${value}"]`);
  if (radio) radio.checked = true;
}

/* ══════════════════════════════════════════
   SECTION NAVIGATION
══════════════════════════════════════════ */
function showSection(section) {
  ['quiz-screen','results-screen','leaderboard-screen'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  if (section === 'quiz')        document.getElementById('quiz-screen').style.display = 'block';
  if (section === 'results')     document.getElementById('results-screen').style.display = 'block';
  if (section === 'leaderboard') document.getElementById('leaderboard-screen').style.display = 'block';

  document.querySelectorAll('.topnav-btn').forEach(b => b.classList.remove('active'));
  const map = { quiz: 'nav-quiz', leaderboard: 'nav-lb' };
  if (map[section]) document.getElementById(map[section]).classList.add('active');
  if (section === 'leaderboard') loadLeaderboard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════════════════════════════════════
   LOAD & INIT
══════════════════════════════════════════ */
async function loadQuestions() {
  try {
    const res = await fetch(QUESTIONS_URL, { cache: 'no-cache' });
    data = await res.json();
    topics = data.topics;
    await loadCsrfToken();
    initQuiz();
  } catch(e) {
    document.getElementById('loading').innerHTML =
      '<p style="color:var(--danger)">⚠️ Could not load questions.json. Make sure it is in the same folder.</p>';
  }
}

function initQuiz(retryList) {
  isRetryMode     = !!retryList;
  retryQuestions  = retryList || [];
  answers         = {};
  bookmarks       = new Set();
  currentIndex    = 0;
  currentCategory = 'all';
  resumeSeconds   = null;

  let resumed = false;
  if (!isRetryMode && restoreSavedProgress()) {
    resumed = true;
  } else if (isRetryMode) {
    displayQuestions = retryList.map(q => shuffleQuestionChoices(q));
  } else {
    buildDisplayQuestions();
  }

  buildTabs();
  if (bookmarks.size > 0) rebuildBookmarkTab();
  syncModeButtons();
  renderAll();
  saveProgress();

  document.getElementById('loading').style.display      = 'none';
  document.getElementById('quiz-screen').style.display  = 'block';
  document.getElementById('wrong-review').style.display = 'none';

  const timerBar = document.getElementById('timer-bar');
  if (timerMode === 'none') {
    timerBar.style.display = 'none';
  } else {
    timerBar.style.display = 'flex';
    startTimer();
  }

  if (resumed) showToast('Welcome back — your previous session was restored.');
}

function buildDisplayQuestions() {
  let flat = [];
  topics.forEach(topic => {
    const required = topic.required || topic.questions.length;
    const pool     = shuffle(topic.questions);
    const selected = pool.slice(0, required);
    selected.forEach(q => {
      flat.push({
        ...q,
        topicId:    topic.id,
        topicName:  topic.name,
        topicColor: CAT_COLORS[topic.id] || '#8b91a8'
      });
    });
  });
  sessionSeed = Date.now() >>> 0;
  try { localStorage.setItem(SESSION_SEED_KEY, String(sessionSeed)); } catch (e) {}
  displayQuestions = shuffleWithSeed(flat, sessionSeed).map(q => shuffleQuestionChoices(q));
}

function renderAll() {
  updateStats();
  renderQuestion(getFilteredQuestions());
  updateWeakRadar();
  updateBookmarkedBanner();
}

function syncModeButtons() {
  document.getElementById('mode-practice').classList.toggle('active', mode === 'practice');
  document.getElementById('mode-exam').classList.toggle('active', mode === 'exam');
}

/* ══════════════════════════════════════════
   TIMER
══════════════════════════════════════════ */
function startTimer() {
  stopTimer();
  if (timerMode === 'none') return;

  if (timerMode === 'per-question') {
    timerMax     = PER_Q_SECONDS;
    timerSeconds = PER_Q_SECONDS;
  } else {
    timerMax     = displayQuestions.length * PER_Q_SECONDS;
    timerSeconds = resumeSeconds || timerMax;
  }

  renderTimerBar();
  timerInterval = setInterval(tickTimer, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function resetPerQuestionTimer() {
  if (timerMode !== 'per-question') return;
  stopTimer();
  timerMax     = PER_Q_SECONDS;
  timerSeconds = PER_Q_SECONDS;
  renderTimerBar();
  timerInterval = setInterval(tickTimer, 1000);
}

function tickTimer() {
  timerSeconds--;
  if (timerSeconds <= 0) {
    timerSeconds = 0;
    renderTimerBar();
    if (timerMode === 'per-question') {
      const qs = getFilteredQuestions();
      const q  = qs[currentIndex];
      if (q && answers[q.id] === undefined) {
        if (currentIndex < qs.length - 1) {
          navigate(1);
        } else {
          stopTimer();
        }
      } else {
        stopTimer();
      }
    } else {
      stopTimer();
      showToast('⏰ Time is up — submitting your answers.');
      finishQuiz();
    }
    return;
  }
  renderTimerBar();
}

function renderTimerBar() {
  const digs = document.getElementById('timer-digits');
  const fill = document.getElementById('timer-fill');
  const lbl  = document.getElementById('timer-label');
  if (!digs) return;

  const pct      = timerMax > 0 ? (timerSeconds / timerMax) * 100 : 100;
  const isWarn   = pct < 40;
  const isDanger = pct < 15;

  digs.textContent = formatTime(timerSeconds);
  digs.className   = 'timer-digits' + (isDanger ? ' danger' : isWarn ? ' warning' : '');
  fill.className   = 'timer-fill'   + (isDanger ? ' danger' : isWarn ? ' warning' : '');
  fill.style.width = pct + '%';

  if (lbl) {
    lbl.textContent = timerMode === 'per-question' ? 'Time per question' : 'Total exam time';
  }
}

/* ══════════════════════════════════════════
   TABS
══════════════════════════════════════════ */
function buildTabs() {
  const tabs = document.getElementById('cat-tabs');
  tabs.innerHTML = '';
  tabs.appendChild(makeTab('all', '🗂 All', null));
  topics.forEach(t => {
    tabs.appendChild(makeTab(t.id, t.icon + ' ' + t.name, CAT_COLORS[t.id]));
  });
}

function makeTab(id, label, color) {
  const btn = document.createElement('button');
  btn.className = 'tab' + (id === currentCategory ? ' active' : '');
  btn.id = 'tab-' + id;
  btn.setAttribute('role', 'tab');

  const dot = document.createElement('span');
  dot.className = 'weak-dot';
  btn.textContent = label;
  btn.appendChild(dot);

  btn.onclick = () => {
    currentCategory = id;
    currentIndex    = 0;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderAll();
    if (timerMode === 'per-question') resetPerQuestionTimer();
  };
  return btn;
}

/* ══════════════════════════════════════════
   FILTERING
══════════════════════════════════════════ */
function getFilteredQuestions() {
  if (currentCategory === 'bookmarked') {
    return displayQuestions.filter(q => bookmarks.has(q.id));
  }
  if (currentCategory !== 'all') {
    return displayQuestions.filter(q => q.topicId === currentCategory);
  }
  return displayQuestions;
}

/* ══════════════════════════════════════════
   RENDER QUESTION
══════════════════════════════════════════ */
function renderQuestion(qs) {
  const container = document.getElementById('questions-container');
  if (!qs.length) {
    container.innerHTML = '<p style="color:var(--muted);text-align:center;padding:2rem">No questions in this view.</p>';
    updateProgressBar(qs);
    updateNavButtons(qs);
    renderQuestionMap(qs);
    return;
  }
  if (currentIndex >= qs.length) currentIndex = qs.length - 1;
  if (currentIndex < 0) currentIndex = 0;

  const q            = qs[currentIndex];
  const choices      = q.shuffledChoices;
  const correctIdx   = q.shuffledAnswer;
  const answered     = answers[q.id];
  const isAnswered   = answered !== undefined;
  const isBookmarked = bookmarks.has(q.id);
  const color        = q.topicColor || CAT_COLORS[q.topicId] || '#8b91a8';
  const practice     = mode === 'practice';

  const pill  = `<span class="q-cat-pill" style="background:${color}22;color:${color};border:1px solid ${color}55">${escHtml(q.topicName || '')}</span>`;
  const bkCls = isBookmarked ? ' bookmarked' : '';
  const bkTxt = isBookmarked ? '🔖 Flagged' : '🔖 Flag';

  const choicesHTML = choices.map((ch, i) => {
    let cls    = 'choice';
    let status = '';
    if (isAnswered) {
      if (practice) {
        if (i === correctIdx)                     { cls += ' correct'; status = i === answered ? '✓' : ''; }
        else if (i === answered)                  { cls += ' wrong';   status = '✗'; }
      } else if (i === answered) {
        cls += ' selected';
      }
    }
    const locked = isAnswered && practice;
    return `<button class="${cls}" role="radio" aria-checked="${answered === i ? 'true' : 'false'}" onclick="selectAnswer('${escHtml(q.id)}', ${i}, ${correctIdx})" ${locked ? 'disabled' : ''}>
      <span class="letter">${LETTERS[i]}</span>
      <span>${escHtml(ch)}</span>
      ${status ? `<span class="q-status">${status}</span>` : ''}
    </button>`;
  }).join('');

  const showExpl = isAnswered && practice;

  container.innerHTML = `
    <div class="q-card">
      <div class="q-meta">
        <span class="q-num">Q${currentIndex + 1} of ${qs.length}</span>
        ${pill}
        <button class="bookmark-btn${bkCls}" onclick="toggleBookmark('${escHtml(q.id)}')" id="bk-btn-${escHtml(q.id)}" title="Flag for review (F)">
          ${bkTxt}
        </button>
      </div>
      <div class="q-text">${escHtml(q.question)}</div>
      <div class="choices" role="radiogroup" aria-label="Question ${currentIndex + 1}">${choicesHTML}</div>
      <div class="explanation ${showExpl ? 'show' : ''}">
        <strong>Explanation:</strong> ${escHtml(q.explanation)}
      </div>
    </div>
  `;

  updateProgressBar(qs);
  updateNavButtons(qs);
  renderQuestionMap(qs);
}

/* ══════════════════════════════════════════
   QUESTION MAP
══════════════════════════════════════════ */
function renderQuestionMap(qs) {
  const map = document.getElementById('q-map');
  if (!map) return;
  const practice = mode === 'practice';
  document.getElementById('legend-correct').style.display = practice ? '' : 'none';
  document.getElementById('legend-wrong').style.display   = practice ? '' : 'none';

  map.innerHTML = '';
  qs.forEach((q, i) => {
    const a = answers[q.id];
    let cls = 'q-dot';
    if (a !== undefined) {
      if (practice) cls += a === q.shuffledAnswer ? ' correct' : ' wrong';
      else          cls += ' answered';
    }
    if (bookmarks.has(q.id)) cls += ' flagged';
    if (i === currentIndex)  cls += ' current';
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = i + 1;
    b.title = 'Go to question ' + (i + 1);
    b.onclick = () => {
      currentIndex = i;
      renderQuestion(getFilteredQuestions());
      if (timerMode === 'per-question') resetPerQuestionTimer();
      saveProgress();
      document.getElementById('questions-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    map.appendChild(b);
  });
}

/* ══════════════════════════════════════════
   ANSWER
══════════════════════════════════════════ */
function selectAnswer(qId, chosen, correctIdx) {
  if (answers[qId] !== undefined && mode === 'practice') return;
  answers[qId] = chosen;
  if (timerMode === 'per-question') resetPerQuestionTimer();
  renderQuestion(getFilteredQuestions());
  updateStats();
  updateWeakRadar();
  saveProgress();
}

/* ══════════════════════════════════════════
   BOOKMARK
══════════════════════════════════════════ */
function toggleBookmark(qId) {
  if (bookmarks.has(qId)) {
    bookmarks.delete(qId);
  } else {
    bookmarks.add(qId);
  }
  const btn = document.getElementById('bk-btn-' + qId);
  if (btn) {
    btn.classList.toggle('bookmarked', bookmarks.has(qId));
    btn.textContent = bookmarks.has(qId) ? '🔖 Flagged' : '🔖 Flag';
  }
  updateBookmarkedBanner();
  rebuildBookmarkTab();
  renderQuestionMap(getFilteredQuestions());
  saveProgress();
}

function bookmarkTabLabel() {
  return `🔖 Flagged <span style="font-size:0.7rem;background:var(--bookmark-soft);color:var(--bookmark);padding:1px 7px;border-radius:99px;margin-left:2px">${bookmarks.size}</span>`;
}

function rebuildBookmarkTab() {
  let tab = document.getElementById('tab-bookmarked');
  if (bookmarks.size > 0 && !tab) {
    const tabs = document.getElementById('cat-tabs');
    const btn  = document.createElement('button');
    btn.className = 'tab' + (currentCategory === 'bookmarked' ? ' active' : '');
    btn.id = 'tab-bookmarked';
    btn.innerHTML = bookmarkTabLabel();
    btn.onclick = () => {
      currentCategory = 'bookmarked';
      currentIndex    = 0;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      renderAll();
    };
    tabs.appendChild(btn);
  } else if (tab) {
    if (bookmarks.size === 0) {
      tab.remove();
      if (currentCategory === 'bookmarked') {
        currentCategory = 'all';
        document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === 0));
        renderAll();
      }
    } else {
      tab.innerHTML = bookmarkTabLabel();
    }
  }
}

function updateBookmarkedBanner() {
  const banner = document.getElementById('bookmarked-banner');
  if (!banner) return;
  if (bookmarks.size > 0) {
    banner.classList.add('show');
    document.getElementById('bk-count').textContent = bookmarks.size;
  } else {
    banner.classList.remove('show');
  }
}

function jumpToBookmarks() {
  currentCategory = 'bookmarked';
  currentIndex    = 0;
  rebuildBookmarkTab();
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById('tab-bookmarked');
  if (tab) tab.classList.add('active');
  renderAll();
}

/* ══════════════════════════════════════════
   WEAK TOPIC RADAR
══════════════════════════════════════════ */
function updateWeakRadar() {
  const radar    = document.getElementById('weak-radar');
  const weakList = [];

  if (mode === 'exam') {            // don't leak performance during exam mode
    radar.classList.remove('show');
    topics.forEach(t => { const tab = document.getElementById('tab-' + t.id); if (tab) tab.classList.remove('weak'); });
    return;
  }

  topics.forEach(topic => {
    const qs       = displayQuestions.filter(q => q.topicId === topic.id);
    const answered = qs.filter(q => answers[q.id] !== undefined);
    const tab      = document.getElementById('tab-' + topic.id);
    if (answered.length < 3) { if (tab) tab.classList.remove('weak'); return; }
    const correct = answered.filter(q => answers[q.id] === q.shuffledAnswer).length;
    const pct     = Math.round((correct / answered.length) * 100);
    if (pct < 60) {
      weakList.push(`${topic.icon} ${topic.name} (${pct}%)`);
      if (tab) tab.classList.add('weak');
    } else if (tab) {
      tab.classList.remove('weak');
    }
  });

  if (weakList.length > 0) {
    radar.classList.add('show');
    document.getElementById('weak-topics-list').textContent = weakList.join(' · ');
  } else {
    radar.classList.remove('show');
  }
}

/* ══════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════ */
function navigate(dir) {
  const qs = getFilteredQuestions();
  currentIndex = Math.max(0, Math.min(qs.length - 1, currentIndex + dir));
  renderQuestion(qs);
  if (timerMode === 'per-question') resetPerQuestionTimer();
  saveProgress();
}

function updateProgressBar(qs) {
  const answered = qs.filter(q => answers[q.id] !== undefined).length;
  const pct      = qs.length ? Math.round((answered / qs.length) * 100) : 0;
  document.getElementById('prog-label').textContent = `Question ${qs.length ? currentIndex + 1 : 0} of ${qs.length}`;
  document.getElementById('prog-pct').textContent   = pct + '% answered';
  document.getElementById('prog-fill').style.width  = pct + '%';
  document.getElementById('nav-counter').textContent = `${answered} / ${qs.length} answered`;
}

function updateNavButtons(qs) {
  document.getElementById('btn-prev').disabled = currentIndex <= 0;
  document.getElementById('btn-next').disabled = currentIndex >= qs.length - 1;
}

function modalOpen() {
  return document.getElementById('modal').style.display !== 'none';
}

function handleKeyboardShortcuts(e) {
  if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
  if (e.altKey) return;
  if (modalOpen()) { if (e.key === 'Escape') closeModal(); return; }
  if (document.getElementById('quiz-screen').style.display === 'none') return;

  const qs = getFilteredQuestions();
  if (!qs.length) return;
  const q = qs[currentIndex];
  if (!q) return;

  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'Enter') requestFinish();
    return;
  }
  if (['a','b','c','d'].includes(key)) {
    const index = LETTERS.indexOf(key.toUpperCase());
    if (index >= 0) selectAnswer(q.id, index, q.shuffledAnswer);
  }
  if (key === 'arrowright' || key === 'l') navigate(1);
  if (key === 'arrowleft'  || key === 'h') navigate(-1);
  if (key === 'f') toggleBookmark(q.id);

  try {
    if (!localStorage.getItem('kb_hints_shown')) {
      showToast('Tip: A/B/C/D to answer · ← → to navigate · F to flag');
      localStorage.setItem('kb_hints_shown', '1');
    }
  } catch (err) {}
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3600);
}

window.addEventListener('keydown', handleKeyboardShortcuts);
window.addEventListener('beforeunload', saveProgress);

/* ══════════════════════════════════════════
   STATS
══════════════════════════════════════════ */
function updateStats() {
  const total    = displayQuestions.length;
  const answered = displayQuestions.filter(q => answers[q.id] !== undefined);
  const correct  = answered.filter(q => answers[q.id] === q.shuffledAnswer).length;
  const wrong    = answered.length - correct;
  const pct      = answered.length ? Math.round((correct / answered.length) * 100) : 0;

  if (mode === 'exam') {            // results stay hidden until submission
    document.getElementById('stat-score').textContent   = '—';
    document.getElementById('stat-correct').textContent = '—';
    document.getElementById('stat-wrong').textContent   = '—';
  } else {
    document.getElementById('stat-score').textContent   = pct + '%';
    document.getElementById('stat-correct').textContent = correct;
    document.getElementById('stat-wrong').textContent   = wrong;
  }
  document.getElementById('stat-remaining').textContent = total - answered.length;
}

/* ══════════════════════════════════════════
   MODE
══════════════════════════════════════════ */
function setMode(m) {
  mode = m;
  syncModeButtons();
  renderAll();
  saveProgress();
}

/* ══════════════════════════════════════════
   SUBMIT CONFIRMATION
══════════════════════════════════════════ */
function requestFinish() {
  const unanswered = displayQuestions.filter(q => answers[q.id] === undefined).length;
  const body = document.getElementById('modal-body');
  body.textContent = unanswered > 0
    ? `You still have ${unanswered} unanswered question${unanswered === 1 ? '' : 's'}. Unanswered items count as incorrect.`
    : 'You have answered every question. Ready to see your results?';
  document.getElementById('modal').style.display = 'grid';
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

function confirmFinish() {
  closeModal();
  finishQuiz();
}

/* ══════════════════════════════════════════
   FINISH & RESULTS
══════════════════════════════════════════ */
async function finishQuiz() {
  stopTimer();
  clearSavedProgress();
  const total   = displayQuestions.length;
  const correct = displayQuestions.filter(q => answers[q.id] === q.shuffledAnswer).length;
  const pct     = total ? Math.round((correct / total) * 100) : 0;

  let rating = '';
  if (pct >= 80)      rating = '🏆 Excellent! You\'re ready for the CSE!';
  else if (pct >= 60) rating = '👍 Good job! Keep reviewing.';
  else if (pct >= 40) rating = '📖 Keep practicing — you\'re getting there!';
  else                rating = '💪 More review needed. Don\'t give up!';

  const ringColor = pct >= PASS_MARK ? 'var(--success)' : pct >= 60 ? 'var(--accent)' : pct >= 40 ? 'var(--warning)' : 'var(--danger)';
  const ring = document.getElementById('score-ring');
  ring.style.setProperty('--ring', ringColor);
  ring.style.setProperty('--pct', '0');
  requestAnimationFrame(() => requestAnimationFrame(() => ring.style.setProperty('--pct', pct)));

  document.getElementById('res-score').textContent    = pct + '%';
  document.getElementById('res-fraction').textContent = `${correct} / ${total} correct`;
  document.getElementById('res-rating').textContent   = rating;

  const chip = document.getElementById('pass-chip');
  const passed = pct >= PASS_MARK;
  chip.className = 'pass-chip ' + (passed ? 'pass' : 'fail');
  chip.textContent = passed ? `✓ Above the ${PASS_MARK}% passing mark` : `Below the ${PASS_MARK}% passing mark`;

  const breakdown = document.getElementById('res-breakdown');
  breakdown.innerHTML = topics.map(t => {
    const qs      = displayQuestions.filter(q => q.topicId === t.id);
    if (!qs.length) return '';
    const catCorr = qs.filter(q => answers[q.id] === q.shuffledAnswer).length;
    const catPct  = Math.round((catCorr / qs.length) * 100);
    const col     = CAT_COLORS[t.id] || '#8b91a8';
    return `<div class="breakdown-item">
      <div class="b-score" style="color:${col}">${catPct}%</div>
      <div class="b-label">${escHtml(t.icon)} ${escHtml(t.name)}</div>
      <div class="b-frac">${catCorr}/${qs.length}</div>
    </div>`;
  }).join('');

  buildWrongReview();

  const wrongQs = displayQuestions.filter(q =>
    answers[q.id] !== undefined && answers[q.id] !== q.shuffledAnswer
  );
  document.getElementById('btn-retry-wrong').style.display = wrongQs.length > 0 ? 'inline-flex' : 'none';

  document.getElementById('quiz-screen').style.display    = 'none';
  document.getElementById('results-screen').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Save score (skip for retry sessions)
  const logEl = document.getElementById('log-status');
  if (isRetryMode) { logEl.className = 'log-status'; logEl.textContent = 'Retry sessions are not added to the score log.'; return; }

  logEl.className = 'log-status saving';
  logEl.textContent = 'Saving your score…';
  try {
    if (!csrfToken) await loadCsrfToken();
    const payload = { username: currentUsername, score_pct: pct, correct, total, mode, token: csrfToken };
    let resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let json = await resp.json();
    if (!json.success && /token/i.test(json.error || '')) {   // token is hour-based: refresh once and retry
      await loadCsrfToken();
      payload.token = csrfToken;
      resp = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      json = await resp.json();
    }
    if (json.success) {
      logEl.className = 'log-status ok';
      logEl.textContent = '✓ Score saved to the score log!';
    } else {
      logEl.className = 'log-status err';
      logEl.textContent = '⚠️ Score not saved: ' + (json.error || 'unknown error');
    }
  } catch(e) {
    logEl.className = 'log-status err';
    logEl.textContent = '⚠️ Could not reach api.php — score not saved.';
  }
}

/* ══════════════════════════════════════════
   WRONG ANSWER REVIEW
══════════════════════════════════════════ */
function buildWrongReview() {
  const wrongQs   = displayQuestions.filter(q =>
    answers[q.id] !== undefined && answers[q.id] !== q.shuffledAnswer
  );
  const container = document.getElementById('wrong-review');
  const listEl    = document.getElementById('wrong-review-list');

  if (wrongQs.length === 0) {
    container.style.display = 'none';
    return;
  }

  listEl.innerHTML = wrongQs.map((q, i) => {
    const yourChoice    = q.shuffledChoices[answers[q.id]];
    const correctChoice = q.shuffledChoices[q.shuffledAnswer];
    const col           = q.topicColor || CAT_COLORS[q.topicId] || '#8b91a8';
    return `
      <div class="wrong-review-card">
        <div class="q-meta" style="margin-bottom:0.6rem">
          <span class="q-num">Wrong #${i+1}</span>
          <span class="q-cat-pill" style="background:${col}22;color:${col};border:1px solid ${col}55">${escHtml(q.topicName)}</span>
        </div>
        <div class="q-text">${escHtml(q.question)}</div>
        <div class="review-label" style="color:var(--danger)">Your answer</div>
        <div class="review-answer your-answer">✗ ${escHtml(yourChoice)}</div>
        <div class="review-label" style="color:var(--success)">Correct answer</div>
        <div class="review-answer correct-answer">✓ ${escHtml(correctChoice)}</div>
        <div class="review-explanation"><strong>Explanation:</strong> ${escHtml(q.explanation)}</div>
      </div>
    `;
  }).join('');

  container.style.display = 'block';
  listEl.style.display = 'none';
  const btn = document.getElementById('btn-toggle-review');
  if (btn) btn.textContent = '▼ Show wrong answers';
}

function toggleWrongReview() {
  const list = document.getElementById('wrong-review-list');
  const btn  = document.getElementById('btn-toggle-review');
  const hidden = list.style.display === 'none';
  list.style.display = hidden ? 'block' : 'none';
  btn.textContent = hidden ? '▲ Hide wrong answers' : '▼ Show wrong answers';
}

/* ══════════════════════════════════════════
   RETRY WRONG
══════════════════════════════════════════ */
function retryWrongAnswers() {
  const wrongQs = displayQuestions.filter(q =>
    answers[q.id] !== undefined && answers[q.id] !== q.shuffledAnswer
  );
  if (wrongQs.length === 0) return;

  document.getElementById('results-screen').style.display = 'none';
  document.getElementById('wrong-review').style.display   = 'none';
  document.getElementById('log-status').textContent       = '';

  const enriched = wrongQs.map(q => ({
    ...q,
    topicColor: q.topicColor || CAT_COLORS[q.topicId] || '#8b91a8',
    topicName:  q.topicName  || q.topicId
  }));

  initQuiz(enriched);
  showSection('quiz');
}

/* ══════════════════════════════════════════
   RESTART
══════════════════════════════════════════ */
function restartQuiz() {
  stopTimer();
  clearSavedProgress();
  document.getElementById('results-screen').style.display = 'none';
  document.getElementById('wrong-review').style.display   = 'none';
  document.getElementById('log-status').textContent       = '';
  initQuiz();
  showSection('quiz');
}

/* ══════════════════════════════════════════
   LEADERBOARD
══════════════════════════════════════════ */
async function loadLeaderboard() {
  document.getElementById('lb-content').innerHTML = '<div class="lb-loading">Loading scores…</div>';
  try {
    const resp = await fetch(API_URL + '?action=scores');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    if (json.data && json.data.csrf_token) {
      csrfToken = json.data.csrf_token;
    }
    const rows = Array.isArray(json.data) ? json.data : (json.data.scores || []);
    renderLeaderboard(rows);
  } catch(e) {
    document.getElementById('lb-content').innerHTML =
      `<div class="lb-empty">⚠️ Could not load scores.<br><small>${escHtml(e.message)}</small></div>`;
  }
}

function renderLeaderboard(rows) {
  if (!rows || rows.length === 0) {
    document.getElementById('lb-content').innerHTML =
      '<div class="lb-empty">No scores yet. Complete a quiz to be the first!</div>';
    return;
  }
  const rankClass  = i => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
  const scoreClass = p => p >= 80 ? 'high' : p >= 50 ? 'mid' : 'low';
  const me         = (currentUsername || '').toLowerCase();
  const rows_html  = rows.map((r, i) => {
    const mine = me && String(r.username).toLowerCase() === me;
    return `
    <tr class="${mine ? 'me' : ''}">
      <td><span class="rank-badge ${rankClass(i)}">${i+1}</span></td>
      <td><strong>${escHtml(r.username)}</strong>${mine ? '<span class="you-tag">YOU</span>' : ''}</td>
      <td><span class="score-pill ${scoreClass(r.score_pct)}">${Number(r.score_pct)}%</span></td>
      <td>${Number(r.correct)} / ${Number(r.total)}</td>
      <td style="color:var(--muted)">${r.mode === 'exam' ? '🎯 Exam' : '📖 Practice'}</td>
      <td style="color:var(--muted);font-size:0.8rem">${escHtml(formatDate(r.taken_at))}</td>
    </tr>`;
  }).join('');
  document.getElementById('lb-content').innerHTML = `
    <div class="lb-wrap">
      <table class="lb-table">
        <thead><tr><th>#</th><th>Username</th><th>Score</th><th>Correct</th><th>Mode</th><th>Date</th></tr></thead>
        <tbody>${rows_html}</tbody>
      </table>
    </div>
    <p class="lb-note">Top 50 attempts · sorted by score</p>
  `;
}
