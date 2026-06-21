// Test SM-2 algorithm — inline the core functions from app.js
const DAY_MS = 86400000;
function today() { return Math.floor(Date.now() / DAY_MS); }
const GRADES = Object.freeze({ NoIdea: 0, Vague: 1, Almost: 2, Hard: 3, Good: 4, Easy: 5 });
const SM2 = { MIN_EASE: 1.3, MAX_EASE: 2.5, DEFAULT_EASE: 2.5, INITIAL_INTERVAL: 1, GRADUATING_INTERVAL: 6 };

function applySM2(card, grade) {
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

function initCard() {
  return { ease: SM2.DEFAULT_EASE, intervalDaysUntilNextReview: 0, repetitionsOfSuccess: 0, dueDateOfNextReview: today(), lapsesOfFailed: 0, lastReview: null, lastGrade: null, _bonus: false };
}

const t = today();

function approxEq(a, b, eps=0.0001) { return Math.abs(a-b) < eps; }
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { console.log('FAIL: ' + msg); fail++; } }

// === SM-2 ===
let c;
c = initCard(); applySM2(c, 4);
assert(c.intervalDaysUntilNextReview === 1, 'new+Good: interval=1');
assert(c.repetitionsOfSuccess === 1, 'new+Good: repetitions=1');
assert(approxEq(c.ease, 2.5), 'new+Good: ease=2.5');
assert(c.dueDateOfNextReview === t + 1, 'new+Good: due=today+1');
assert(c.lastReview === t, 'new+Good: lastReview=today');

c = initCard(); applySM2(c, 0);
    assert(c.repetitionsOfSuccess === 0, 'new+NoIdea: reps=0');
    assert(c.intervalDaysUntilNextReview === 1, 'new+NoIdea: interval=1');
    assert(c.lapsesOfFailed === 1, 'new+NoIdea: lapses=1');
    assert(approxEq(c.ease, 1.7), 'new+NoIdea: ease updated to 1.7 got=' + c.ease);

c = initCard(); applySM2(c, 3);
assert(approxEq(c.ease, 2.36), 'new+Hard: ease=2.36 got=' + c.ease);

c = initCard(); applySM2(c, 5);
assert(approxEq(c.ease, 2.5), 'new+Easy: ease capped at 2.5 got=' + c.ease);

c = { id:0, ease:2.5, intervalDaysUntilNextReview:1, repetitionsOfSuccess:1, dueDateOfNextReview:t, lapsesOfFailed:0, lastReview:t-1 };
applySM2(c, 4);
assert(c.intervalDaysUntilNextReview === 6, 'rep=1+Good: interval=6');

c = { id:0, ease:2.5, intervalDaysUntilNextReview:6, repetitionsOfSuccess:2, dueDateOfNextReview:t, lapsesOfFailed:0, lastReview:t-1 };
applySM2(c, 4);
assert(c.intervalDaysUntilNextReview === 15, 'rep=2,int=6,ease=2.5+Good: interval=15 got=' + c.intervalDaysUntilNextReview);

c = { id:0, ease:1.2, intervalDaysUntilNextReview:5, repetitionsOfSuccess:3, dueDateOfNextReview:t, lapsesOfFailed:0, lastReview:t-1 };
applySM2(c, 5);
assert(approxEq(c.ease, 1.3), 'ease floor 1.3 got=' + c.ease);

c = { id:0, ease:2.5, intervalDaysUntilNextReview:5, repetitionsOfSuccess:3, dueDateOfNextReview:t, lapsesOfFailed:0, lastReview:t-1 };
applySM2(c, 3);
assert(approxEq(c.ease, 2.36), 'ease=2.5+Hard: 2.36 got=' + c.ease);

c = { id:0, ease:2.5, intervalDaysUntilNextReview:15, repetitionsOfSuccess:3, dueDateOfNextReview:t, lapsesOfFailed:0, lastReview:t-1 };
applySM2(c, 0);
    assert(c.repetitionsOfSuccess === 0, 'grad+NoIdea: reps=0');
    assert(c.intervalDaysUntilNextReview === 1, 'grad+NoIdea: interval=1');
    assert(c.lapsesOfFailed === 1, 'grad+NoIdea: lapses=1');
    assert(approxEq(c.ease, 1.7), 'grad+NoIdea: ease updated to 1.7 got=' + c.ease);

    // New grades: Vague(1) and Almost(2)
    applySM2(c, GRADES.Vague);
    assert(c.repetitionsOfSuccess === 0, 'new+Vague: reps=0');
    assert(c.intervalDaysUntilNextReview === 1, 'new+Vague: interval=1');
    assert(c.lapsesOfFailed === 1, 'new+Vague: lapses=1');
    assert(approxEq(c.ease, 1.96), 'new+Vague: ease=1.96 got=' + c.ease);

c = initCard(); applySM2(c, 2);
assert(c.repetitionsOfSuccess === 0, 'new+Almost: reps=0');
assert(c.intervalDaysUntilNextReview === 1, 'new+Almost: interval=1');
assert(c.lapsesOfFailed === 1, 'new+Almost: lapses=1');
assert(approxEq(c.ease, 2.18), 'new+Almost: ease=2.18 got=' + c.ease);

// EF ceiling at 2.5
c = initCard(); c.ease = 2.5; applySM2(c, 5);
assert(approxEq(c.ease, 2.5), 'ease ceiling 2.5 got=' + c.ease);

    assert(GRADES.Vague === 1 && GRADES.Almost === 2 && GRADES.NoIdea === 0 && GRADES.Hard === 3 && GRADES.Good === 4 && GRADES.Easy === 5, 'GRADES constant');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
