# pi-telegram

**실행 중인 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 세션을 Telegram에서 제어하세요.**

세션의 주인은 계속 pi입니다. 이 확장은 터미널에 보이는 것을 미러링하고, Telegram 텍스트·첨부파일을 pi
프롬프트로 바꾸며, 중요한 pi 명령을 인라인 키패보드가 달린 채팅 명령으로 다시 구현합니다.
실행 중인 pi 세션 1개 ↔ Telegram 채팅 하나 또는 여러 개.

[English README](README.md)

```
Telegram  ──poll──▶  bridge  ──▶  프롬프트, /명령, 버튼 누름
   ▲                   │
   └── HTML 메시지 ────┘  답장, 도구 요약, thinking, 실패 알림
```

## 설치

```bash
pi install git:github.com/sonic240612/pi-telegram

# 개발 중에는 로컬 체크아웃도 가능
pi install /path/to/pi-telegram
```

npm에서 설치할 때는 **scoped** 이름을 쓰세요. npm의 `pi-telegram`은 남의 패키지입니다.
`package.json`은 이미 `@sonic240612/pi-telegram`으로 맞춰져 있으므로, 게시만 되면
`pi install npm:@sonic240612/pi-telegram`도 동작합니다. 나중에라도 scopes 없는 것을 설치했다면
먼저 `pi remove npm:pi-telegram` — 같은 봇 토큰에 브리지가 두 개 붙으면 서로 싸웁니다.

확장 진입점은 `index.ts`입니다(`package.json`의 `pi.extensions`에 선언). 설치 후에는 pi를 재시작하거나
실행 중인 pi에서 `/reload`를 치세요.

업데이트: `pi update --extensions`가 git 설치본을 다시 받아 주고, 그 뒤 pi 재시작 또는 `/reload`.

## 설정

