# pi-telegram

Drive a **running [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) session from Telegram**.

[한국어 README](README.ko.md)

pi keeps owning the session. The extension mirrors what the terminal shows, turns Telegram text and
attachments into pi prompts, and re-implements the pi commands that matter as chat messages with
inline keyboards. One running pi session ↔ one or more Telegram chats.

Two other extensions are bridged rather than reimplemented, so the phone is not left out of the loop:
**[`@juicesharp/rpiv-ask-user-question`](#questionnaires-and-goals-from-other-extensions)** (its
questionnaires become tappable buttons on the phone) and **[`pi-goal-x`](#questionnaires-and-goals-from-other-extensions)**
(its goal shows up as a `/tg goal` card, a line in `/status`, and transition news). Both are optional —
without them those features simply stay quiet.

```
Telegram  ──poll──▶  bridge  ──▶  prompts, /commands, keyboard taps
   ▲                   │
   └── HTML messages ──┘  answers, a live tool board per turn, thinking, failures
```

## Install

```bash
pi install git:github.com/sonic240612/pi-telegram

# or a local checkout, while developing
pi install /path/to/pi-telegram
```

Use the **scoped** name if you install from npm: plain `pi-telegram` there is somebody else's package.
`package.json` is already set up for `@sonic240612/pi-telegram`, so once it is published
`pi install npm:@sonic240612/pi-telegram` works too. If you installed the unscoped one earlier,
`pi remove npm:pi-telegram` first — two bridges on one bot token fight each other.

The extension entry point is `index.ts` (declared in `package.json` under `pi.extensions`). After
installing, restart pi (or run `/reload` in an already running pi).

Updates: `pi update --extensions` re-syncs a git install, then restart pi (or `/reload`).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Start pi and set the token once (it is stored in `~/.pi/agent/telegram.json`, mode `0600`):

   ```
   /telegram-setup 8161521009:AAA…
   ```

   Other ways to provide it: `TELEGRAM_BOT_TOKEN=… pi`, or `pi --telegram-token <token>`.
   Load the extension without connecting with `pi --telegram-off`.
3. Message the bot anything (for example `/start`). pi-telegram registers the chat as *pending* and
   prints a short code in the pi terminal.
4. Approve it in pi:

   ```
   /telegram-pair          # list pending chats
   /telegram-pair 482913   # allow one
   ```

The code is never sent to the unapproved chat, and an unapproved chat gets only the pairing notice.
Five wrong guesses rotate the code, cool that chat down and tell you in the pi terminal.

## Using it from Telegram

Send text like you would type into pi — it becomes a pi prompt. Photos are sent as image input,
text files (`.ts`, `.md`, `.json`, …) are inlined, other attachments get an explanatory notice.

### Getting around

| Command | Arguments | What it does |
| --- | --- | --- |
| `/help` (alias `/start`) | — | Full command list with a few shortcut buttons. Everything below, in chat. |
| `/menu` | — | Button-only menu: model / thinking / tools / new / resume / fork / status / usage / abort. |
| `/commands` (alias `/prompts`) | `[filter]`, pagination buttons | Every pi, extension and prompt-template command; tap one to run it. `/commands review` filters. |
| `/skills` | pick from keyboard | Run a pi skill (`/skill:<name>`). |

### Session and context

| Command | Arguments | What it does |
| --- | --- | --- |
| `/new` | — | New session. Confirmed after the bridge is re-created (see session replacement). |
| `/resume` `[query]` | filter text | Session picker keyboard. This project first, then sessions from other projects tagged `·project`. `/resume deploys` filters. |
| `/fork` `[message]` | pick from keyboard | Branch the session from an earlier prompt. |
| `/tree` | pick from keyboard | Move to another node of the session tree. |
| `/rename` `<name>` | new name, e.g. `/rename auth refactor` | Rename the session. `/name` is an alias. |
| `/compact` `[instructions]` | e.g. `/compact keep the test failures` | Context compaction. Refused while a run is in flight (`/abort` first). The chat is told when pi compacts — see “Compaction is visible”. |
| `/export` | — | Send the session `.jsonl` file to the chat. |
| `/usage` | — | Context window usage: tokens, window size, percent. |
| `/status` (alias `/session`) | — | Bot, model, thinking level, session name/file, cwd, uptime, pending chats, verbosity, streaming. |

### Model, thinking, tools

| Command | Arguments | What it does |
| --- | --- | --- |
| `/model` | — | Model picker as an inline keyboard. Models served by **your own machine** (llama.cpp, ollama, lmstudio) come first, marked `🏠`. When the usable list is bigger than anyone can page (openrouter), it drills down to **providers** first (`🗂`). |
| `/model <name\|filter>` | e.g. `/model glm` | Searches **everything pi knows about** (not just the models pi calls available), ranks the hits, and switches immediately when the answer is unambiguous. `/models` is an alias. |
| `/model <provider>` | e.g. `/model openrouter` | Filter a whole provider at once; the list caps at 80 hits (`✂️`) so a narrow term is asked for instead of paging forever. |
| `/model <provider/id>` | e.g. `/model openrouter/anthropic/claude-sonnet-4.5` | Use an exact id — including ids pi does not put in its available list. |
| `/model <aggregator id>` | e.g. `/model nvidia/nemotron-3.5-super-vl:free` | Type an OpenRouter id the way OpenRouter writes it (no `openrouter/` prefix). The bridge finds the provider that owns that id and applies it. An id pi has **never** heard of is still accepted: it borrows a sibling model's endpoint/context settings and says so (`✨`). |
| `/thinking` `[level]` | `off`, `minimal`, `low`, `medium`, `high` | No argument → keyboard; with a level → set it. |
| `/tools` | `list`, `<tool name>` | No argument → keyboard of all tools with ✓ for active ones and a `reset` button. `/tools bash` toggles that one tool. |

### Running and steering

| Command | Arguments | What it does |
| --- | --- | --- |
| `/abort` (aliases `/stop`, `/cancel`) | — | Abort the current run. No-op while idle (says so). |
| `/steer <text>` | instruction | Inject an instruction into the running turn. |
| `/queue <text>` (alias `/followup`) | instruction | Deliver after the current run finishes. |
| `/bash <command>` | shell command | Runs in the session cwd. Output over ~3000 chars arrives as a `.txt` file. |
| `/reload` | — | Reload extensions (pi runtime restart, bridge reconnects). |

### Output control

| Command | Arguments | What it does |
| --- | --- | --- |
| `/verbose` `[0\|1\|2]` | level | `0` answers only · `1` (default) answers + a live tool board per turn · `2` full transcript mirror. |
| `/stream` `[on\|off]` | `on` / `off` | Live draft editing while pi writes the answer. |
| `/ping` | — | Round-trip check: bot name + latency. |
| `/stats` | — | Latency bookkeeping (same as `/tg stats`; long polls are counted separately so they do not look like slow sends). |

### Bridge administration

| Command | Arguments | What it does |
| --- | --- | --- |
| `/pair` | — | Show the pairing code for this chat / list pending chats. |
| `/chats` | — | Paired chats (also `unpair` buttons). |
| `/pending` | — | Chats waiting for approval, with codes. |
| `/unpair` | — | Leave: revoke *this* chat (the buttons in `/chats` revoke others). |
| `/restart` | — | Reconnect the bridge (poll loop, menu, token). |
| `/tg status` | — | Full bridge state: bot, chats, offset, verbosity, streaming, last error. |
| `/tg pair` · `/tg pending` | — | Pairing help / pending list. |
| `/tg unpair` (alias `/tg leave`) | — | Revoke this chat. |
| `/tg chats` | — | Paired chats. |
| `/tg restart` | — | Reconnect. |
| `/tg verbose [0\|1\|2]` · `/tg stream [on\|off]` | | Same as the top-level commands. |
| `/tg activity [on\|off]` | | At detail `1`, either keep one tool board live during the turn (default) or show only the summary when the turn ends. |
| `/tg bridge` | — | The pi windows that share this bot token, which one is connected, and which one is allowed to poll. `/tg bridge off` disconnects this window (the same as `/telegram off`). |
| `/tg lang [ko\|en\|auto]` | | What language the bridge uses in this chat, why it chose that one, and how to change it. `auto` hands it back to what Telegram reports. |
| `/tg stats` (alias `/tg latency`) | — | Telegram call count / average / max, poll count, slow calls, 429s, and prompt → run-start delay. Tells you whether a slow reply is pi thinking or the network. |
| `/tg menu` | — | Re-register the “/” autocomplete menu and verify what Telegram serves. Use it when the autocomplete list looks wrong (see below). |
| `/tg redact [on\|off]` · `/tg redact transcript [on\|off]` | | Control how much credential scrubbing the bridge applies to the copies it makes for Telegram (`/bash` output is scrubbed by default; the mirrored transcript is not). |
| `/tg goal` | — | The goal this session is chasing, as another extension (`pi-goal-x`) records it: state, task count, tokens, why it paused. Also a compact goal line in `/status`. |

### Autocomplete: what to know

Telegram builds the “/” popup from `setMyCommands`, and **a more specific scope overrides the default
one**. pi-telegram registers its menu in both the default and `all_private_chats` scopes on connect,
and reads it back; if our commands are missing from what Telegram serves, the bridge warns you — that
usually means **another program is using the same bot token** (an older pi-telegram install, a second
pi process). Fix: stop the other process, then `/tg menu` or `/restart`.

A command that is not in the popup still works: typing it is enough. `/help` always lists everything.

### Passthrough commands

Any other `/name` is handed to pi, so these all work from Telegram:

* extension commands (`/review`, `/ast-grep`, …),
* skills (`/skill:pdf …`),
* prompt templates (`/mytemplate args`),
* pi built-ins that make sense headless.

Terminal-only commands (`/settings`, `/import`, `/hotkeys`, `/clone`, `/trust`, `/login`, …) reply with
a hint instead of being silently dropped.

### Questionnaires and goals from other extensions

Two installed extensions are bridged rather than reimplemented — the bridge only reads what they put
on pi's event bus and session record, so a rename inside them degrades a feature instead of breaking
the bridge:

* **`@juicesharp/rpiv-ask-user-question`** (`ask_user_question`): when pi asks that questionnaire, the
  questions arrive in *every* paired chat as buttons — single-select answers on the first tap,
  multi-select accumulates ticks and submits with ✅, and ✏️ lets the next message be a typed answer.
  The first chat to answer wins; the cards in the other chats close. An answer typed in the terminal
  closes the phone cards too. In hosts where that package answers through the host's own dialogs
  (RPC/ACP clients such as Zed), the phone cannot answer and says so instead of hanging.
* **`pi-goal-x`**: its goal is shown with `/tg goal` and as a line in `/status`, and state changes
  (new goal, paused, blocked, task progress) are announced in the chats at verbosity ≥ 1 — throttled,
  so a long task bookkeeping run does not become chat spam. The goal's own commands (`/goal`,
  `/goal-pause`, …) stay pi-goal-x's; the bridge adds no `/goal` of its own, and its confirmation
  dialogs appear in the terminal, so run the confirming ones there.

