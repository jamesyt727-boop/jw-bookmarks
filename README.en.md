# JW Bookmarks

> Auto-file your bookmarks · by JamesWu · v1.4.0

[简体中文](README.md) | **English**

A Chrome extension (Manifest V3) that figures out which bookmark folder a page belongs to — right when you save it.

![Main UI](docs/screenshots/01-主界面.png)

**Highlights**

| Feature | Description |
| --- | --- |
| 🎯 **Auto-filing** | Hit the star — it decides where the bookmark goes |
| 🤖 **Two AI engines** | DeepSeek reads the page and shortlists folders; Jev makes the call with *calibrated* probabilities |
| 🗳️ **Asks when unsure** | Instead of guessing, it pops a picker with 3 candidates and their probabilities |
| 📦 **Batch organize** | Re-sort existing bookmarks; runs in the background and survives closing the popup |
| 🗄️ **One-click archive** | Sweep a pile of old folders into a single archive folder and start clean |
| 🔒 **Privacy first** | Everything stays on your machine. Only the page **title + URL** leaves it — and only to **your own** API endpoint |

More screenshots: [Batch organize](docs/screenshots/02-批量整理.png) ·
[Settings](docs/screenshots/03-设置.png) ·
[3-candidate picker](docs/screenshots/04-选择窗.png)

## How it works

```
Local rules match (offline) ──────────────▶ saved directly
        │ no match
        ▼
① DeepSeek "analysis": understands the page + your folder list,
   returns a high-recall shortlist, and suggests a new folder name
   if nothing fits
        │
        ▼
② Jev "judgment": makes the call against all folders and returns
   calibrated probabilities + confidence
        │
        ├─ top probability ≥ threshold ──▶ saved directly
        └─ below threshold ──────────────▶ picker opens (top-3 + new folder)
```

**Division of labour**: DeepSeek handles *understanding and generation* (an LLM's
strength — it can even name a new folder). Jev handles *judgment and confidence*
(a decision model's strength — its probabilities are calibrated, unlike an LLM's
self-reported ones).

The two are configured **separately**, each with its own API key / endpoint /
model. Either one alone still works:

- **DeepSeek only** → its shortlist is used directly
- **Jev only** → Jev judges across all folders without the shortlist

## Installation

### Load unpacked (self-use / development)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the **repository root**
4. Click the extension icon → **⚙** → enter your API keys → **Save**

> ⚠️ **Bring your own API keys.**
>
> This extension does **not** provide model access. You need a
> [TypeSafe Jev](https://typesafe.ai) and/or
> [DeepSeek](https://platform.deepseek.com) key. Configure at least one;
> with none, only local rules work.

## Usage

### First run (3 steps)

| Step | Do this |
| --- | --- |
| **1** | Click the extension icon → **⚙** → enter your Jev and/or DeepSeek **API key** → Save<br>(the "Test connection" button verifies a key immediately) |
| **2** | Open any page → click the icon → **"Analyze this page (no save)"**<br>It shows `engine / analysis / candidates with probabilities` — **nothing is moved** |
| **3** | Happy with the calls? Start bookmarking normally, using any of the three ways below |

### Three ways to bookmark

| Way | How | What happens |
| --- | --- | --- |
| **Native star** (recommended) | Click the ⭐ in the address bar | Waits ~3s (configurable), then decides automatically |
| **Extension button** | Icon → "Bookmark & auto-file" | Classifies and saves immediately |
| **Context menu** | Right-click a page → "Bookmark to auto-folder" | Same as above |

### Three possible outcomes

- ✅ **Confident** (probability ≥ threshold, default 0.8) → the bookmark is
  **moved automatically**; the icon flashes ✓
- 🗳️ **Unsure** → a picker opens with 3 candidates + probabilities; one click files it
- 🔒 **Local rule matched** → saved directly, no network, no latency

### Thoughtful details

- **It respects manual edits** — if you change the title or folder in the native
  star dialog, auto-filing backs off and leaves your choice alone
- **Create a folder on the spot** — the picker lets you name a new folder
  (DeepSeek suggests one when available, pre-filled for you)
- **"Keep current location"** — leave the bookmark exactly where it is

## Configuration

### API keys (Settings ⚙)

| Provider | Default endpoint | Default model | Role |
| --- | --- | --- | --- |
| Jev (TypeSafe) | `https://api.typesafe.ai` | `jev-latest` | Judgment + calibrated probabilities |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` | Page analysis, shortlist, new folder naming |

### Local rules

Rules run first and never touch the network. One per line:

```
domain:mp.weixin.qq.com => 微信公众号
domain:feishu.cn        => 飞书
url:example.com/docs    => Documentation
```

- `domain:` matches the domain **and all its subdomains**
- `url:` matches if the URL **contains** the given string
- A rule is skipped when its target folder is excluded or archived

### Excluded folders

Folders listed there are never offered as candidates and are never auto-filed
into — useful for "inbox"-style folders you want to sort by hand.

### Other settings

- **Auto-move after starring** — master switch for the native-star flow
- **Threshold** — minimum probability required to file without asking (default `0.8`)
- **Delay (ms)** — how long to wait before classifying a starred bookmark
  (default `3000`, so manual edits can settle first)
- **Config export / import** — includes your API keys, so keep the file safe

## Privacy

- **Reads**: your bookmark structure (`bookmarks`), plus the current tab's
  title/URL only when you click the extension (`activeTab`)
- **Stored locally**: API keys, settings, rules, archive record — in
  `chrome.storage.local`, **not** synced to your Google account
- **Network**: only when no local rule matches, and only the page
  **title + URL**, sent to the endpoints **you** configured. There is no
  developer-operated server.
- **Never**: no analytics, no telemetry, no browsing history, no cookies,
  no page content injection

See [docs/privacy.md](docs/privacy.md) for the full policy.

## Project layout

```
background.js        # Service worker: onCreated auto-move, context menu, picker flow, message routing
lib/
  providers.js       # Jev + DeepSeek clients (independently configured)
  classifier.js      # Core: rules → DeepSeek → Jev → top-3 candidates
  organizer.js       # Batch organize (runs in the worker, survives popup close)
  i18n.js            # Display localization (Bookmarks Bar → 书签栏)
  defaults.js        # Built-in domain rules
popup.html/.css/.js  # Action popup: actions / batch organize / settings
picker.html/.css/.js # 3-candidate picker with probability bars
icons/               # 16 / 32 / 48 / 128
docs/                # Privacy policy, store listing, screenshots
```

## License

[Apache License 2.0](LICENSE)
