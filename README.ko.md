# pi-telegram

**실행 중인 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 세션을 Telegram에서 제어하세요.**

[English README](README.md)

세션의 소유권은 항상 pi가 유지합니다. 이 확장은 터미널에 표시되는 내용을 미러링하고, Telegram 메시지와 첨부 파일을 pi 프롬프트로 변환하며, 중요한 pi 명령어를 인라인 키보드가 포함된 채팅 메시지로 구현하여 다시 실행할 수 있게 해줍니다.
실행 중인 하나의 pi 세션 ↔ 하나 이상의 Telegram 채팅이 연결됩니다.

```text
Telegram  ──poll──▶  bridge  ──▶  프롬프트, /명령어, 키보드 입력
   ▲                   │
   └── HTML 메시지 ────┘  응답, 도구 요약, 사고 과정(Thinking), 오류 보고
```

## 설치하기

```bash
pi install git:github.com/sonic240612/pi-telegram

# 개발 중인 경우 로컬 체크아웃 경로 사용
pi install /path/to/pi-telegram
```

npm을 통해 설치할 때는 **범위가 지정된(scoped)** 이름을 사용하세요. 일반 `pi-telegram`은 이미 다른 사람이 사용 중인 패키지입니다. `@sonic240612/pi-telegram`으로 설정되어 있으므로, 나중에 배포되면 `pi install npm:@sonic240612/pi-telegram`으로도 설치 가능합니다. 이전에 일반 `pi-telegram`을 설치했다면 먼저 `pi remove npm:pi-telegram`을 실행하세요. 하나의 봇 토큰에 두 개의 브리지가 연결되면 서로 충돌이 발생할 수 있습니다.

확장의 진입점은 `index.ts`입니다 (`package.json`의 `pi.extensions`에 선언됨). 설치 후에는 pi를 재시작하거나(또는 실행 중인 pi에서 `/reload` 입력) 하세요.

업데이트: `pi update --extensions`를 실행하여 git 설치 버전을 동기화한 뒤, pi를 재시작하거나 `/reload`합니다.

## 설정하기