### In pi (terminal) rather than Telegram

| Command | What it does |
| --- | --- |
| `/telegram status\|start\|restart\|stop` | bridge lifecycle |
| `/telegram on` · `/telegram off` | take the bridge over from another pi window · let it go, and stay off until you say `on` |
| `/telegram who` | every pi window holding this token, and which one polls Telegram |
| `/telegram token <token>` | store the bot token |
| `/telegram pair [code]` · `/telegram add <chat_id>` | approve a waiting chat |
| `/telegram chats` | paired chats |
| `/telegram verbose <0\|1\|2>` | output level |
| `/telegram-setup` | save a bot token from @BotFather and connect |
| `/telegram-pair [code]` | approve a pending chat (the code is shown in the pi UI, never sent to the unpaired chat) |
| `/telegram-chats` | list paired chats |
| `/telegram-verbose <0\|1\|2>` | output level |

CLI flags: `pi --telegram-token <token>` (use once without storing) and `pi --telegram-off` (load the
extension but stay disconnected).

Anything else that is a real pi/extension/prompt-template command is passed through
(`/review`, `/skill:pdf`, …). Commands that only make sense in a terminal (`/settings`, `/import`,
`/hotkeys`, …) reply with a hint instead of being silently dropped.

Outbound: answers keep pi's markdown shape (headings, bold, bullet lists, GitHub tables rendered as
aligned monospace, fenced code with fences kept balanced across message chunks). Long answers are
split without losing characters; nothing is silently truncated.