1. [@BotFather](https://t.me/BotFather)에서 봇을 만들고 토큰을 복사합니다.
2. pi를 켜고 토큰을 한 번만 설정합니다(`~/.pi/agent/telegram.json`에 `0600`으로 저장):

   ```
   /telegram-setup 8161521009:AAA…
   ```

   다른 방법: `TELEGRAM_BOT_TOKEN=… pi`, 또는 `pi --telegram-token <token>`.
   연결 없이 확장만 올리려면 `pi --telegram-off`.
3. 봇에게 아무 메시지나 보냅니다(예: `/start`). pi-telegram이 그 채팅을 *pending*으로 등록하고
   pi 터미널에 코드를 띄웁니다.
4. pi에서 승인합니다:

   ```
   /telegram-pair          # 대기 목록 확인
   /telegram-pair 482913   # 하나 허용
   ```

코드는 승인되지 않은 채팅으로 절대 보내지지 않고, 승인 전 채팅에는 pairing 안내만 보입니다.
다섯 번 틀리면 코드가 회전하고 그 채팅은 잠시 정지되며, pi 터미널에 알려 줍니다.

## Telegram에서 쓰기

pi에 치듯 텍스트를 보내면 pi 프롬프트가 됩니다. 사진은 image input으로, 텍스트 파일(`.ts`, `.md`,
`.json` …)은 본문으로 펼쳐서, 그 외 첨부는 설명 안내로 처리됩니다.

### 둘러보기

| 명령 | 인자 | 동작 |
| --- | --- | --- |
| `/help` (별칭 `/start`) | — | 전체 명령 목록 + 단축 버튼 몇 개. 아래 내용을 채팅으로 그대로 보여 줍니다. |
| `/menu` | — | 버튼만 있는 메뉴: model / thinking / tools / new / resume / fork / status / usage / abort. |
| `/commands` (별칭 `/prompts`) | `[filter]`, 페이지 버튼 | pi·확장·prompt-template 명령 전부, 누르면 실행. `/commands review`로 필터. |
| `/skills` | 키패보드로 선택 | pi skill 실행(`/skill:<name>`). |

### 세션과 컨텍스트

| 명령 | 인자 | 동작 |
| --- | --- | --- |
| `/new` | — | 새 세션. 브리지가 다시 만들어진 뒤 확인 메시지가 도착합니다(세션 교체 참고). |
| `/resume` `[query]` | 필터 텍스트 | 세션 선택 키패보드. 현재 프로젝트 우선, 다른 프로젝트 세션은 `·project` 표시. `/resume deploys`처럼 필터. |
| `/fork` `[message]` | 키패보드로 선택 | 이전 프롬프트에서 분기 — 새 세션으로 열립니다. |
| `/tree` | 키패보드로 선택 | 세션 트리의 다른 노드로 이동. |
| `/rename` `<name>` | 새 이름, 예 `/rename auth refactor` | 세션 이름 변경. `/name`도 별칭. |
| `/compact` `[instructions]` | 예 `/compact keep the test failures` | 컨텍스트 압축. 실행 중에는 거절됩니다(먼저 `/abort`). pi가 압축한다는 사실을 채팅에 알려 줍니다 — “압축을 볼 수 있습니다” 참고. |
| `/export` | — | 세션 `.jsonl` 파일을 채팅으로 전송. |
| `/usage` | — | 컨텍스트 창 사용량: 토큰 수, 창 크기, 백분율. |
| `/status` (별칭 `/session`) | — | 봇, model, thinking level, 세션 이름/파일, cwd, uptime, pending 채팅, verbosity, streaming. |

### model, thinking, tools

| 명령 | 인자 | 동작 |
| --- | --- | --- |
| `/model` | — | model 선택 키패보드. **내 머신**이 띄운 model(llama.cpp, ollama, lmstudio)이 먼저, `🏠` 표시로 옵니다. 목록이 사람이 넘길 수 없을 만큼 크면(openrouter) 먼저 **provider**로 Drill-down합니다(`🗂`). |
| `/model <name\|filter>` | 예 `/model glm` | **pi가 아는 모든** model에서 검색합니다(available 목록만이 아니라). 순위를 매기고 애매하지 않으면 바로 전환. `/models`도 별칭. |
| `/model <provider>` | 예 `/model openrouter` | provider 전체를 한 번에 필터; 목록은 80개에서 잘립니다(`✂️`) — 끝없이 페이지 넘기는 대신 더 좁힌 검색어를 요구합니다. |
| `/model <provider/id>` | 예 `/model openrouter/anthropic/claude-sonnet-4.5` | 정확한 id 지정 — pi가 available 목록에 올리지 않는 id도. |
| `/model <aggregator id>` | 예 `/model nvidia/nemotron-3.5-super-vl:free` | OpenRouter가 쓰는 그대로의 id(`openrouter/` 접두어 없이). 브리지가 그 id를 소유한 provider를 찾아 적용합니다. pi가 **단 한 번도** 본 적 없는 id도 적용됩니다: 같은 provider의 다른 model 설정을 빌려오고 그렇게 말합니다(`✨`). |
| `/thinking` `[level]` | `off`, `minimal`, `low`, `medium`, `high` | 인자 없음 → 키패보드; level 지정 → 설정. |
| `/tools` | `list`, `<tool name>` | 인자 없음 → 모든 도구 키패보드(활성 ✓, `reset` 버튼). `/tools bash`는 그 도구 하나만 토글. |

### 실행과 조종

| 명령 | 인자 | 동작 |
| --- | --- | --- |
| `/abort` (별칭 `/stop`, `/cancel`) | — | 현재 실행 중단. 대기 중일 때는 아무것도 하지 않는다고 알려 줍니다. |
| `/steer <text>` | 지시문 | 진행 중인 turn에 지시를 주입. |
| `/queue <text>` (별칭 `/followup`) | 지시문 | 현재 실행이 끝난 뒤 전달. |
| `/bash <command>` | 셸 명령 | 세션 cwd에서 실행. 약 3000자 초과 출력은 `.txt` 파일로 도착. |
| `/reload` | — | 확장 재로드(pi 런타임 재시작, 브리지는 재연결). |

### 출력 제어

| 명령 | 인자 | 동작 |
| --- | --- | --- |
| `/verbose` `[0\|1\|2]` | level | `0` 답장만 · `1`(기본) 답장 + 도구 요약 · `2` 전체 transcript 미러링. |
| `/stream` `[on\|off]` | `on` / `off` | pi가 답을 쓰는 동안 초안 메시지를 실시간 편집. |
| `/ping` | — | 왕복 점검: 봇 이름 + 지연시간. |
| `/stats` | — | 지연 기록(`/tg stats`와 동일; long poll은 따로 세서 느린 전송처럼 보이지 않습니다). |

### 브리지 관리

| 명령 | 인자 | 동작 |
| --- | --- | --- |
| `/pair` | — | 이 채팅의 pairing 코드 표시 / pending 채팅 목록. |
| `/chats` | — | 허용된 채팅 목록(`unpair` 버튼 포함). |
| `/pending` | — | 승인 대기 채팅과 코드. |
| `/unpair` | — | 나가기: *이* 채팅을 해제(다른 채팅은 `/chats`의 버튼으로 해제). |
| `/restart` | — | 브리지 재연결(poll loop, menu, token). |
| `/tg status` | — | 브리지 전체 상태: 봇, 채팅, offset, verbosity, streaming, 마지막 오류. |
| `/tg pair` · `/tg pending` | — | pairing 안내 / 대기 목록. |
| `/tg unpair` (별칭 `/tg leave`) | — | 이 채팅 해제. |
| `/tg chats` | — | 허용된 채팅. |
| `/tg restart` | — | 재연결. |
| `/tg verbose [0\|1\|2]` · `/tg stream [on\|off]` | | 위 최상위 명령과 동일. |
| `/tg stats` (별칭 `/tg latency`) | — | Telegram 호출 수 / 평균 / 최대, poll 수, 느린 호출, 429, 그리고 프롬프트 → 실행 시작 지연. 답이 느린 이유가 pi 생각인지 네트워크인지 알려 줍니다. |
| `/tg menu` | — | “/” 자동완성 메뉴를 다시 등록하고 Telegram이 실제로 뿌려 주는 목록을 확인합니다. 자동완성이 이상할 때 사용(아래 참고). |
| `/tg redact [on\|off]` · `/tg redact transcript [on\|off]` | | 브리지가 Telegram용으로 만드는 사본에 credential 마스킹을 얼마나 적용할지 제어(`/bash` 출력은 기본으로 마스킹, 미러링되는 transcript는 기본으로 마스킹하지 않음). |

### 자동완성에 대해 알아 둘 것

Telegram의 “/” 팝업은 `setMyCommands`로 만들어지고, **더 구체적인 scope가 기본 scope를 덮어씁니다**.
pi-telegram은 접속 시 기본 scope와 `all_private_chats` scope 양쪽에 메뉴를 등록하고 다시 읽어 옵니다.
Telegram이 주는 목록에서 우리 명령이 빠져 있으면 브리지가 알려 줍니다 — 보통 **다른 프로그램이 같은 봇
토큰을 쓰고 있다는** 뜻입니다(예전 pi-telegram 설치본, pi 프로세스 두 개). 해결: 다른 프로세스를 끄고
`/tg menu` 또는 `/restart`.

팝업에 없는 명령도 동작은 합니다: 직접 치면 됩니다. `/help`는 언제나 전부를 보여 줍니다.

### 그대로 통과되는 명령

그 외 `/name`은 pi로 넘어가므로 아래도 Telegram에서 그대로 동작합니다:

* 확장 명령(`/review`, `/ast-grep` …),
* skill(`/skill:pdf …`),
* prompt template(`/mytemplate args`),
* 헤드리스(터미널 UI 없이)로도 의미 있는 pi 내장 명령.

터미널 전용 명령(`/settings`, `/import`, `/hotkeys`, `/clone`, `/trust`, `/login` …)은 조용히
읽어 버리는 대신 안내 문구로 답합니다.

### Telegram 대신 pi(터미널)에서 쓰는 명령

| 명령 | 동작 |
| --- | --- |
| `/telegram status\|start\|restart\|stop` | 브리지 라이프사이클 |
| `/telegram token <token>` | 봇 토큰 저장 |
| `/telegram pair [code]` · `/telegram add <chat_id>` | 대기 중인 채팅 승인 |
| `/telegram chats` | 허용된 채팅 |
| `/telegram verbose <0\|1\|2>` | 출력 단계 |
| `/telegram-setup` | @BotFather에서 받은 토큰 저장 후 연결 |
| `/telegram-pair [code]` | 대기 채팅 승인(코드는 pi UI에만 보이고 승인 전 채팅으로는 보내지 않음) |
| `/telegram-chats` | 허용된 채팅 목록 |
| `/telegram-verbose <0\|1\|2>` | 출력 단계 |

CLI 플래그: `pi --telegram-token <token>`(저장 없이 한 번), `pi --telegram-off`(확장은 올리되 연결하지 않음).

pi/확장/prompt-template 실제 명령이면 나머지는 전부 그대로 통과됩니다(`/review`, `/skill:pdf` …).
터미널에서만 의미 있는 명령(`/settings`, `/import`, `/hotkeys` …)은 침묵 대신 안내로 답합니다.

나가는 쪽: 답장은 pi의 markdown 형태를 유지합니다(제목, 굵게, 글머리 목록, GitHub 표는 정렬된
monospace로, code fence는 조각을 넘어도 균형이 유지되게). 긴 답장은 글자를 잃지 쪼개며, 조용히 잘리는
것은 없습니다.

## 출력 단계(verbosity)

| 단계 | Telegram에 보이는 것 |
| --- | --- |
| `0` | 답장만 |
| `1` (기본) | 답장 + turn당 도구 요약 한 줄 |
| `2` | 전체 transcript: thinking, tool call, tool 결과, usage footer |

`/verbose 2`로 설정, pi에서는 `/telegram-verbose 2`.

## model이 호출할 수 있는 도구

* `telegram_send` — 허용된 채팅으로 텍스트·파일 전송.
* `telegram_ask` — 버튼을 달아 질문하고 답을 누르길 기다림.

둘 다 pairing을 통과한 채팅에만 전달됩니다. `telegram_ask`는 `chat_id`로 지정한 채팅(없으면 첫 허용
채팅)에 묻고, 그 채팅의 버튼 누름만 유효합니다.

`telegram_send path=…`는 pi가 읽을 수 있는 모든 파일을 첨부합니다. 프롬프트 인젝션을 당한 model에게는
그대로 유출 경로가 됩니다 — `~/.ssh/id_rsa`를 읽어 당신의 폰으로 보낼 수 있습니다. 첨부할 때마다
pi 터미널에 알려 주니 실시간으로 알 수 있지만, 진짜 조절은 그 도구 자체를 둘지 말지입니다. 원치 않으면
pi의 도구 목록에서 빼세요.

## 설정 파일

`~/.pi/agent/telegram.json`:

| 키 | 의미 |
| --- | --- |
| `token` | 봇 토큰(`/telegram-setup`이 기록, 파일 모드 `0600`) |
| `chats` | 허용된 채팅 `[{ chatId, label, name }]` |
| `verbosity` | `0` / `1` / `2` |
| `streaming` | pi가 스트리밍하는 동안 초안 실시간 편집 |
| `announce` | 연결/해제 공지 |
| `redactBash` | 브리지가 Telegram으로 복사하는 `/bash` 출력에서 credential처럼 보이는 문자열 마스킹(기본 `true`) |
| `redactTranscript` | 미러링되는 transcript도 마스킹(기본 `false` — detail 모드는 터미널과 같아야 하므로) |
| `offset` | 마지막으로 처리한 Telegram `update_id`(재시작에도 유지되어 재전송 없음) |

환경 변수: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ROOT`(Bot API base — 오프라인 테스트가 사용),
`PI_TG_DEBUG=1`(진단 정보는 stderr에만, 채팅으로는 절대 보내지 않음).

## 알아 둘 동작

* **압축을 볼 수 있습니다.** pi는 컨텍스트를 다시 만드는 동안 새 프롬프트를 막지만, Telegram 입장에서는
  그것이 조용히 일어나고 있었습니다. 이제 브리지가 선포합니다 — `🗜 컨텍스트 압축 중…`에 컨텍스트 크기와
  트리거(`/compact`, 컨텍스트 임계값, overflow 복구(이후 pi가 중단된 turn을 재시도))를 담아 보이고,
  마지막에 `✅ 컨텍스트 압축 완료`와 토큰 변화·소요 시간, 혹은 이유를 담은 `⚠️ 컨텍스트 압축 실패/중단`
  (마스킹됨)을 붙입니다. 그 사이에 보낸 메시지는 사라지지 않고 쌓아 뒀다가 압축이 끝날 때 전달됩니다.
* **채팅 기록은 다시 쓰지 않습니다.** 스트리밍 답장은 터미널이 다시 그리듯 초안 메시지를 그 자리에서
  편집합니다. 초안에 완성된 답이 담기는 순간 봉인됩니다 — 다음 turn은 *새* 메시지에 쓰고, 이미 읽은 답은
  채팅에 남아 있습니다. “⏳ 생각 중…”만 떠 있던 초안만 삭제됩니다.
* **pi가 일하는 중이라는 걸 알 수 있습니다.** 실행 중에는 Telegram의 “입력 중…” 상태를 약 4.5초마다
  갱신하고(스스로 약 5초 후 만료) 실행이 끝나면 즉시 멈춥니다.
* **전송 경로는 세 갈래로 분리됩니다.** Long polling(`getUpdates`, 최대 25초 유지), 메시지 전송, 보조
  힌트(`sendChatAction`)는 절대 같은 큐를 쓰지 않습니다. 대기 중인 poll이나 끊긴 typing 힌트가 답을
  늦출 수 없습니다 — “답이 20초 뒤에 왔다”의 원인이 바로 그거였습니다. 모든 요청에는 시간 예산도
  있습니다(20초, poll은 35초) — 연결이 굳으면 전송 레인이 멈추는 대신 큰 소리로 실패하고,
  `429 retry_after`는 지키고 기록합니다.
* **측정 값: `/tg stats`.** Telegram 왕복 지연(호출 수 / 평균 / 최대), 최근 가장 느린 호출들, Telegram이
  우리를 제한한 횟수, 그리고 pi가 각 실행을 시작하기까지 걸린 시간(프롬프트 → 실행 시작)을 보여 줍니다.
  느린 답이 pi 생각 때문인지 네트워크 때문인지 알 수 있습니다 — 왕복 자체 늦으면 `TELEGRAM_API_ROOT`
  안내가 함께 뜹니다.
* **로컬 model이 먼저.** pi는 provider의 credentials를 스스로 인정할 수 있을 때만 model을 “available”이라
  부르므로, `models.json`에서 `127.0.0.1` / `localhost`를 가리키는 provider(llama.cpp, ollama, lmstudio,
  vLLM …)는 pi의 available 목록에 닿지 않습니다 — 게다가 `models.json`에 선언된 model은 `type` 자체가
  없어서 예전에는 그것까지 필터링됐습니다. 브리지가 그 model을 전체 registry에서 되찾아 `🏠`로 표시하고
  cloud model 위에 배치합니다(사용 중인 model은 맨 위에 고정). key가 없는 *cloud* model은 로컬로
  취급하지 않습니다(의도적으로).
* **엄청난 provider도 쓸 수 있게.** OpenRouter 설정은 model을 약 1600개 압니다. 그래서 `/model`은 화면을
  130장 넘기는 대신 provider부터 고르게 하고, `/model <provider>`는 provider 하나를 필터(80개 초과 시
  `✂️`로 잘림), `/model <provider/id>`는 available 목록 여부와 상관없이 전체 registry로 해석합니다. aggregator
  id에는 제조사가 들어 있으므로 provider가 쓰는 그대로 칠 수 있습니다:
  `/model nvidia/nemotron-3.5-super-vl:free` → `openrouter/nvidia/nemotron-3.5-super-vl:free`, 그리고
  답장에 어떻게 해석했는지 표시합니다. pi가 단 한 번도 본 적 없는 model id도 쓸 수 있습니다 — 같은 provider의
  다른 model 모양을 빌리고 `✨`로 표시합니다. `🔑`는 pi에 그 provider의 인증 정보가 없다는 뜻입니다
  (pi에서 `/login`으로 설정), `🚫`는 provider조차 특정하지 못했다는 뜻입니다.
* **압축이 내 메시지를 먹지 않습니다.** pi는 컨텍스트를 다시 만드는 동안 프롬프트를 거절하고(“Cannot
  submit a prompt while compaction is in progress”) 그걸 내부적으로만 보고하므로, 압축 중에 보낸 채팅
  메시지는 오류와 함께 사라지곤 했습니다. 이제 브리지가 `session_before_compact`, `session_compact`,
  `session_compact_failed`를 감시하고 그런 메시지를 쌓아 뒀다가(몇 개 대기 중인지 알려 주고) pi가 다시
  프롬프트를 받을 수 있는 순간 재전송합니다 — pi 터미널이 하는 것과 같은 방식입니다. 가지 요약을 생성하는
  tree 이동도 같은 잠금을 쓰고, 압축이 실패하면 대기열을 풀어 줍니다.
* **세션 교체.** `/new`, `/resume`, `/fork`, `/reload`는 pi가 세션을 걷어 내고 확장을 다시 만들기 때문에
  브리지 인스턴스도 교체됩니다. 사라지는 인스턴스는 확인 메시지를 넘겨 주고(설정 파일의 `pendingNotice`,
  TTL 5분) 새 인스턴스가 그것을 다시 띄우므로, 채팅에는 여전히 “🌱 새 세션 시작”이 도착합니다. 이
  인수인계는 update offset과 같은 이유로 파일에 저장됩니다 — 재시작을 견뎌야 하니까요.
* **키패보드는 만료됩니다.** 버튼은 수명 있는 서버측 토큰을 가집니다(30분, 개수 제한). 세션 교체 전에
  그려진 키패보드는 아무 반응 대신 “이 버튼은 만료됐어요”라고 답하고 스스로 사라집니다.
* **키패보드가 Telegram에 거부당하지 않습니다.** 버튼 텍스트는 64자, 메시지 텍스트는 4096자로 클라이언트
  경계에서 잘립니다 — 긴 세션 제목이나 model 이름이 통째로 키패보드 전송을 실패시키는 일이 없도록.
* **실패는 눈에 보입니다.** model 호출이 오류로 끝나거나 max-token 한도에 닿으면 채팅에 보고합니다 —
  pi-telegram은 삼키지 않습니다. pi가 아예 실행을 거부한 프롬프트(model 없음, provider key 없음)는 8초 후
  watchdog이 잡아내고, 아무것도 보여 줄 것 없이 끝난 실행도 그렇게 말합니다. provider 오류는 채팅에 닿기
  전에 key, bearer token, URL 경로를 지운 뒤(`redactSecrets`) 보내고, 브리지 내부 오류는 pi UI·로그·채팅으로
  보냅니다.
* **직렬화.** 업데이트는 채팅별로 큐에 쌓이고, 나가는 transcript 이벤트는 순서대로 처리되므로 답은 언제나
  도구 요약보다 먼저 도착하고, 느린 동작 하나가 다른 채팅을 얼리지 못합니다.
* **토큰당 폴러는 하나.** 두 프로세스가 같은 토큰으로 poll하면 Telegram은 `409`를 돌려보냅니다 — 확장은
  조용히 재시도하는 대신 pi UI에 알려 줍니다.

## 개발

```bash
npm run typecheck                  # tsc, strict
npm run smoke                      # 가짜 pi + 모의 Telegram 대상 151개 assertions (오프라인)
npm run live                       # 실제 pi (rpc mode) + 모의 Telegram Bot API
PI_TG_LIVE_SRC="$HOME/.pi/agent" PI_TG_LIVE_EXT=1 PI_TG_LIVE_MASK=1 \
  PI_TG_LIVE_OPEN_SESSION="<session.jsonl>" npm run live
PI_TG_DEBUG=1 npm run live         # 브리지 진단은 stderr로
npm run probe -- "<session.jsonl>" # resume/fork/tree 버튼 누름만 좁게 점검
```

* `scripts/smoke.ts`는 실제 확장을 가짜 `ExtensionAPI`와 Telegram Bot API를 흉내 내는 로컬 HTTP 서버
  (`TELEGRAM_API_ROOT`)로 굴립니다 — 전체 스택이 오프라인으로 돌아갑니다: pairing, 프롬프트, 스트리밍
  초안, 키패보드, 첨부, 세션 교체, provider 실패, 메시지 조각내기.
* `scripts/live-check.ts`는 같은 모의 Bot API를 상대로 **실제 pi**를 `--mode rpc`로 띄웁니다 — 실제 pi의
  객체 형태를 잡아냅니다. pi의 `extension_ui_request` 대화상자에 답하므로(fork 확인 같은) 막히는
  대화상자가 실행을 멈추지 않습니다. `PI_TG_LIVE_MASK=1`은 콘솔 출력에서 세션 제목·프롬프트를 마스킹하고,
  `PI_TG_LIVE_SESSIONS=1`은 실제 세션 파일도 복사합니다.
* 두 검사 모두 임시 agent/session 디렉터리를 쓰므로 내 `~/.pi/agent`를 건드리지 않습니다.
