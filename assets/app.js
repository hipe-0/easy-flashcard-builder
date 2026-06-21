'use strict';

const SCHEMA_VERSION = '1.0.0';
const DAY_MS = 86400000;
const GRADES = Object.freeze({ NoIdea: 0, Vague: 1, Almost: 2, Hard: 3, Good: 4, Easy: 5 });
const SM2 = Object.freeze({
  MIN_EASE: 1.3,
  MAX_EASE: 2.5,
  DEFAULT_EASE: 2.5,
  INITIAL_INTERVAL: 1,
  GRADUATING_INTERVAL: 6,
});

// ===== DATA STRUCTURES =====
//
// CARD (one element of the `cards[]` array, identified by array index)
//   {
//     question: string,    // front-of-card text from CSV
//     answer: string,      // back-of-card text from CSV
//     ease: number,        // SM-2 easiness factor, starts at 2.5, min 1.3
//     intervalDaysUntilNextReview: number, // days until next review (0 = first-time card)
//     repetitionsOfSuccess: number,        // consecutive correct answers (0 = never seen or last answer was No Idea)
//     dueDateOfNextReview: number,         // day number (today()) when this card becomes due
//     lapsesOfFailed: number,              // total times card was answered incorrectly (grade < 3)
//     lastReview: number|null, // day number of most recent review, null = never seen
//     lastGrade: number|null,  // 0|1|2|3|4|5 grade from last review, null = never seen
//     _bonus: boolean,         // true when pulled in via addMoreCards (extra cards on complete)
//   }
//
// STATS (persistent across sessions, lives in localStorage)
//   {
//     totalReviews: number,      // lifetime count of graded reviews
//     streakDays: number,        // consecutive days studied
//     lastStudyDate: number|null,// day number of most recent study session
//     newCountToday: number,     // new cards seen today (grade >= 3)
//     dueCountToday: number,     // due cards seen today (first review of each)
//     lastDay: number|null,      // day counter-last-reset (used for new-day detection)
//   }
//
// SETTINGS (persistent)
//   { darkMode: 'auto' | 'light' | 'dark' }
//
// META (persistent)
//   { created: number, version: string, csvHash: string|null }
//
// SESSION (in-memory only, created by initDrillSession)
//   {
//     queue: { id: number, availableAt: number }[], // FIFO work queue
//     current: number|null,   // card index currently displayed
//     counts: { reviewed: number },
//     startedAt: number,      // Date.now() when session began
//     resolvedIds: Set,       // card indices that reached Easy or Good resolution
//     totalCards: number,     // total cards in this session
//   }
//
// ===== DATA FLOW =====
// ENTERS DrillEngine via constructor: config (from config.json), state
//   (from localStorage containing cards[], stats, settings, meta).
// EXITS DrillEngine via getState(): { cards, stats, settings, meta } —
//   serialised to localStorage after every grade and on session end.
// INTERNALLY the engine also holds:
//   - this.session     — alive only during a study/rehearse session
//   - this.rehearseMode — if true, SM-2 scheduling is skipped
//   - this._corrupted   — set when localStorage data was unreadable
//
// ===== GRADE SYSTEM =====
//   Grade | Label       | Meaning                                          | SM-2  | Session | Delay
//   ------|-------------|--------------------------------------------------|-------|---------|------
//   0     | No Idea     | Complete blackout, never seen or completely blanked | fail  | re-queue|  60s
//   1     | Vague       | Familiar feeling, couldn't produce the answer      | fail  | re-queue|  60s
//   2     | Almost      | Tip of the tongue, nearly got it right           | fail  | re-queue|  30s
//   3     | Hard        | Correct but difficult, required effort           | pass  | re-queue| 180s
//   4     | Good        | Correct, normal recall                           | pass  | resolve |   —
//   5     | Easy        | Correct, effortless, instant recall              | pass  | resolve |   —
//   Grades < 3 are SM-2 failures (repetitions reset, EF ↓, lapses++).
//   Grades >= 3 are SM-2 passes (repetitions advance, interval grows).
//   Grades >= 4 resolve the card in the session (not re-queued).

const appState = {
  config: null,
  cards: [],
  csvHash: null,
  engine: null,
};

// === HELPERS ===
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function today() { return Math.floor(Date.now() / DAY_MS); }
function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes + 'm ' + seconds + 's';
}

// === STORAGE (Phase 3) ===
function key(name) {
  const prefix = (appState.config && appState.config.storageKeyPrefix) || 'fc_';
  return prefix + name;
}
function loadJSON(name, fallback) {
  try {
    const raw = localStorage.getItem(key(name));
    if (raw == null) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) && fallback && !Array.isArray(fallback)) {
      return { __corrupted: true, __raw: raw };
    }
    if (Array.isArray(fallback) && !Array.isArray(parsed) && typeof parsed === 'object') {
      return { __corrupted: true, __raw: raw };
    }
    return parsed;
  } catch (_) {
    return { __corrupted: true, __raw: null };
  }
}
function saveJSON(name, value) {
  try {
    localStorage.setItem(key(name), JSON.stringify(value));
  } catch (error) {
    if (error && (error.name === 'QuotaExceededError' || error.code === 22 || error.code === 1014)) {
      throw new Error('Storage quota exceeded. Try resetting progress.');
    }
    throw error;
  }
}
function defaultStats() {
  return { totalReviews: 0, streakDays: 0, lastStudyDate: null, newCountToday: 0, dueCountToday: 0, lastDay: null };
}
function defaultSettings() {
  return { darkMode: 'auto' };
}
function newMeta() {
  return { created: Date.now(), version: SCHEMA_VERSION, csvHash: appState.csvHash };
}
function loadState() {
  const cardsRaw = loadJSON('cards', []);
  const statsRaw = loadJSON('stats', null);
  const settingsRaw = loadJSON('settings', null);
  const metaRaw = loadJSON('meta', null);
  const isCorrupted = (cardsRaw && cardsRaw.__corrupted) ||
                      (statsRaw && statsRaw.__corrupted) ||
                      (settingsRaw && settingsRaw.__corrupted) ||
                      (metaRaw && metaRaw.__corrupted);
  if (isCorrupted) {
    return {
      cards: [],
      stats: defaultStats(),
      settings: defaultSettings(),
      meta: newMeta(),
      _corrupted: true,
    };
  }
  return {
    cards: Array.isArray(cardsRaw) ? cardsRaw : [],
    stats: statsRaw && typeof statsRaw.totalReviews === 'number' ? statsRaw : defaultStats(),
    settings: settingsRaw && typeof settingsRaw.darkMode === 'string' ? settingsRaw : defaultSettings(),
    meta: (metaRaw && typeof metaRaw === 'object') ? metaRaw : null,
    _corrupted: false,
  };
}
function saveState(state) {
  saveJSON('cards', state.cards);
  saveJSON('stats', state.stats);
  saveJSON('settings', state.settings);
  saveJSON('meta', state.meta);
}