## Verbosity

| Level | What Telegram sees |
| --- | --- |
| `0` | answers only |
| `1` (default) | answers + one tool board per turn, updated while the tools run |
| `2` | full transcript: thinking, tool calls, tool results, usage footers |

Set with `/verbose 2`, or in pi with `/telegram-verbose 2`.

At detail `1` the turn's tools live in a single message — pi's bottom status line, moved to the
phone: `🔧 이번 턴 · 3회`, one line per call (`📖 read src/a.ts`, `💻 bash npm test`), `⚙️` on the call
that is still running, `❌` on the ones that failed, older calls folded after the last six. While a
call is in flight the header reads `진행 중… 12.4s`, so a slow turn is visible from the notification
alone. The
board is edited as calls start and finish (at most one edit every 2.5 s per chat, which is about what
Telegram allows), and it is a separate message from the streaming answer, so neither overwrites the
other. When the turn ends the same message becomes the summary, with token and time footers.
`/tg activity off` (or `activityLive: false`) keeps only that final summary.

## Tools the model can call

* `telegram_send` — push text or files to the paired chats.
* `telegram_ask` — ask a question with buttons and wait for the tap.

Both only fan out to chats that passed pairing. `telegram_ask` asks the chat named in `chat_id`, or
the first paired chat, and only that chat's tap counts.

