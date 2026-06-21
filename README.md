# Flashcards

A **zero-dependency** flash card app using SM-2 spaced repetition. Each app instance = one deck. Deploy by copying the folder to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages, etc.) or open via `file://`.

## Quick start

1. Open `index.html` in a browser — splash appears, click **Start Studying**.
2. Press **Space** to flip, **1-6** to grade (No Idea / Vague / Almost / Hard / Good / Easy).
3. Click **Settings** (gear icon) → **Reset Progress** to start over.

## File structure

```
flashcards-app/
├── index.html           # Entry point
├── config.json          # Deck title, daily limits, colors, grade timings
├── cards.csv            # Question,Answer columns (HTML allowed)
├── favicon.ico          # Tab icon
├── server.cjs           # Optional local dev server (node server.cjs)
├── README.md            # This file
├── assets/
│   ├── app.js           # App logic (SM-2 engine, UI, state)
│   ├── style.css        # All styles (light + dark themes)
│   └── images/
│       └── maps/        # Country map SVGs for card images
└── tests/
    └── test-sm2.cjs     # SM-2 engine unit tests
```

## Configuration (`config.json`)

| Key | Type | Notes |
|-----|------|-------|
| `appId` | string | Unique identifier for this deck. **Change when duplicating** to keep separate `localStorage`. |
| `deckTitle` | string | Shown on splash and study header. |
| `dailyNewLimit` | number | Max new cards per session. |
| `dailyDueCardsLimit` | number | Max due cards pulled into session per day. |
| `maxReviewsPerSession` | number | Safety cap on total grades per session. |
| `maxCardsToRehearse` | number | Cards added to end of session for extra practice. |
| `extraCardsOnComplete` | number | Bonus cards shown when daily queue is done. |
| `gradeTimings` | object | Per-grade delay in seconds before re-queue (e.g. `"noidea": 60`). |
| `storageKeyPrefix` | string | Prefix for `localStorage` keys (default `fc_`). |
| `colors` | object | Light palette + optional `darkMode` palette. All fields override CSS variables. |

`colors` keys: `primary`, `primaryHover`, `background`, `cardBackground`, `text`, `textMuted`, `border`, `success`, `warning`, `danger`, `shadow`, `darkMode: { primary, background, cardBackground, text, textMuted, border, shadow }`.

## CSV format (`cards.csv`)

Two columns: `Question,Answer`. HTML is allowed in both.

```csv
Question,Answer
"Capital of France?","Paris"
"<img src='assets/images/maps/BE.svg' alt='' style='max-width:100%'>","Belgium"
"<h2>Welcome</h2><p>Press Space to flip.</p>","<p>Answer side supports <strong>HTML</strong>.</p>"
```

**Quoting rules:** Wrap fields containing commas in double quotes. Use **single quotes** for HTML attributes inside quoted fields so they don't conflict with CSV double quotes.

## Grade system

| # | Grade | SM-2 | Session | Delay |
|---|-------|------|---------|-------|
| 1 | No Idea | fail | re-queue | 60s |
| 2 | Vague | fail | re-queue | 60s |
| 3 | Almost | fail | re-queue | 30s |
| 4 | Hard | pass | re-queue | 180s |
| 5 | Good | pass | resolve | — |
| 6 | Easy | pass | resolve | — |

Grades 1-3 reset SM-2 progress (repetitions, ease). Grades 4-6 advance it. Grades 5-6 remove the card from the current session.

## Keyboard shortcuts

| Key | Where | Action |
|-----|-------|--------|
| `Space` / `Enter` | Study | Flip card |
| `1` | Study | Grade: No Idea |
| `2` | Study | Grade: Vague |
| `3` | Study | Grade: Almost |
| `4` | Study | Grade: Hard |
| `5` | Study | Grade: Good |
| `6` | Study | Grade: Easy |
| `D` | Study | Cycle theme (auto → light → dark) |
| `Esc` | Study | Back to splash |
| `Enter` / `Space` | Splash | Start studying |

## Deployment

The whole folder is a self-contained static site. Drop it on any host.

### GitHub Pages
Push the folder to a repo. Settings → Pages → Source: `main` branch, root.

### Netlify
Go to <https://app.netlify.com/drop>, drag the folder.

### Vercel
```bash
cd flashcards-app
npx vercel --prod
```

### Cloudflare Pages
Dashboard → Pages → Create → Direct Upload. Drag the folder.

### `file://` (local)
Double-click `index.html`. Works in Firefox. **Chrome blocks `fetch()` for `file://`** — run `node server.cjs` or `npx http-server` locally.

## How to create a new deck

1. **Copy the whole folder** to a new location.
2. In `config.json`: change `appId` (unique per deck), `deckTitle`, and adjust limits/colors.
3. Replace `cards.csv` with your own `Question,Answer` rows.
4. Drop images into `assets/images/`.
5. Open `index.html` or deploy.

Different `appId` = completely separate `localStorage` state. Host many decks on the same domain with no interference.

## Local storage

Keys prefixed with `config.storageKeyPrefix` (default `fc_`):

| Key | Content |
|-----|---------|
| `<prefix>cards` | `[{id, ease, intervalDaysUntilNextReview, repetitionsOfSuccess, dueDateOfNextReview, lapsesOfFailed, lastReview, lastGrade}]` |
| `<prefix>stats` | `{totalReviews, streakDays, lastStudyDate, newToday, dueToday, lastDay}` |
| `<prefix>settings` | `{darkMode: "auto"\|"light"\|"dark"}` |
| `<prefix>meta` | `{created, version, csvHash}` |

CSV SHA-256 hash is stored in `meta.csvHash`. When the CSV changes, SRS state resets automatically while keeping stats and settings.

## Browser support

Latest Chrome, Firefox, Edge, Safari (desktop + mobile). Requires `fetch`, `crypto.subtle`, `localStorage`, and CSS Grid.

## License

Public domain / CC0.