// === LOADERS (Phase 2) ===
async function loadConfig() {
  let response;
  try {
    response = await fetch('config.json', { cache: 'no-store' });
  } catch (_) {
    throw new Error("Config file not found. Create `config.json` from `config.example.json`");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Config file not found. Create `config.json` from `config.example.json`");
    }
    throw new Error('Config file error (HTTP ' + response.status + ').');
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = String(error.message || '');
    const lineMatch = message.match(/position\s+(\d+)/);
    let lineInfo = message;
    if (lineMatch) {
      const pos = parseInt(lineMatch[1], 10);
      const upto = text.slice(0, pos);
      const line = upto.split('\n').length;
      lineInfo = 'Line ' + line + ': ' + message;
    }
    throw new Error('Config is not valid JSON. ' + lineInfo);
  }
}
function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be a JSON object.');
  }
  const required = ['appId', 'deckTitle', 'dailyNewLimit', 'dailyDueCardsLimit', 'maxReviewsPerSession', 'storageKeyPrefix', 'colors'];
  for (const key of required) {
    if (!(key in config)) {
      throw new Error('Config is missing required field: "' + key + '"');
    }
  }
  if (typeof config.dailyNewLimit !== 'number' || config.dailyNewLimit < 0) {
    throw new Error('Config: dailyNewLimit must be a non-negative number.');
  }
  if (typeof config.dailyDueCardsLimit !== 'number' || config.dailyDueCardsLimit < 0) {
    throw new Error('Config: dailyDueCardsLimit must be a non-negative number.');
  }
  if (typeof config.maxReviewsPerSession !== 'number' || config.maxReviewsPerSession < 1) {
    throw new Error('Config: maxReviewsPerSession must be a positive number.');
  }
  if (config.extraCardsOnComplete !== undefined && (typeof config.extraCardsOnComplete !== 'number' || config.extraCardsOnComplete < 1)) {
    throw new Error('Config: extraCardsOnComplete must be a positive number.');
  }
  if (!config.colors || typeof config.colors !== 'object') {
    throw new Error('Config: colors must be an object.');
  }
}
async function loadCards() {
  let response;
  try {
    response = await fetch('cards.csv', { cache: 'no-store' });
  } catch (_) {
    throw new Error("Card file not found. Create `cards.csv` with headers: `Question,Answer`");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Card file not found. Create `cards.csv` with headers: `Question,Answer`");
    }
    throw new Error('Card file error (HTTP ' + response.status + ').');
  }
  return await response.text();
}
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length < 2 || !lines[0].trim()) {
    throw new Error('CSV must have a header row and at least one card.');
  }
  const headers = lines[0].split(',').map(header => header.trim().replace(/^"|"$/g, ''));
  if (headers[0] !== 'Question' || headers[1] !== 'Answer') {
    throw new Error('CSV headers must be: Question,Answer (got: ' + headers.join(',') + ')');
  }
  const cards = [];
  lines.slice(1).forEach((line, i) => {
    if (!line.trim()) {
      return;
    }
    const cols = [];
    let currentField = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (char === ',' && !inQuotes) {
        cols.push(currentField);
        currentField = '';
        continue;
      }
      currentField += char;
    }
    cols.push(currentField);
    if (cols.length !== 2) {
      throw new Error('Line ' + (i + 2) + ': expected 2 columns, got ' + cols.length);
    }
    cards.push({ question: cols[0], answer: cols[1] });
  });
  return cards;
}
async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// === DRILL ENGINE ===
// Central state machine that owns the card array, daily stats, and the
// active study session. The UI layer (renderSplash, nextCard, gradeCurrent)
// reads from and delegates to this class. Everything persistent flows
// through getState()/constructor; everything ephemeral flows through
// session/rehearseMode.
class DrillEngine {
  // INPUT:  config (from config.json) + state (from localStorage saveState).
  // OUTPUT: an engine ready to computeSplashStats or start a session.
  // The cards, stats, settings, meta are all passed in on construction
  // and written back via getState().
  constructor(config, state = {}) {
    this.config = config;
    this.cards = state.cards || [];
    this.stats = state.stats || defaultStats();
    this.settings = state.settings || defaultSettings();
    this.meta = state.meta || newMeta();
    this._corrupted = !!state._corrupted;
    this.session = null;
    this.rehearseMode = false;
  }

  // OUTPUT for localStorage: extracts the four persisted buckets from
  // the engine so they can be saved and reconstructed later.
  getState() {
    return { cards: this.cards, stats: this.stats, settings: this.settings, meta: this.meta };
  }

  // Creates a fresh card record with SM-2 defaults. Used when resetting
  // progress or when a CSV change wipes the deck.
  // Fields: see the CARD data structure at top of file.
  static initCard() {
    return { ease: SM2.DEFAULT_EASE, intervalDaysUntilNextReview: 0, repetitionsOfSuccess: 0, dueDateOfNextReview: today(), lapsesOfFailed: 0, lastReview: null, lastGrade: null, _bonus: false };
  }

  static freshCounts() {
    return { reviewed: 0 };
  }