`telegram_send path=…` attaches any file pi can read, which makes the bridge an exfiltration channel
for a prompt-injected model: it can read `~/.ssh/id_rsa` and hand it to your phone. Every attach is
announced in the pi terminal so you see it while it happens, but the real control is whether you
want the tool available at all — remove it from pi's tool list if you do not.

## Configuration

`~/.pi/agent/telegram.json`:

| Key | Meaning |
| --- | --- |
| `token` | bot token (written by `/telegram-setup`, file mode `0600`) |
| `chats` | paired chats `[{ chatId, label, name }]` — each one also remembers a language (`lang` pinned by `/tg lang`, `tgLang` what Telegram reported) |
| `verbosity` | `0` / `1` / `2` |
| `streaming` | live draft editing while pi streams |
| `activityLive` | at detail `1`, keep the turn's tool board updated during the turn (default `true`; `false` = summary at turn end only) |
| `language` | pin the bridge's own language for every chat (`ko` / `en`). Left unset, each chat follows what Telegram reports — and an install that already has paired chats stays Korean |
| `announce` | connect/disconnect notices |
| `redactBash` | scrub credential-looking text out of `/bash` output the bridge copies to Telegram (default `true`) |
| `redactTranscript` | also scrub the mirrored transcript (default `false` — detail mode should match the terminal) |
| `offset` | last processed Telegram `update_id` (survives restarts, so nothing is replayed) |

Next to it sits `telegram-lease.json` — coordination, not configuration: which pi window is allowed to
poll this token, and which windows are merely open. It holds no secrets, and deleting it is harmless
(the next session just claims the bridge).

