# Slack + Discord + IRC + Codex Auth 챗봇

한 프로세스에서 여러 Slack/Discord/IRC 봇을 동시에 실행합니다.

- Slack: 멘션/스레드/DM 대응
- Discord: 멘션/DM 대응
- IRC: 채널 멘션/DM 대응
- Codex 인증은 access/refresh token을 함께 담은 JSON 번들을 사용하며, refresh 직후 최신 번들을 원자적으로 영속화합니다.

## 1) 로컬 CLI로 먼저 테스트

```bash
npm install
# Codex CLI로 먼저 로그인한 뒤 실행
codex login
npm run chat
```

`npm run chat`은 기본적으로 `~/.codex/auth.json`을 직접 사용합니다. 파일의 access token이
30초보다 오래 유효하면 refresh 없이 재사용하고, 만료가 임박했거나 API가 인증을 거부할
때만 refresh합니다. 갱신된 access/refresh token은 요청을 재시도하기 전에 같은 JSON 파일에
원자적으로 저장됩니다.

공식 Codex CLI와 `npm run chat`을 동시에 실행하지 마세요. 두 프로세스가 같은
`~/.codex/auth.json`의 refresh-token chain을 동시에 갱신하면 한쪽 token이 무효화될 수
있습니다. 인증을 다시 발급해야 한다면 두 프로세스를 모두 종료한 뒤 `codex logout`,
`codex login` 순서로 로그인하고 한 프로세스만 실행합니다.

CLI 설정(`config/services.json`의 `cli` 섹션, required):

```json
{
  "cli": {
    "name": "dev",
    "model": "gpt-5.3-codex",
    "reasoningEffort": "medium",
    "systemPrompt": "You are a helpful CLI assistant.",
    "webSearch": false,
    "imageGeneration": true
  }
}
```

CLI 명령:

- `/reset`: 문맥 초기화
- `/exit`: 종료

인증:

- CLI 기본 인증 파일: `~/.codex/auth.json`
- 서버 기본 인증 파일: `<현재 작업 디렉터리>/data/codex-auth.json`
- 서버/Docker에서 경로를 바꾸려면 `CODEX_AUTH_FILE`에 writable persistent 경로를 지정
- 인증 파일이 없을 때만 `CODEX_ACCESS_TOKEN`과 `CODEX_REFRESH_TOKEN` 환경변수 쌍으로 최초 JSON 번들을 생성
- 인증 파일이 존재하면 그 파일이 항상 우선하며, 환경변수의 seed token은 덮어쓰거나 자동 복구에 사용하지 않음
- account ID는 인증 번들과 token claim에서 자동 추출

인증 파일에는 access/refresh token이 모두 들어 있으므로 파일과 상위 디렉터리를 비공개로
보호해야 합니다. 새 파일은 POSIX 환경에서 mode `0600`으로 생성됩니다.

## 2) 서비스 설정 파일

기본 경로: `config/services.json`

```json
{
  "slack": [
    {
      "name": "main",
      "botToken": "xoxb-your-bot-token",
      "appToken": "xapp-your-app-level-token",
      "model": "gpt-5.3-codex",
      "systemPrompt": "You are a helpful Slack assistant.",
      "webSearch": false
    }
  ],
  "discord": [
    {
      "name": "main",
      "botToken": "your-discord-bot-token",
      "model": "gpt-5.3-codex",
      "systemPrompt": "You are a helpful Discord assistant.",
      "webSearch": false
    }
  ],
  "irc": [
    {
      "name": "libera",
      "server": "irc.libera.chat",
      "port": 6697,
      "ssl": true,
      "nick": "codexbot",
      "username": "codexbot",
      "realname": "Codex Bot",
      "channels": ["#your-channel"],
      "sasl": {
        "enabled": true,
        "mechanism": "PLAIN",
        "username": "codexbot",
        "password": "your-sasl-password"
      },
      "model": "gpt-5.3-codex",
      "systemPrompt": "You are a helpful IRC assistant.",
      "webSearch": false
    }
  ]
}
```