  /**
   * Applies the SM-2 spaced repetition algorithm to a card based on the
   * given grade. Grades < 3 reset the card; grades >= 3 advance it.
   * @param {Object} card
   * @param {number} grade  0 (No Idea), 1 (Vague), 2 (Almost), 3 (Hard), 4 (Good), or 5 (Easy)
   * @return {Object} the mutated card
   */
  applySM2(card, grade) {
    const todayValue = today();
    if (grade < 3) {
      card.repetitionsOfSuccess = 0;
      card.intervalDaysUntilNextReview = SM2.INITIAL_INTERVAL;
      card.lapsesOfFailed = (card.lapsesOfFailed || 0) + 1;
    } else {
      if (card.repetitionsOfSuccess === 0) {
        card.intervalDaysUntilNextReview = SM2.INITIAL_INTERVAL;
      } else if (card.repetitionsOfSuccess === 1) {
        card.intervalDaysUntilNextReview = SM2.GRADUATING_INTERVAL;
      } else {
        card.intervalDaysUntilNextReview = Math.round(card.intervalDaysUntilNextReview * card.ease);
      }
      card.repetitionsOfSuccess = (card.repetitionsOfSuccess || 0) + 1;
    }
    card.ease = Math.min(SM2.MAX_EASE, Math.max(SM2.MIN_EASE, card.ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))));
    card.dueDateOfNextReview = todayValue + card.intervalDaysUntilNextReview;
    card.lastReview = todayValue;
    card.lastGrade = grade;
    return card;
  }

  /**
   * Returns cards that have been seen before and whose due date is on or
   * before the given day, sorted oldest-due first.
   * @param {number} t  day number from today()
   * @return {Object[]}
   */
  getDueCards(t) {
    const indices = [];
    this.cards.forEach((card, i) => {
      if (card.lastReview !== null && card.dueDateOfNextReview <= t) {
        indices.push(i);
      }
    });
    return indices.sort((a, b) => this.cards[a].dueDateOfNextReview - this.cards[b].dueDateOfNextReview);
  }

  /**
   * Returns up to `limit` cards that have never been seen (repetitionsOfSuccess === 0,
   * no lastReview).
   * @param {number} limit
   * @return {Object[]}
   */
  getNewCards(limit) {
    const indices = [];
    this.cards.forEach((card, i) => {
      if (card.repetitionsOfSuccess === 0 && card.lastReview === null && !card._bonus) {
        indices.push(i);
      }
    });
    return indices.slice(0, limit);
  }

  /**
   * Summarises every card's state for today by inspecting lastReview and
   * lastGrade. The single source of truth for both the splash screen and
   * session queue building.
   * @return {{workIds: number[], workCount: number, doneCount: number,
   *           failedCount: number, dueCount: number, newCount: number,
   *           newLeft: number}}
   */
  // === CARD LIFECYCLE ===
  // Each card starts as "new" (repetitionsOfSuccess === 0, lastReview === null).
  // When reviewed today with grade >= 4 (Good+), it is "done" for the day.
  // When reviewed today with grade < 4 (No Idea/Hard), it is "failed" and
  //   gets re-queued immediately.
  // Cards due by SRS (lastReview !== null && due <= today) appear as "due"
  //   unless already done today.
  //
  // This method produces three lists of IDs and merges them into workIds:
  //   1. failedIds   — cards reviewed today with grade < 4
  //   2. dueIds      — SRS-due cards not yet done, capped by dailyDueCardsLimit - dueCountToday
  //   3. newIds      — never-seen cards, capped by dailyNewLimit - newCountToday
  // Duplicates across categories are collapsed via a Set.
  getTodayCardSummary() {
    const t = today();
    const doneIds = new Set();
    const failedSet = new Set();
    let reviewedCount = 0;
    this.cards.forEach((card, i) => {
      if (card.lastReview !== t) {
        return;
      }
      reviewedCount++;
      if ((card.lastGrade || 0) >= 4) {
        doneIds.add(i);
      } else {
        failedSet.add(i);
      }
    });
    const failedIds = [...failedSet];
    const dueIndices = this.getDueCards(t).filter(i => !doneIds.has(i));
    const dueLimit = Math.max(0, this.config.dailyDueCardsLimit - (this.stats.dueCountToday || 0));
    const dueIds = dueIndices.slice(0, dueLimit);
    const newLeft = Math.max(0, this.config.dailyNewLimit - (this.stats.newCountToday || 0));
    const newIds = this.getNewCards(newLeft);
    const seen = new Set();
    const workIds = [];
    [...failedIds, ...dueIds, ...newIds].forEach(id => {
      if (!seen.has(id)) {
        seen.add(id);
        workIds.push(id);
      }
    });
    return { workIds, workCount: workIds.length, doneCount: doneIds.size, failedCount: failedIds.length, dueCount: dueIds.length, newCount: newIds.length, newLeft, reviewedCount };
  }
  enqueueItem(queue, id, availableAt) {
    queue.push({ id, availableAt: availableAt || Date.now() });
  }

  // Builds an in-memory session object. The session holds the queue of
  // card IDs, a resolved-IDs set, accumulated counts, and timers.
  // It does NOT touch localStorage — that happens only when the caller
  // saves after each grade.
  // Fields: see the SESSION data structure at top of file.
  initDrillSession(cardIds) {
    const queue = [];
    const now = Date.now();
    cardIds.forEach(id => {
      this.enqueueItem(queue, id, now);
    });
    this.session = {
      queue,
      current: null,
      counts: DrillEngine.freshCounts(),
      startedAt: now,
      resolvedIds: new Set(),
      totalCards: cardIds.length,
    };
  }

  /**
   * @return {number}  maximum reviews allowed per session
   */
  sessionMaxReviews() {
    return (this.config && this.config.maxReviewsPerSession) || 100;
  }

  /**
   * @return {boolean}  true when all cards resolved or review limit reached
   */
  shouldEndSession() {
    if (!this.session) {
      return true;
    }
    if (this.session.resolvedIds.size >= this.session.totalCards) {
      return true;
    }
    if (this.session.counts.reviewed >= this.sessionMaxReviews()) {
      return true;
    }
    return false;
  }

  /**
   * Dequeues the next card from the session queue, skipping any that
   * have already been resolved. Returns null when the session should end.
   * @return {{card: Object}|null}
   */
  getNextCard() {
    if (this.shouldEndSession()) return null;

    const now = Date.now();
    const waiting = [];

    // Phase 1: return the first card past its delay window
    while (this.session.queue.length > 0) {
      const entry = this.session.queue.shift();
      const card = this.cards[entry.id];
      if (!card || this.session.resolvedIds.has(entry.id)) continue;

      if (entry.availableAt <= now) {
        this.session.queue.push(...waiting);
        return { card, id: entry.id };
      }

      waiting.push({ card, entry });
    }

    // Phase 2: all delayed — show one to keep moving until resolved or max reviews
    if (waiting.length > 0) {
      const { card, entry } = waiting.shift();
      this.session.queue.push(...waiting);
      return { card, id: entry.id };
    }

    return null;
  }

  // Records a grade, applies SM-2 scheduling (unless in rehearsal mode),
  // manages session resolution (resolvedIds, re-queue), and updates
  // persistent daily stats.
  // Side-effects:
  //   - resolvedIds / queue managed per grade (grade >= 4 = resolved, else re-queued)
  //   - card SM-2 fields mutated (ease, intervalDaysUntilNextReview, repetitionsOfSuccess, dueDateOfNextReview, etc.)
  //   - stats.newCountToday / dueCountToday / totalReviews / streakDays updated
  //   - stats.lastStudyDate / lastDay updated to today
  recordGrade(cardId, grade) {
    const card = this.cards[cardId];
    if (!card) {
      return;
    }
    const wasNew = card.repetitionsOfSuccess === 0 && card.lastReview === null;
    const wasReviewedToday = card.lastReview === today();

    if (!this.rehearseMode) {
      this.applySM2(card, grade);
      this.cards[cardId] = card;
    }

    this.session.counts.reviewed++;

    // Resolution and re-queue logic
    // Easy and Good resolve the card (removed from queue).
    // Hard, Almost, Vague, and No Idea get re-queued until grade >= 4.
    if (grade >= GRADES.Good) {
      this.session.resolvedIds.add(cardId);
    } else {
      const TIMING_KEY = {
        [GRADES.NoIdea]: 'noidea',
        [GRADES.Vague]: 'vague',
        [GRADES.Almost]: 'almost',
        [GRADES.Hard]: 'hard',
        [GRADES.Good]: 'good',
        [GRADES.Easy]: 'easy',
      };
      const delay = (this.config.gradeTimings && this.config.gradeTimings[TIMING_KEY[grade]]) || 0;
      this.enqueueItem(this.session.queue, cardId, Date.now() + delay * 1000);
    }

    if (!this.rehearseMode) {
      if (wasNew && grade >= 3) {
        this.stats.newCountToday = (this.stats.newCountToday || 0) + 1;
      }
      if (!wasNew && !wasReviewedToday) {
        this.stats.dueCountToday = (this.stats.dueCountToday || 0) + 1;
      }
      this.stats.totalReviews++;
      const todayValue = today();
      const last = this.stats.lastStudyDate;
      if (last === todayValue) {
        // already counted today
      } else if (last === todayValue - 1) {
        this.stats.streakDays = (this.stats.streakDays || 0) + 1;
      } else {
        this.stats.streakDays = 1;
      }
      this.stats.lastStudyDate = todayValue;
      this.stats.lastDay = todayValue;
    }
  }

  /**
   * Determines the splash-screen state and progress counters from today's
   * card summary. Used only for display; does not mutate anything.
   * @return {{state: string, completedPct: number, remaining: number,
   *           streak: number, totalReviews: number, canStart: boolean,
   *           reviewedExists: boolean, newLeft: number, reviewedToday: number,
   *           todayTotal: number, overallReviewed: number, overallTotal: number,
   *           overallPct: number}}
   */
  // Derives the four splash states from today's card summary.
  // States:
  //   'not_started' — no work done today; canStart=true if cards exist
  //   'interrupted' — some reviewed today, more remaining
  //   'completed'   — all today's cards reviewed (any grade)
  //   (plus deckMastered when overallPct === 100, handled by StatusMessageManager)
  // Also computes today's progress %, overall deck completion %,
  // streak, and whether any reviewed cards exist (for rehearsal button).
  computeSplashStats() {
    const cardSummary = this.getTodayCardSummary();
    const streak = this.stats.streakDays || 0;
    const reviewedExists = this.cards.some(card => card.lastReview !== null);
    const todayTotal = cardSummary.doneCount + cardSummary.workCount;
    const completedPct = todayTotal > 0 ? Math.round((cardSummary.reviewedCount / todayTotal) * 100) : 0;
    let state, canStart = false;
    if (cardSummary.reviewedCount >= todayTotal && todayTotal > 0) {
      state = 'completed';
      canStart = reviewedExists;
    } else if (cardSummary.workCount > 0) {
      state = cardSummary.reviewedCount > 0 ? 'interrupted' : 'not_started';
      canStart = true;
    } else {
      state = 'not_started';
    }
    const overallReviewed = this.cards.filter(card => (card.lastGrade || 0) >= 4).length;
    const overallTotal = this.cards.length;
    const overallPct = overallTotal > 0 ? Math.round((overallReviewed / overallTotal) * 100) : 0;
    return { state, completedPct, remaining: cardSummary.workCount, streak, totalReviews: this.stats.totalReviews, canStart, reviewedExists, newLeft: cardSummary.newLeft, reviewedToday: cardSummary.reviewedCount, todayTotal, overallReviewed, overallTotal, overallPct };
  }

  resetProgress(cardCount) {
    this.cards = Array.from({ length: cardCount }, () => DrillEngine.initCard());
    this.stats.newCountToday = 0;
    this.stats.dueCountToday = 0;
    this.stats.streakDays = 0;
    this.stats.lastDay = today();
    this.meta = newMeta();
    this._corrupted = false;
    this._justReset = true;
  }

  migrateState(csvHash, cardCount) {
    const def = defaultStats();
    for (const key of Object.keys(def)) {
      if (!(key in this.stats)) {
        this.stats[key] = def[key];
      }
    }
    if (!this.meta || this.meta.csvHash !== csvHash || this.cards.length !== cardCount) {
      this.cards = Array.from({ length: cardCount }, () => DrillEngine.initCard());
      this.meta = Object.assign({}, newMeta(), { created: (this.meta && this.meta.created) || Date.now() });
    }
    const todayValue = today();
    if (this.stats.lastDay !== todayValue) {
      this._isNewDay = true;
      this.stats.newCountToday = 0;
      this.stats.dueCountToday = 0;
      this.stats.lastDay = todayValue;
    }
  }
}