Environment: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ROOT` (Bot API base — used by the offline tests),
`PI_TG_DEBUG=1` (diagnostics on stderr only, never into the chat).

## Behaviour worth knowing

* **The bridge speaks the chat's language.** Telegram names the language of every client, and the bridge
  remembers it per chat, so menus, buttons, cards, notices and the tool board come out in Korean or
  English without anyone asking. `/tg lang ko|en` pins one chat, `language` in `telegram.json` pins them
  all, and `/tg lang auto` gives the choice back to Telegram. An install whose chats were already paired
  when this arrived keeps hearing Korean — a language should not change half way through somebody's
  week — and a fresh install follows Telegram. What pi *answers* is never rewritten: the language of
  your prompt and the model decide that, and `/model` can carry an instruction like "answer in Korean"
  (`/resume` brings that back with the session).
* **One bot token, and only one window polling it.** Open a second pi with the same token and both would
  poll, so Telegram answers with `409 conflict` and the phone's messages land in whichever window grabs
  the update first. The bridge settles that before it starts: the first session to arrive takes the
  bridge, later ones open *disconnected* and say so instead of fighting — `/telegram who` (or `/tg bridge`)
  lists every window and which one holds it, and each heartbeat is stamped, so when a window is closed or
  crashes the next one takes over on its own within a few seconds. `/telegram on` (or `/telegram start`,
  `/telegram restart`) takes the bridge over from a window that is still alive; `/telegram off` lets it go
  and stays off until you say `on`. A pi that replaces its own session (`/new`, `/resume`, `/fork`,
  `/reload`) keeps the bridge it already had, and the half-finished bridge it leaves behind cannot hand it
  to somebody else.
* **Compaction is visible.** pi blocks new prompts while it rebuilds its context, and it used to do
  that silently as far as Telegram was concerned. Now the bridge announces it — `🗜 컨텍스트 압축 중…`
  with the context size and what triggered it (`/compact`, the context threshold, or an overflow
  recovery, after which pi retries the aborted turn) — and finishes with `✅ 컨텍스트 압축 완료` plus the
  token delta and how long it took, or `⚠️ 컨텍스트 압축 실패/중단` with the reason (redacted). Messages you
  send during that window are parked, not lost, and delivered once compaction ends.
* **Chat history is never rewritten.** Streaming answers live in a draft message that is edited in
  place, the way a terminal redraws. Once the draft holds the finished answer it is sealed: the next
  turn writes into a *new* message, and the answer you already read stays in the chat. Only a draft
  that still shows nothing but "⏳ 생각 중…" is deleted.
* **You can tell pi is working.** While a run is in flight the bridge refreshes Telegram's
  "입력 중…" hint every ~4.5s (it expires on its own after ~5s) and stops as soon as the run ends.
* **A turn reads like pi's own status line.** At detail `1` the tools of a turn share one
  `🔧 이번 턴` message that grows as calls start and finish — `⚙️` on the running call, `❌` on the
  failed ones — and becomes the turn summary (tokens, cost, time) when the turn ends. While a call is
  still running its header counts (`진행 중… 12.4s`), so a slow turn does not look dead, and if the
  run stops inside a call the board is closed where it stands (`⛔ 중단됨`) instead of pretending work
  is still going on. Edits are capped at one per chat every ~2.5s, the board is separate from the
  streaming answer so the two never overwrite each other, and `/tg activity` tells you which mode you
  are in (it only exists at detail `1`).
* **Three separate lanes against Telegram.** Long polling (`getUpdates`, up to 25s open), message
  sending, and auxiliary hints (`sendChatAction`) never share a queue. A parked poll or a dropped
  typing hint cannot delay an answer — that used to be where "the reply showed up 20 seconds later"
  came from. Every request also has a time budget (20s, 35s for a poll), so a wedged connection fails
  loudly instead of parking the send lane, and `429 retry_after` is honoured and recorded.
* **Measure it: `/tg stats`.** Shows telegram round-trip latency (count / average / max), the slowest
  recent calls, how many times telegram throttled us, and how long pi took to start each run
  (prompt → run start). That tells you whether a slow reply is pi thinking or the network — and the
  note about `TELEGRAM_API_ROOT` appears if the round trips themselves are slow.
* **Local models come first.** pi only calls a model “available” when its provider has credentials it
  recognises, so a `models.json` provider pointed at `127.0.0.1` / `localhost` (llama.cpp, ollama,
  lmstudio, vLLM …) never reaches pi's available list — and models declared in `models.json` carry no
  `type` at all, which used to filter them out too. The bridge pulls those models back from the full
  registry, marks them `🏠`, and sorts them above the cloud models (the model in use stays pinned on
  top). A keyless *cloud* model is deliberately not treated as local.
* **Huge providers stay usable.** An OpenRouter setup knows ~1600 models. `/model` therefore drills down
  to providers instead of paging 130 screens, `/model <provider>` filters one provider (list capped with
  `✂️` past 80 hits), and `/model <provider/id>` resolves against the whole registry — pi's available
  list or not. Aggregator ids embed the manufacturer, so you can type the id exactly as the provider
  writes it: `/model nvidia/nemotron-3.5-super-vl:free` resolves to
  `openrouter/nvidia/nemotron-3.5-super-vl:free` and the reply shows how it was read. A model id pi has
  never seen is still usable: it takes the shape of a sibling model of that provider, and the reply
  flags it with `✨`. Rows marked `🔑` mean pi has no credentials for that provider yet (set them up in
  pi with `/login`); `🚫` means even the provider could not be worked out.
* **Compaction never eats your message.** pi refuses prompts while it rebuilds context (“Cannot submit
  a prompt while compaction is in progress”) and reports that only internally, so a chat message sent
  during compaction used to disappear with an error. The bridge now watches `session_before_compact`,
  `session_compact` and `session_compact_failed`, parks those messages (telling you how many are
  waiting) and replays them as soon as pi can take prompts again — the same thing pi's own terminal
  does. Tree navigation that generates branch summaries uses the same lock, and a failed compaction
  releases the queue too.
* **Session replacement.** `/new`, `/resume`, `/fork`, `/reload` make pi tear down the session and
  re-create extensions, so the bridge is replaced by a new instance. The outgoing instance hands the
  confirmation over (`pendingNotice` in the config file, 5 minute TTL) and the new instance replays
  it, so you still get "🌱 새 세션 시작" in the chat. The handoff also covers a `/telegram-setup`
  token written moments before the replacement.
* **Keyboards expire.** Buttons carry short-lived server-side tokens (30 min, capped). A keyboard
  rendered before a session replacement answers "이 버튼은 만료됐어요" and removes itself instead of
  doing nothing.
* **Keyboards never bounce off Telegram.** Button text is capped at 64 characters and message text at
  4096, both at the client boundary — a long session title or model name is clipped rather than
  making the entire keyboard fail to send.
* **Failures are visible.** A model call that ends with an error or hits the max-token limit is
  reported in chat — pi-telegram never swallows it. A prompt that pi refuses to run at all (no
  model, no provider key) is caught by a watchdog after 8s, and a run that finishes with nothing to
  show says so too. Provider errors are scanned for keys, bearer tokens and URL paths before they
  reach the chat (`redactSecrets`), and internal bridge errors go to the pi UI, the logs and the chats.
* **A notification cannot kill pi.** A ctx that pi invalidated (reload, session replacement) throws
  whenever it is used. Every cosmetic terminal notice goes through a guard, so a failed start or a
  dropped “connected as …” message is logged and forgotten instead of becoming an unhandled rejection
  that takes the pi process down.
* **Serialization.** Updates are queued per chat, and outbound transcript events are processed in
  order, so an answer always arrives before its tool summary and one slow action cannot freeze the
  other chats.
* **One poller per token.** Telegram returns `409` if two processes poll with the same token — the
  extension tells you in the pi UI instead of retrying silently.

## Development

```bash
npm run typecheck                  # tsc, strict
npm run smoke                      # 151 assertions against a fake pi + mock Telegram (offline)
npm run live                       # real pi (rpc mode) + mock Telegram Bot API
PI_TG_LIVE_SRC="$HOME/.pi/agent" PI_TG_LIVE_EXT=1 PI_TG_LIVE_MASK=1 \
  PI_TG_LIVE_OPEN_SESSION="<session.jsonl>" npm run live
PI_TG_DEBUG=1 npm run live         # bridge diagnostics on stderr
npm run probe -- "<session.jsonl>" # narrow probe of resume/fork/tree taps
```

* `scripts/smoke.ts` drives the real extension through a fake `ExtensionAPI` and a local HTTP server
  that speaks the Telegram Bot API (`TELEGRAM_API_ROOT`), so the whole stack runs offline: pairing,
  prompts, streaming drafts, keyboards, attachments, session replacement, provider failures,
  chunking.
* `scripts/live-check.ts` starts **real pi** in `--mode rpc` against that same mock Bot API, which
  catches real pi object shapes. It answers pi `extension_ui_request` dialogs so blocking dialogs
  (fork confirmation) do not hang the run. `PI_TG_LIVE_MASK=1` masks session titles and prompts in
  the console output; `PI_TG_LIVE_SESSIONS=1` also copies real session files.
* Both suites create throwaway agent/session dirs, so they never touch your own `~/.pi/agent`.