`config/services.example.json` 예시 파일도 함께 제공합니다.
각 서비스 항목의 `model`은 필수이며, IRC는 `server`, `nick`, `channels`도 필수입니다.
서비스별 `systemPrompt`를 넣으면 해당 서비스에만 적용됩니다.

CLI와 Slack/Discord/IRC의 각 설정에 `"reasoningEffort": "high"`를 추가하면 Codex 요청의
`reasoning.effort`로 전달됩니다. 생략하면 모델 기본값을 사용하며, Anthropic 요청에는
적용하지 않습니다. 설정값은 `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` 중
하나여야 합니다. 실제 지원값은 모델마다 다르므로 fallback용 `models` 배열을 사용하는 경우
각 Codex 모델이 지원하는 값을 선택하세요. 지원값과 기본값은
[OpenAI 공식 문서](https://developers.openai.com/api/docs/guides/reasoning)를 참고하세요.
Helm에서도 `config.services.slack[]`, `discord[]`, `irc[]`의 각 항목에 같은 필드를 넣습니다.

## 3) Slack App 준비

- OAuth Scopes (Bot Token Scopes)
  - `app_mentions:read`
  - `chat:write`
  - `reactions:write`
  - `channels:history`
  - `im:history`
  - `files:write` (이미지 생성 기능 사용 시 필수 — 없으면 `missing_scope` 에러)
- Event Subscriptions
  - `app_mention`
  - `message.channels`
  - `message.im`
- Socket Mode
  - App-Level Token 발급 (`connections:write`)

## 4) Discord Bot 준비

- Bot 계정 생성 후 토큰 발급
- Privileged Gateway Intents:
  - `MESSAGE CONTENT` 활성화
- OAuth2에서 봇을 서버에 초대

## 5) 이미지 생성 (옵션)

Slack / Discord / CLI 봇은 Codex의 `image_generation` 내장 툴을 사용해 이미지를 생성할 수 있습니다. 봇별 설정에 `imageGeneration: true`를 추가하면 모델이 대화 맥락에 따라 이미지 생성 여부를 직접 결정합니다. 예를 들어 "고양이 그려줘" 같은 요청에는:

- Slack / Discord: 스트리밍이 끝난 뒤 같은 스레드/채널에 PNG 파일을 새 메시지로 첨부하고, `revised_prompt`를 메시지 본문으로 노출합니다.
- CLI: 현재 작업 디렉토리에 `image-<YYYYMMDD>-<HHMMSS>[-<index>].png` 형식으로 저장하고 경로를 stdout에 출력합니다.

주의 사항:

- Slack에서 이미지 첨부를 사용하려면 `files:write` OAuth scope가 Bot Token Scopes에 추가되어 있어야 합니다. 없으면 업로드 시 `missing_scope` 에러가 발생합니다.
- `imageGeneration`은 Boolean literal(`true` / `false`)만 받습니다. 문자열 `"true"`는 false로 처리됩니다(strict `=== true` 비교).
- 생략하거나 `false`이면 기존 텍스트 응답 페이로드와 바이트 레벨로 동일하게 동작합니다(회귀 없음).
- IRC는 파일 첨부가 불가능하여 이 플래그를 설정해도 무시됩니다.
- Anthropic provider 경로에서는 플래그가 무시되며 기동 시 `[ai] imageGeneration ignored for anthropic provider ...` 형태의 warn 로그가 한 번 남습니다.

예시(`config/services.json`):

```json
{
  "slack": [
    {
      "name": "main",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "model": "gpt-5.3-codex",
      "imageGeneration": true
    }
  ]
}
```

## 6) IRC 준비

- IRC 서버 주소/포트와 봇 계정(nick) 준비
- SSL/TLS 서버면 `ssl: true`와 `port: 6697` 사용 (`tls` 키도 호환)
- SASL 사용 시 `sasl.enabled: true`, `sasl.mechanism: PLAIN`, `sasl.username/password` 설정
- 응답할 채널 목록을 `channels`에 설정

## 7) 실행

서버 실행 시 `CODEX_AUTH_FILE`을 영속적이고 쓰기 가능한 JSON 경로로 지정합니다. 해당 파일이
아직 없을 때에만 `CODEX_ACCESS_TOKEN`과 `CODEX_REFRESH_TOKEN`을 함께 seed로 제공합니다.
토큰은 셸 명령에 직접 입력하지 말고 process supervisor나 secret manager의 보호된 환경변수
주입 기능을 사용하세요. 첫 기동에서 JSON 파일이 만들어진 뒤에는 그 파일이 최신 인증
상태의 원본입니다.

`npm run start`는 시작 시 인증 번들을 초기화한 다음 connector를 시작합니다. Anthropic만
사용하는 구성이라면 Codex token 없이도 기동할 수 있습니다.

## 8) Docker 빌드/실행

```bash
docker build -t slack-openai-bot .
install -d -m 700 ./data
docker run --rm \
  --env-file ./bot-auth.env \
  -e CODEX_AUTH_FILE=/app/data/codex-auth.json \
  -v "$(pwd)/config/services.json:/app/config/services.json:ro" \
  -v "$(pwd)/data:/app/data" \
  slack-openai-bot
```

`bot-auth.env`는 secret manager 또는 보호된 편집기로 만들고 mode `0600`을 적용합니다. 최초
기동에는 `CODEX_ACCESS_TOKEN`과 `CODEX_REFRESH_TOKEN` 두 항목이 모두 있어야 합니다.
파일 내용을 출력하거나 저장소에 추가하지 마세요. `./data`는 컨테이너의 UID 1000이 쓸 수
있어야 하며 백업과 접근 제어가 필요합니다.

## 9) Helm 배포

차트 경로: `helm/bot`

Kubernetes에서는 Secret과 PVC를 함께 사용합니다.

- Secret: 인증 파일이 없는 최초 pod에 access/refresh token 쌍을 제공하는 seed
- PVC의 `/app/data/codex-auth.json`: refresh 후 계속 갱신되는 최신 인증 번들

`auth.persistence.mountPath`를 변경하면 `CODEX_AUTH_FILE`은 정규화된 같은 mount 아래의
`codex-auth.json`으로 자동 설정됩니다.

Secret은 token rotation 때마다 갱신되는 저장소가 아닙니다. pod가 재시작되면 PVC 파일을
먼저 읽으므로 Secret에 남은 최초 seed는 무시됩니다. 하나의 refresh-token chain을 한
프로세스만 소유하도록 차트는 replica 1개와 `Recreate` 전략만 허용합니다.

토큰을 Helm values나 `helm --set` 인자에 넣지 말고 `auth.existingSecret`을 사용하는 구성을
권장합니다. 예를 들어 보호된 로컬 파일 `<protected-auth-env-file>`에 아래 두 key를 준비합니다.

```text
CODEX_ACCESS_TOKEN=<fresh access token>
CODEX_REFRESH_TOKEN=<matching fresh refresh token>
```

해당 파일은 mode `0600`으로 보호하고 다음처럼 Secret을 생성하거나 갱신합니다. token 값은
명령 인자나 출력에 포함되지 않습니다.

```bash
kubectl -n <namespace> create secret generic <auth-secret> \
  --from-env-file=<protected-auth-env-file> \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install bot ./helm/bot \
  --set image.repository=your-repo/slack-openai-bot \
  --set image.tag=latest \
  --set-string auth.existingSecret=<auth-secret>
```

운영 환경에서는 가능하면 외부 secret manager/operator로 `<auth-secret>`을 관리하세요.
서비스 설정도 `config.servicesExistingSecret`으로 별도 Secret을 참조할 수 있습니다.

### 이전 refresh-token 형식에서 업그레이드

기존 `/app/data/codex-refresh-token` 단일 파일과 refresh token 하나만 든 Secret은 새 버전에서
읽거나 자동 변환하지 않습니다. 이 변경은 무중단 업그레이드가 아니며, 기존 pod와 새 pod가
같은 refresh-token chain을 동시에 사용하지 않도록 다음 순서를 지켜야 합니다.

1. 기존 Deployment를 replica 0으로 내리고 구 pod가 모두 종료됐는지 확인합니다.
2. 다른 환경에서 `codex login`으로 서로 짝이 맞는 새 access/refresh token을 발급하고,
   공식 Codex 프로세스를 종료합니다.
3. 보호된 env 파일 또는 secret manager를 이용해 Secret에 새 `CODEX_ACCESS_TOKEN`과
   `CODEX_REFRESH_TOKEN` 쌍을 함께 반영합니다.
4. PVC의 기존 `/app/data/codex-refresh-token`은 삭제하지 말고 별도 이름으로 이동해
   격리합니다.
5. 새 `/app/data/codex-auth.json`이 존재하지 않는지 확인합니다. 이미 있다면 덮어쓰지 말고
   아래 인증 복구 절차에 따라 먼저 격리합니다.
6. Deployment를 정확히 replica 1로 올려 새 JSON 번들을 생성하고 인증 성공을 확인합니다.

새 번들과 실제 요청이 정상임을 확인하기 전에는 격리한 기존 파일을 제거하지 마세요. token
값을 Helm 인자, 셸 기록, 로그 또는 명령 출력에 노출하지 않는 원칙은 신규 설치와 같습니다.

### Kubernetes 인증 복구

PVC 인증 파일이 손상되었거나 refresh token이 무효화된 경우 오래된 Secret로 자동
fallback하지 않습니다. 다음 순서를 지켜 수동으로 재시드합니다.

1. Deployment를 replica 0으로 내리고 관련 pod가 모두 종료됐는지 확인합니다.
2. PVC를 단독으로 마운트한 maintenance pod에서 기존 `codex-auth.json`을 삭제하지 말고
   별도 이름으로 이동해 격리합니다.
3. 다른 환경에서 `codex login`으로 서로 짝이 맞는 새 access/refresh token을 발급합니다.
   공식 Codex 프로세스는 다시 종료해 이 token chain을 동시에 refresh하지 않게 합니다.
4. 위의 보호된 env 파일과 `kubectl create secret ... --from-env-file` 방식으로
   `<auth-secret>`을 새 쌍으로 갱신합니다.
5. `/app/data/codex-auth.json`이 없는 상태임을 확인하고 Deployment를 정확히 replica 1로
   올립니다. 둘 이상의 pod를 동시에 시작하지 마세요.
6. 새 `/app/data/codex-auth.json`이 생성되었고 mode가 `600`인지 확인한 뒤 실제 요청으로
   인증 성공을 검증합니다. 성공을 확인한 뒤에만 격리 파일을 보존 정책에 따라 정리합니다.

namespace, Deployment, PVC 이름은 설치 환경에서 먼저 조회해 실제 값을 사용하세요. Secret,
인증 파일 또는 pod 로그의 token 내용을 출력하지 마세요.

## 파일 구조

- `src/index.js`: 멀티 서비스 런처
- `src/connectors/slack.js`: Slack 연결
- `src/connectors/discord.js`: Discord 연결
- `src/connectors/irc.js`: IRC 연결
- `src/ai.js`: Codex auth 기반 AI 호출
- `src/codex-auth.js`: Codex 인증 번들 로드·refresh·원자 저장
- `src/cli.js`: 로컬 테스트 CLI
- `Dockerfile`: 컨테이너 이미지 빌드
- `helm/bot`: Kubernetes Helm 차트
- `config/services.json`: 서비스 구성
- `config/services.example.json`: 서비스 구성 예시