// === STATUS MESSAGE MANAGER ===
// Provides context-aware status text for the splash screen, chosen
// randomly from 3 variants per context. Also owns the typewriter
// animation timer (one per manager instance).
class StatusMessageManager {
  constructor() {
    this._animTimer = null;
  }

  static get MESSAGES() {
    return {
      welcomeFirst: [
        '\uD83D\uDC4B Welcome to Flashcards! Ready to learn your first cards?',
        '\uD83C\uDF1F Let\u2019s get started! Your deck of {n} cards is waiting.',
        '\uD83C\uDFAF New here? Let\u2019s dive into your first study session!',
      ],
      welcomeReset: [
        '\uD83D\uDD04 Fresh start! All progress has been reset.',
        '\u2728 Clean slate! Ready to begin again?',
        '\uD83D\uDDD1\uFE0F Progress cleared! Time to build a new streak.',
      ],
      welcomeBack: [
        '\uD83D\uDE80 Welcome back! {n} cards to study today.',
        '\uD83D\uDC4B Good to see you! You have {n} cards waiting.',
        '\uD83D\uDCDA Ready to study? {n} cards are due today.',
      ],
      notStarted: [
        'Your today\u2019s deck: {n} cards ({new} new)',
        'You have {n} cards to study today ({new} new)',
        '{n} cards waiting for you ({new} new to learn)',
      ],
      noCardsDue: [
        'No cards due \u2014 add more cards to get started.',
        'All caught up! No cards waiting today.',
        'Nothing to study right now \u2014 time to add more cards!',
      ],
      interrupted: [
        'Your today\u2019s deck: {n} cards remaining ({new} new)',
        'Keep going! {n} cards left ({new} new)',
        '{n} more cards to go ({new} new) \u2014 you\u2019ve got this!',
      ],
      allReviewed: [
        'All reviewed for today.',
        'You\u2019ve seen everything due today \u2014 nice work!',
        'All done for now! Great session.',
      ],
      todayComplete: [
        'Today\u2019s deck complete \u2014 You can continue tomorrow! \u2705',
        'You finished today\u2019s cards! Come back tomorrow for more cards? \u2705',
        'All today\u2019s cards done! More will await you tomorrow! \u2705',
      ],
      deckMastered: [
        '\uD83C\uDF89 Entire deck mastered! All cards complete! \uD83C\uDF89',
        '\uD83C\uDF1F You did it! Every card mastered! \uD83C\uDF1F',
        '\uD83C\uDFC6 100% complete! You\u2019ve mastered the whole deck! \uD83C\uDFC6',
      ],
    };
  }