1. [@BotFather](https://t.me/BotFather)를 통해 봇을 생성하고 토큰을 복사합니다.
2. pi를 실행하고 토큰을 한 번만 설정합니다 (토큰은 `~/.pi/agent/telegram.json`, 권한 `0600`으로 저장됩니다):

   ```text
   /telegram-setup 8161521009:AAA…
   ```

   다른 방법으로는 환경 변수 `TELEGRAM_BOT_TOKEN=… pi` 또는 `pi --telegram-token <token>`을 사용할 수 있습니다. 연결 없이 확장 기능만 로드하려면 `pi --telegram-off`를 사용하세요.
3. 봇에게 아무 메시지나 보냅니다 (예: `/start`). 그러면 `pi-telegram`이 해당 채팅을 *대기 중(pending)* 상태로 등록하고, pi 터미널에 짧은 코드를 출력합니다.
4. pi에서 승인합니다:

   ```text
   /telegram-pair          # 대기 중인 채팅 목록 확인
   /telegram-pair 482913    # 특정 채팅 승인
   ```

승인되지 않은 채팅에는 코드가 전송되지 않으며, 대신 페어링 안내 메시지만 전달됩니다. 코드를 5번 잘못 입력하면 해당 채팅의 대기 시간이 늘어나며 pi 터미널에 상태가 표시됩니다.

## Telegram에서 사용하기

pi에 직접 타이핑하는 것처럼 텍스트를 보내세요. 이는 pi 프롬프트로 변환됩니다. 사진은 이미지 입력으로 전송되고, 텍스트 파일(`.ts`, `.md`, `.json` 등)은 인라인화되며, 기타 첨부 파일은 설명 메시지와 함께 전달됩니다.

### 명령어 및 탐색

| 명령어 | 인자 | 설명 |
| --- | --- | --- |
| `/help` (alias `/start`) | — | 바로가기 버튼이 포함된 전체 명령어 목록을 표시합니다. 아래의 모든 명령어를 채팅에서 사용할 수 있습니다. |
| `/menu` | — | 버튼 전용 메뉴: 모델 / 사고 과정(thinking) / 도구 / 새로 만들기 / 재개 / 포크 / 상태 / 사용법 / 중단. |
| `/commands` (alias `/prompts`) | `[filter]`, 페이지 전환 버튼 | 모든 pi, 확장 기능 및 프롬프트 템플릿 명령어를 보여줍니다. 버튼을 눌러 실행할 수 있습니다. `/commands review`로 필터링 가능합니다. |
| `/skills` | 키보드에서 선택 | pi 스킬을 실행합니다 (`/skill:<이름>`). |

### 세션 및 컨텍스트

| 명령어 | 인자 | 설명 |
| --- | --- | --- |
| `/new` | — | 새 세션을 시작합니다. 브리지 재생성 후 확인 절차를 거칩니다 (세션 교체 방식 참고). |
| `/resume` `[query]` | 필터 텍스트 | 세션 선택 키보드를 띄웁니다. 현재 프로젝트의 세션이 먼저 나타나며, 그 후 `·project` 태그가 붙은 다른 프로젝트의 세션들이 표시됩니다. |
| `/fork` `[message]` | 키보드에서 선택 | 이전 프롬프트 시점으로 세션을 분기(branch)합니다. |
| `/tree` | 키보드에서 선택 | 세션 트리 내의 다른 노드로 이동합니다. |
| `/rename` `<name>` | 새 이름 (예: `/rename auth refactor`) | 세션 이름을 변경합니다. `/name`이 별칭입니다. |
| `/compact` `[instructions]` | 예: `/compact 테스트 실패 결과는 유지해줘` | 컨텍스트 압축(Context compaction)을 수행합니다. 실행 중인 작업이 있을 때는 사용할 수 없으며 (`/abort` 선행 필요), 완료 시 채팅으로 알려줍니다 ("압축 시각화" 섹션 참고). |
| `/export` | — | 세션의 `.jsonl` 파일을 채팅으로 전송합니다. |
| `/usage` | — | 컨텍스트 윈도우 사용량(토큰, 윈도우 크기, 백분율)을 표시합니다. |
| `/status` (alias `/session`) | — | 봇 상태, 모델, 사고 수준, 세션 이름/파일, 현재 디렉터리(cwd), 가동 시간, 대기 중인 채팅, 상세도(verbosity), 스트리밍 여부 등을 표시합니다. |

### 모델, 사고 과정, 도구

| 명령어 | 인자 | 설명 |
| --- | --- | --- |
| `/model` | — | 인라인 키보드로 모델을 선택합니다. **내 컴퓨터**에서 실행 중인 모델(llama.cpp, ollama, lmstudio)이 `🏠` 표시와 함께 가장 먼저 나타납니다. 목록이 너무 길 경우(OpenRouter 등) **프로바이더** 단위로 탐색할 수 있도록 `🗂` 메뉴가 제공됩니다. |
| `/model <name\|filter>` | 예: `/model glm` | pi가 알고 있는 모든 모델을 검색하여 순위를 매깁니다. 모호하지 않으면 즉시 해당 모델로 전환합니다. `/models`가 별칭입니다. |
| `/model <provider>` | 예: `/model openrouter` | 특정 프로바이더의 모델만 필터링합니다. 목록은 최대 80개(`✂️`)까지만 표시됩니다. |
| `/model <provider/id>` | 예: `/model openrouter/anthropic/claude-sonnet-4.5` | 정확한 ID를 사용하여 전환합니다 (목록에 없는 모델도 가능). |
| `/model <aggregator id>` | 예: `/model nvidia/nemotron-3.5-super-vl:free` | OpenRouter 형식을 그대로 사용합니다. 브리지가 해당 ID의 프로바이더를 찾아 자동으로 연결합니다. pi가 모르는 ID라도 형식이 맞으면 sibling 모델 설정을 빌려와서 실행하며 `✨` 표시를 남깁니다. |
| `/thinking` `[level]` | `off`, `minimal`, `low`, `medium`, `high` | 인자가 없으면 키보드를, 있으면 해당 단계로 설정합니다. |
| `/tools` | `list`, `<도구 이름>` | 모든 도구 목록을 보여줍니다 (활성화된 것은 ✓ 표시). `/tools bash`로 특정 도구를 끄거나 켤 수 있습니다. |

### 실행 및 제어

| 명령어 | 인자 | 설명 |
| --- | --- | --- |
| `/abort` (alias `/stop`, `/cancel`) | — | 현재 진행 중인 작업을 중단합니다. 유휴 상태일 때는 아무 일도 일어나지 않습니다. |
| `/steer <text>` | 지시 사항 | 실행 중인 턴에 새로운 지침을 주입합니다. |
| `/queue <text>` (alias `/followup`) | 지시 사항 | 현재 작업이 끝난 후 전달할 지시를 예약합니다. |
| `/bash <command>` | 셸 명령 | 세션의 `cwd`에서 실행됩니다. 3,000자 이상의 출력은 `.txt` 파일로 전달됩니다. |
| `/reload` | — | 확장 기능을 재로드합니다 (pi 런타임 재시작 및 브리지 재연결). |

### 출력 제어

| 명령어 | 인자 | 설명 |
| --- | --- | --- |
| `/verbose` `[0\|1\|2]` | 단계 | `0`: 답변만 표시 · `1`(기본값): 답변 + 도구 요약 · `2`: 전체 트랜스크립트(사고 과정 포함) 미러링. |
| `/stream` `[on\|off]` | `on` / `off` | pi가 답변을 작성하는 동안 실시간으로 편집되는 초안을 보여줍니다. |
| `/ping` | — | 연결 상태 확인: 봇 이름과 지연 시간(latency)을 표시합니다. |
| `/stats` | — | 지연 시간 통계 (Telegram 응답 속도, 폴링 횟수 등을 포함하여 pi의 사고 시간과 네트워크 지연을 구분할 수 있게 해줍니다). |

### 브리지 관리

| 명령어 | 인자 | 설명 |
| --- | --- | --- |
| `/pair` | — | 현재 채팅의 페어링 코드를 보여주거나 대기 중인 채팅 목록을 표시합니다. |
| `/chats` | — | 페어링된 채팅 목록 (각 채팅에 `unpair` 버튼 포함). |
| `/pending` | — | 승인을 기다리는 채팅 목록과 코드 표시. |
| `/unpair` | — | 현재 채팅의 연결을 해제합니다. |
| `/restart` | — | 브리지를 재연결합니다 (폴링 루프, 메뉴, 토큰 재설정). |
| `/tg status` | — | 상세 브리지 상태: 봇 정보, 채팅 목록, 오프셋, 스트리밍 여부, 마지막 오류 등. |
| `/tg pair` · `/tg pending` | — | 페어링 도움말 / 대기 목록 확인. |
| `/tg unpair` (alias `/tg leave`) | — | 현재 채팅의 연결을 해제합니다. |
| `/tg chats` | — | 페어링된 채팅 목록. |
| `/tg restart` | — | 재연결. |
| `/tg verbose [0\|1\|2]` · `/tg stream [on\|off]` | | 위 상단 명령어와 동일하게 작동합니다. |
| `/tg stats` (alias `/tg latency`) | — | Telegram 호출 횟수, 평균/최대 지연 시간 등을 표시하여 응답이 느린 원인이 pi인지 네트워크인지를 알려줍니다. |
| `/tg menu` | — | Telegram의 "/" 자동 완성 메뉴를 다시 등록합니다. 메뉴가 비정상적으로 보일 때 사용하세요. |
| `/tg redact [on\|off]` · `/tg redact transcript [on\|off]` | | Telegram으로 복사되는 데이터에서 민감 정보(자격 증명 등)를 마스킹할 범위를 설정합니다 (`/bash` 출력은 기본적으로 마스킹됨). |
| `/tg goal` | — | `pi-goal-x`가 세션에 기록해 둔 goal을 그대로 보여줍니다: 상태, 작업 진행률, 사용 토큰, 중단 사유. `/status`에도 한 줄로 요약되어 나타납니다. |

### 자동 완성 (Autocomplete) 주의사항

Telegram은 `setMyCommands`를 통해 "/" 팝업 메뉴를 생성하며, **더 구체적인 범위(scope)가 지정되면 기본값보다 우선 적용됩니다.** `pi-telegram`은 연결 시 '기본' 및 '모든 개인 채팅' 범위에 모두 메뉴를 등록합니다. 만약 메뉴에서 명령어가 보이지 않는다면, **다른 프로그램이 동일한 봇 토큰을 사용 중일 가능성**이 높습니다 (예: 다른 pi 프로세스). 이 경우 다른 프로세스를 중지하고 `/tg menu` 또는 `/restart`를 실행하세요.

목록에 없는 명령어라도 직접 타이핑하면 작동합니다. `/help`는 항상 전체 목록을 보여줍니다.

### 패스스루(Passthrough) 명령어

그 외의 모든 `/[명령어]` 형식은 pi로 그대로 전달됩니다. 따라서 다음과 같은 명령어를 Telegram에서 바로 사용할 수 있습니다:
* 확장 기능 명령어 (`/review`, `/ast-grep` 등),
* 스킬 실행 (`/skill:pdf ...`),
* 프롬프트 템플릿 (`/mytemplate args`),
* headless 모드에서도 의미 있는 pi 내장 명령어들.

터미널 전용 명령어(`/settings`, `/import`, `/hotkeys`, `/clone`, `/trust`, `/login` 등)는 무시되는 대신 "터미널에서 사용하세요"라는 힌트가 돌아옵니다.

### 다른 확장 기능과 함께 쓸 때

설치된 확장 기능 두 가지는 새로 구현하지 않고 그대로 이어 붙였습니다. 브리지는 그 확장 기능이 pi의 이벤트 버스나 세션 기록에 남기는 정보만 읽습니다. 따라서 상대쪽 이름이나 형태가 바뀌어도 브리지는 깨지지 않고 해당 기능만 조용히 빠집니다.

* **`@juicesharp/rpiv-ask-user-question`** (`ask_user_question`): pi가 설문을 띄우면 페어링된 모든 채팅에 버튼으로 함께 나타납니다. 단일 선택은 첫 번째 탭으로 답이 확정되고, 복수 선택은 ✓를 모았다가 ✅로 제출하며, ✏️를 누르면 다음에 보내는 메시지가 직접 답이 됩니다. 먼저 답한 채팅이 우선하고 나머지 채팅의 카드는 자동으로 닫힙니다. 터미널에서 답해도 폰의 카드는 사라집니다. 이 확장 기능이 호스트 자체 대화상자로 답하는 실행 방식(RPC/ACP — 예를 들어 Zed)에서는 폰으로 답할 수 없고, 그럴 경우 멈추지 않고 그 사실을 알려줍니다.
* **`pi-goal-x`**: goal은 `/tg goal` 카드로 볼 수 있고 `/status` 한 줄에도 요약되어 나타납니다. goal 상태 변화(새 goal, 일시중지, 막힘, 작업 진행)는 상세 설정 1 이상에서 채팅에 알려주며, 긴 작업 기록이 스팸이 되지 않도록 간격이 조절되어 있습니다. goal 자신의 명령어(`/goal`, `/goal-pause` 등)는 그대로 pi-goal-x 소유이고 확인 대화상자는 pi 터미널에 뜨니, 확인이 필요한 명령은 터미널에서 실행하세요.

### Telegram으로 나가는 응답 (Outbound)

pi의 마크다운 형식이 유지됩니다 (헤더, 볼드체, 불렛 포인트, GitHub 스타일 테이블, 코드 블록 등). 답변이 길면 글자 손실 없이 메시지가 분할되어 전송됩니다.

### pi 터미널에서 제어하기 (In pi terminal)

| 명령어 | 설명 |
| --- | --- |
| `/telegram status\|start\|restart\|stop` | 브리지 생명주기 관리 |
| `/telegram token <token>` | 봇 토큰 저장 |
| `/telegram pair [code]` · `/telegram add <chat_id>` | 대기 중인 채팅 승인 |
| `/telegram chats` | 페어링된 채팅 목록 확인 |
| `/telegram-setup` | @BotFather를 통해 토큰을 저장하고 연결 |

CLI 플래그: `pi --telegram-token <token>` (저장 없이 1회용 사용) 및 `pi --telegram-off` (확장은 로드하되 연결은 하지 않음).

### 동작 특성 (알아두면 좋은 점)

* **컨텍스트 압축(Compaction)은 시각화됩니다.** pi가 컨텍스트를 재구축하는 동안에는 새로운 프롬프트를 보낼 수 없으며, 예전에는 이를 Telegram에 알리지 않았으나 이제는 `🗜 컨텍스트 압축 중…`과 같은 메시지로 진행 상황을 알려줍니다. 완료되면 토큰 변화량과 걸린 시간을 함께 보고합니다. 작업 중에 보내는 메시지는 사라지지 않고 대기열에 머물다가 압축이 끝나면 전달됩니다.
* **채팅 기록은 절대 덮어쓰이지 않습니다.** 스트리밍 답변은 터미널처럼 같은 메시지를 계속 수정하며 작성되는 '초안(draft)' 방식입니다. 답변 작성이 완료되어 확정되면 다음 턴부터는 새로운 메시지로 전송되며, 이미 읽은 이전 답변은 채팅에 그대로 남아 있습니다.
* **작업 중임을 알 수 있습니다.** 작업이 진행되는 동안 Telegram의 "입력 중..." 표시가 약 4.5초마다 업데이트됩니다.
* **Telegram과의 독립된 통신 채널.** Long polling(메시지 수신), 메시지 전송, 보조 알림(`sendChatAction`)은 서로 다른 큐를 사용합니다. 따라서 한쪽에서 지연이 발생해도 응답이 전달되는 것에는 큰 영향을 주지 않습니다.
* **로컬 모델 우선 지원.** pi는 스스로 인증을 인정할 수 있는 provider의 모델만 “available”로 취급하므로, `models.json`에서 `127.0.0.1` / `localhost`를 가리키는 로컬 모델(llama.cpp, ollama 등)은 pi의 목록에 잡히지 않습니다. 브리지가 그 모델을 전체 registry에서 되찾아 `🏠` 표시와 함께 목록 맨 위에 배치합니다(사용 중인 모델은 항상 최상단). 클라우드 모델보다 훨씬 빠르게 접근할 수 있습니다.
* **거대한 프로바이더도 사용 가능.** OpenRouter처럼 모델이 매우 많은 경우에도 `/model` 명령어를 통해 프로바이더 단위로 탐색하거나, 정확한 ID를 입력하여 즉시 전환할 수 있습니다. pi가 모르는 ID라도 형식이 맞으면 sibling 모델 설정을 빌려와서 실행해 줍니다(`✨` 표시).
* **압축 작업이 메시지를 삼키지 않습니다.** 예전에는 압축 중에 보낸 메시지가 오류와 함께 사라지는 경우가 있었으나, 이제는 `session_before_compact` 등의 상태를 모니터링하여 메시지를 잠시 대기시킨 후, 압축 완료 즉시 다시 전달합니다.
* **세션 교체(Session Replacement).** `/new`, `/resume`, `/fork`, `/reload` 실행 시 pi는 기존 세션을 해제하고 새 확장을 생성합니다. 이 과정에서 브리지가 성공적으로 인계되었음을 나타내는 메시지가 채팅에 표시됩니다.
* **키보드 버튼의 유효 기간.** 버튼에는 짧은 유효 기간(약 30분)이 있습니다. 세션 교체 후 예전에 생성된 버튼을 누르면 "만료되었습니다"라는 메시지와 함께 사라집니다.

## 개발하기 (Development)

```bash
npm run typecheck                  # tsc, 엄격한 타입 검사
npm run smoke                      # 가짜 pi + Mock Telegram API를 이용한 테스트 (오프라인)
npm run live                       # 실제 pi(rpc 모드) + Mock Telegram API로 실행
PI_TG_LIVE_SRC="$HOME/.pi/agent" PI_TG_LIVE_EXT=1 PI_TG_LIVE_MASK=1 \
  PI_TG_LIVE_OPEN_SESSION="<session.jsonl>" npm run live
npm run probe -- "<session.jsonl>" # 세션 상태에 따른 명령어 작동 테스트
```

* `scripts/smoke.ts`: 실제 확장 기능을 가짜 API 환경에서 구동하여 페어링, 스트리밍, 키보드, 첨부 파일 등 모든 기능을 테스트합니다.
* `scripts/live-check.ts`: 실제 pi를 `--mode rpc` 모드로 실행하여 Telegram Bot API와 연동되는지 확인합니다.

## 주요 도구 (Tools)

모델이 호출할 수 있는 내장 도구:
* `telegram_send` — 페어링된 채팅으로 텍스트나 파일을 전송합니다.
* `telegram_ask` — 버튼과 함께 질문을 보내고 사용자의 응답을 기다립니다.

**주의:** `telegram_send path=...`를 통해 모델이 시스템의 민감한 파일(예: `~/.ssh/id_rsa`)을 읽어 당신의 폰으로 보낼 수도 있습니다. 이는 보안상 중요한 권한이므로, 필요하지 않다면 pi의 도구 목록에서 제거하는 것이 좋습니다.

## 설정 (Configuration)

`~/.pi/agent/telegram.json`:
| 키 | 의미 |
| --- | --- |
| `token` | 봇 토큰 (`/telegram-setup`으로 저장됨) |
| `chats` | 페어링된 채팅 목록 `[{ chatId, label, name }]` |
| `verbosity` | 상세도 설정 (`0` / `1` / `2`) |
| `streaming` | 스트리밍 편집 활성화 여부 |
| `redactBash` | `/bash` 출력에서 자격 증명 형태의 텍스트를 마스킹할지 여부 (기본값 `true`) |

환경 변수: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ROOT`.
`;