  static _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // Picks the right message group based on splash state, with special
  // one-time overrides for first-ever visit, reset, and new-day detection.
  getMessage(engine) {
    const splashStats = engine.computeSplashStats();
    const stats = engine.stats;

    if (engine._justReset) {
      engine._justReset = false;
      return StatusMessageManager._pick(StatusMessageManager.MESSAGES.welcomeReset);
    }
    if (stats.totalReviews === 0 && stats.lastStudyDate === null) {
      return StatusMessageManager._pick(StatusMessageManager.MESSAGES.welcomeFirst)
        .replace('{n}', engine.cards.length);
    }
    if (engine._isNewDay) {
      engine._isNewDay = false;
      return StatusMessageManager._pick(StatusMessageManager.MESSAGES.welcomeBack)
        .replace('{n}', splashStats.remaining);
    }

    if (splashStats.state === 'not_started') {
      if (splashStats.canStart) {
        return StatusMessageManager._pick(StatusMessageManager.MESSAGES.notStarted)
          .replace('{n}', splashStats.remaining).replace('{new}', splashStats.newLeft);
      }
      return StatusMessageManager._pick(StatusMessageManager.MESSAGES.noCardsDue);
    }
    if (splashStats.state === 'interrupted') {
      if (splashStats.remaining > 0) {
        return StatusMessageManager._pick(StatusMessageManager.MESSAGES.interrupted)
          .replace('{n}', splashStats.remaining).replace('{new}', splashStats.newLeft);
      }
      return StatusMessageManager._pick(StatusMessageManager.MESSAGES.allReviewed);
    }
    if (splashStats.overallPct === 100) {
      return StatusMessageManager._pick(StatusMessageManager.MESSAGES.deckMastered);
    }
    return StatusMessageManager._pick(StatusMessageManager.MESSAGES.todayComplete);
  }

  typewrite(el, text, delay) {
    this.cancel();
    el.textContent = '';
    const chars = [...text];
    let i = 0;
    this._animTimer = setInterval(() => {
      if (i >= chars.length) {
        this.cancel();
        return;
      }
      el.textContent += chars[i];
      i++;
    }, delay || 30);
  }

  cancel() {
    if (this._animTimer) {
      clearInterval(this._animTimer);
      this._animTimer = null;
    }
  }
}

// === SPLASH SCREEN ===
// Reads computeSplashStats() + config + msgManager and populates the
// DOM: progress bars, card count, streak, status text, and button
// labels / visibility. Runs once at init and after every session end
// or progress reset.
function renderSplash() {
  const splashStats = appState.engine.computeSplashStats();
  document.getElementById('deck-title').textContent = appState.config.deckTitle;
  document.getElementById('splash-card-count').textContent = appState.cards.length;
  document.getElementById('footer-title').textContent = appState.config.appName || appState.config.deckTitle;
  document.getElementById('footer-version').textContent = appState.config.version ? 'v' + appState.config.version : 'v' + (appState.engine.meta.version || SCHEMA_VERSION);

  const corrupted = !!appState.engine._corrupted;
  document.getElementById('corrupted-msg').hidden = !corrupted;

  const progressFill = document.getElementById('progress-fill');
  const progressBar = document.querySelector('.progress-bar');
  progressFill.style.width = splashStats.completedPct + '%';
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', splashStats.completedPct);
  }

  document.getElementById('splash-progress-text').textContent = splashStats.reviewedToday + '/' + splashStats.todayTotal + ' cards';
  document.getElementById('splash-streak-text').textContent = splashStats.streak;
  document.getElementById('splash-completed-text').textContent = splashStats.overallPct + '% completed';
  const desc = document.getElementById('deck-description');
  if (appState.config.deckDescription) {
    desc.textContent = appState.config.deckDescription;
    desc.hidden = false;
  } else {
    desc.hidden = true;
  }

  const statusText = document.getElementById('splash-status-text');
  appState.msgManager.typewrite(statusText, appState.msgManager.getMessage(appState.engine));

  const start = document.getElementById('btn-start');
  start.hidden = corrupted || (!splashStats.canStart || splashStats.state === 'completed');
  start.className = 'btn btn-primary';
  if (splashStats.state === 'interrupted') {
    start.textContent = 'Resume Studying';
  } else {
    start.textContent = 'Start Studying';
  }
  document.getElementById('btn-settings-rehearse').disabled = !splashStats.reviewedExists;
  const hasUnseen = appState.engine.cards.some(card => card.lastReview === null && card.repetitionsOfSuccess === 0);
  document.getElementById('settings-add-more-section').hidden = !(splashStats.state === 'completed' && hasUnseen);
}
function openSettings() {
  document.getElementById('settings-backdrop').hidden = false;
  const firstBtn = document.querySelector('#settings-backdrop .btn, #settings-backdrop .btn-close-settings');
  if (firstBtn) {
    firstBtn.focus({ preventScroll: true });
  }
}
function closeSettings() {
  document.getElementById('settings-backdrop').hidden = true;
  const gear = document.getElementById('btn-settings');
  if (gear) {
    gear.focus({ preventScroll: true });
  }
}

// === STUDY SESSION ===
// Flow:
//   startSession() or start*Rehearsal()
//     → engine.initDrillSession(workIds)
//     → nextCard() → engine.getNextCard() → renderCardContent()
//     → user flips card → gradeCurrent(grade)
//     → engine.recordGrade() + saveState() + updateProgress() + nextCard()
//     → engine.shouldEndSession() → endSession() → back to splash

function startSession() {
  if (appState.engine._corrupted) {
    return;
  }
  appState.engine.rehearseMode = false;
  const { workIds } = appState.engine.getTodayCardSummary();
  appState.engine.initDrillSession(workIds);
  document.getElementById('rehearsal-badge').hidden = true;
  showView('study');
  if (workIds.length === 0) {
    endSession();
    return;
  }
  nextCard();
}
// Fisher-Yates shuffle (in-place, returns same array).
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// Rehearsal mode: shows unseen cards in random order, skipping SM-2.
function startNewCardRehearsal() {
  appState.engine.rehearseMode = true;
  const fresh = appState.engine.cards.map((card, i) => card.repetitionsOfSuccess === 0 && card.lastReview === null ? i : -1).filter(i => i !== -1);
  const ids = shuffleArray(fresh);
  appState.engine.initDrillSession(ids);
  document.getElementById('rehearsal-badge').hidden = false;
  showView('study');
  if (ids.length === 0) {
    endSession();
    return;
  }
  nextCard();
}
// Rehearsal mode: picks cards with lowest ease first (up to limit),
// then shuffles, then presents them without SM-2 scheduling.
function startAlreadyReviewedRehearsal() {
  const limit = appState.config.maxCardsToRehearse || 10;
  const ids = shuffleArray(
    appState.engine.cards
      .map((card, i) => ({ card, i }))
      .filter(({ card }) => card.lastReview !== null)
      .sort((a, b) => a.card.ease - b.card.ease)
      .slice(0, limit)
      .map(({ i }) => i)
  );
  if (ids.length === 0) {
    return;
  }
  appState.engine.rehearseMode = true;
  appState.engine.initDrillSession(ids);
  document.getElementById('rehearsal-badge').hidden = false;
  showView('study');
  nextCard();
}
// Pulls up to extraCardsOnComplete unseen cards into the work pool by
// backdating their lastReview and due so they appear as SRS-due.
function addMoreCards() {
  const limit = appState.config.extraCardsOnComplete || 5;
  const todayValue = today();
  const cards = appState.engine.cards;
  let added = 0;
  for (let i = 0; i < cards.length && added < limit; i++) {
    const card = cards[i];
    if (card.lastReview === null && card.repetitionsOfSuccess === 0 && !card._bonus) {
      card.lastReview = todayValue - 1;
      card.dueDateOfNextReview = todayValue - 1;
      card._bonus = true;
      added++;
    }
  }
  if (added === 0) {
    return;
  }
  // Create room in the due limit so these cards are not blocked
  appState.engine.stats.dueCountToday = Math.max(0, (appState.engine.stats.dueCountToday || 0) - added);
  saveState(appState.engine.getState());
  renderSplash();
}
function renderCardContent(id) {
  const data = appState.cards[id];
  const front = data ? data.question : '<em>(missing card content)</em>';
  const back = data ? data.answer : '<em>(missing card content)</em>';
  document.getElementById('card-front-content').innerHTML = '<span>' + front + '</span>';
  document.getElementById('card-back-question').innerHTML = '<span>' + front + '</span>';
  document.getElementById('card-back-answer').innerHTML = back;
}
function resetCardToFrontInstant() {
  const card = document.getElementById('card');
  card.classList.add('no-flip-transition');
  card.classList.remove('flipped');
  card.setAttribute('aria-label', 'Flashcard (press Space to flip)');
  document.getElementById('card-front').setAttribute('aria-hidden', 'false');
  document.getElementById('card-back').setAttribute('aria-hidden', 'true');
  const grades = document.getElementById('grades');
  grades.classList.add('hidden');
  document.getElementById('btn-show-answer').hidden = false;
  void card.offsetWidth;
  card.classList.remove('no-flip-transition');
}
function clearCardSwapVars(el) {
  el.style.removeProperty('--leave-rx');
  el.style.removeProperty('--leave-ry');
  el.style.removeProperty('--leave-rz');
  el.style.removeProperty('--enter-rx');
  el.style.removeProperty('--enter-ry');
  el.style.removeProperty('transform');
  el.style.removeProperty('opacity');
}
function setRandomLeaveRotation(el) {
  const rx = (Math.random() * 16 - 8).toFixed(1);
  const ry = (Math.random() * 16 - 8).toFixed(1);
  const rz = (Math.random() * 8 - 4).toFixed(1);
  el.style.setProperty('--leave-rx', `${rx}deg`);
  el.style.setProperty('--leave-ry', `${ry}deg`);
  el.style.setProperty('--leave-rz', `${rz}deg`);
}
function setRandomEnterRotation(el) {
  const rx = (Math.random() * 16 - 8).toFixed(1);
  const ry = (Math.random() * 16 - 8).toFixed(1);
  el.style.setProperty('--enter-rx', `${rx}deg`);
  el.style.setProperty('--enter-ry', `${ry}deg`);
}
function playLeaveAnimation(cardEl, done) {
  setRandomLeaveRotation(cardEl);
  let called = false;
  const finish = () => {
    if (called) {
      return;
    }
    called = true;
    cardEl.removeEventListener('animationend', onEnd);
    cardEl.classList.remove('leaving');
    done();
  };
  const onEnd = (e) => {
    if (e.animationName === 'card-leave') {
      finish();
    }
  };
  cardEl.addEventListener('animationend', onEnd);
  cardEl.classList.add('leaving');
  setTimeout(finish, 380);
}
function playEnterAnimation(cardEl, done) {
  setRandomEnterRotation(cardEl);
  let called = false;
  const finish = () => {
    if (called) {
      return;
    }
    called = true;
    cardEl.removeEventListener('animationend', onEnd);
    cardEl.classList.remove('entering');
    clearCardSwapVars(cardEl);
    done();
  };
  const onEnd = (e) => {
    if (e.animationName === 'card-enter') {
      finish();
    }
  };
  cardEl.addEventListener('animationend', onEnd);
  cardEl.classList.add('entering');
  setTimeout(finish, 480);
}
function cancelCardAnimations(cardEl) {
  cardEl.classList.remove('leaving', 'entering', 'no-flip-transition');
  clearCardSwapVars(cardEl);
}
function flipCard() {
  const card = document.getElementById('card');
  if (card.classList.contains('flipped')) {
    return;
  }
  if (card.classList.contains('leaving') || card.classList.contains('entering')) {
    cancelCardAnimations(card);
    card.style.opacity = '1';
  }
  card.classList.add('flipped');
  const grades = document.getElementById('grades');
  grades.classList.remove('hidden');
  document.getElementById('btn-show-answer').hidden = true;
  card.setAttribute('aria-label', 'Flashcard flipped (press 1-6 to grade)');
  document.getElementById('card-front').setAttribute('aria-hidden', 'true');
  document.getElementById('card-back').setAttribute('aria-hidden', 'false');
  const firstGrade = grades.querySelector('.btn');
  if (firstGrade) {
    firstGrade.focus({ preventScroll: true });
  }
}
function nextCard() {
  const result = appState.engine.getNextCard();
  if (result === null) {
    endSession();
    return;
  }
  const card = result.card;
  const cardEl = document.getElementById('card');
  const hadPrev = appState.engine.session.current !== null;
  appState.engine.session.current = result.id;

  const onEnterDone = () => {
    updateProgress();
    try { cardEl.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
  };

  const showNewCard = () => {
    cancelCardAnimations(cardEl);
    cardEl.style.opacity = '0';
    resetCardToFrontInstant();
    renderCardContent(result.id);
    playEnterAnimation(cardEl, onEnterDone);
  };

  if (hadPrev) {
    playLeaveAnimation(cardEl, showNewCard);
  } else {
    showNewCard();
  }
}
function updateProgress() {
  const session = appState.engine.session;
  if (!session) {
    return;
  }
  const total = session.totalCards;
  const completed = session.resolvedIds.size || 0;
  document.getElementById('progress-text').textContent = completed + '/' + total + ' completed';
}
// The main grading entry point. Called by grade button clicks or
// keyboard shortcuts (1-6). If the card isn't flipped yet, flips it.
// Otherwise delegates everything to engine.recordGrade().
// Saves to localStorage, updates the progress bar, advances to next card.
function gradeCurrent(grade) {
  if (!appState.engine.session || appState.engine.session.current === null) {
    return;
  }
  const cardId = appState.engine.session.current;
  if (!document.getElementById('card').classList.contains('flipped')) {
    flipCard();
    return;
  }
  appState.engine.recordGrade(cardId, grade);
  saveState(appState.engine.getState());
  updateProgress();
  nextCard();
}

// === SESSION END ===
// Tears down the session, persists state, and returns to the splash
// screen with focus on Start button.
function endSession() {
  const cardEl = document.getElementById('card');
  if (cardEl) {
    cancelCardAnimations(cardEl);
  }

  appState.engine.rehearseMode = false;
  appState.engine.session = null;
  saveState(appState.engine.getState());
  showView('splash');
  renderSplash();
  const start = document.getElementById('btn-start');
  if (start) {
    start.focus({ preventScroll: true });
  }
}
// Returns to splash mid-session without marking session completed.
// Cancels animations, discards session, renders splash.
function backToSplash() {
  appState.engine.rehearseMode = false;
  appState.engine.session = null;
  const cardEl = document.getElementById('card');
  if (cardEl) {
    cancelCardAnimations(cardEl);
  }
  showView('splash');
  renderSplash();
  const start = document.getElementById('btn-start');
  if (start) {
    start.focus({ preventScroll: true });
  }
}
function confirmReset() {
  const ok = confirm('Reset all progress?\n\nAll card progress will be cleared and daily counters reset. Streak will be reset. Total reviews will be kept.\n\nThis cannot be undone.');
  if (!ok) {
    return;
  }
  appState.engine.resetProgress(appState.cards.length);
  saveState(appState.engine.getState());
  renderSplash();
  const start = document.getElementById('btn-start');
  if (start) {
    start.focus({ preventScroll: true });
  }
}

// === THEME ===
// darkMode setting cycles through auto → light → dark → auto.
// effectiveDark() resolves 'auto' to the OS preference.
// applyTheme() toggles .dark / .light on <html> and swaps the button icon.
function effectiveDark() {
  const settings = (appState.engine && appState.engine.settings) || defaultSettings();
  if (settings.darkMode === 'dark') {
    return true;
  }
  if (settings.darkMode === 'light') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme() {
  const root = document.documentElement;
  const dark = effectiveDark();
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark && appState.engine.settings.darkMode === 'light');
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.textContent = dark ? '\u2600\uFE0F' : '\uD83C\uDF19';
  }
  const themeBtn = document.getElementById('btn-settings-theme');
  if (themeBtn) {
    const mode = appState.engine.settings.darkMode || 'auto';
    themeBtn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
  }
}
function cycleTheme() {
  if (!appState.engine) {
    return;
  }
  const current = appState.engine.settings.darkMode || 'auto';
  const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
  appState.engine.settings.darkMode = next;
  saveState(appState.engine.getState());
  applyTheme();
}
// === VIEW SWITCHING ===
function showView(name) {
  ['splash', 'study'].forEach(id => {
    document.getElementById(id).classList.toggle('active', id === name);
  });
}
function showError(msg) {
  const splash = document.getElementById('splash');
  splash.innerHTML = '<div class="panel"><h1>⚠️ Error</h1><div class="error">' + escapeHtml(msg) + '</div><p>Open the browser DevTools console for details.</p></div>';
  showView('splash');
}

// === EVENTS ===
function wireEvents() {
  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-settings-rehearse').addEventListener('click', function() {
    closeSettings();
    startAlreadyReviewedRehearsal();
  });
  document.getElementById('btn-theme').addEventListener('click', cycleTheme);
  document.getElementById('btn-close-session').addEventListener('click', backToSplash);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-backdrop').addEventListener('click', function(e) {
    if (e.target === this) {
      closeSettings();
    }
  });
  document.getElementById('btn-settings-theme').addEventListener('click', cycleTheme);
  document.getElementById('btn-settings-add-more').addEventListener('click', function() {
    closeSettings();
    addMoreCards();
  });
  document.getElementById('btn-settings-reset').addEventListener('click', function() {
    closeSettings();
    confirmReset();
  });

  [GRADES.NoIdea, GRADES.Vague, GRADES.Almost, GRADES.Hard, GRADES.Good, GRADES.Easy].forEach(grade => {
    document.getElementById('grade-' + grade).addEventListener('click', () => gradeCurrent(grade));
  });

  document.getElementById('btn-show-answer').addEventListener('click', flipCard);

  const cardEl = document.getElementById('card');
  cardEl.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      flipCard();
    }
  });

  document.addEventListener('keydown', handleKeydown);
}
function handleKeydown(e) {
  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }

  if (e.key === 'Escape') {
    if (!document.getElementById('settings-backdrop').hidden) {
      e.preventDefault();
      closeSettings();
      return;
    }
    if (document.getElementById('study').classList.contains('active')) {
      e.preventDefault();
      backToSplash();
    }
    return;
  }

  const splashActive = document.getElementById('splash').classList.contains('active');
  const studyActive = document.getElementById('study').classList.contains('active');

  if (splashActive) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      startSession();
    }
    return;
  }
  if (studyActive) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      flipCard();
      return;
    }
    if (e.key === '1') {
      e.preventDefault();
      gradeCurrent(GRADES.NoIdea);
      return;
    }
    if (e.key === '2') {
      e.preventDefault();
      gradeCurrent(GRADES.Vague);
      return;
    }
    if (e.key === '3') {
      e.preventDefault();
      gradeCurrent(GRADES.Almost);
      return;
    }
    if (e.key === '4') {
      e.preventDefault();
      gradeCurrent(GRADES.Hard);
      return;
    }
    if (e.key === '5') {
      e.preventDefault();
      gradeCurrent(GRADES.Good);
      return;
    }
    if (e.key === '6') {
      e.preventDefault();
      gradeCurrent(GRADES.Easy);
      return;
    }
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      cycleTheme();
      return;
    }
  }
}

// === INIT ===
// Loads config.json → cards.csv → localStorage → creates DrillEngine
// → migrates state → renders splash → wires events.
// This is the single entry point, called once on DOMContentLoaded.
async function main() {
  try {
    const config = await loadConfig();
    validateConfig(config);
    appState.config = config;

    const csvText = await loadCards();
    appState.cards = parseCSV(csvText);
    appState.csvHash = await sha256(csvText);

    let srsState = loadState();
    if (srsState._corrupted) {
      srsState = {
        cards: appState.cards.map(() => DrillEngine.initCard()),
        stats: defaultStats(),
        settings: defaultSettings(),
        meta: newMeta(),
        _corrupted: true,
      };
    }
    appState.engine = new DrillEngine(config, srsState);
    appState.engine.migrateState(appState.csvHash, appState.cards.length);
    saveState(appState.engine.getState());

    document.getElementById('deck-title').textContent = config.deckTitle;
    document.getElementById('deck-title-study').textContent = config.deckTitle;
    document.title = config.deckTitle;

    appState.msgManager = new StatusMessageManager();
    applyTheme();
    wireEvents();
    showView('splash');
    renderSplash();

    console.info('%cFlashcards ready: ' + config.deckTitle + ' v' + appState.engine.meta.version + ' (' + appState.cards.length + ' cards)',
      'color: #0b79d0; font-weight: bold;');
  } catch (error) {
    console.error('[flashcards] startup error:', error);
    showError((error && error.message) ? error.message : 'An unexpected error occurred.');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
