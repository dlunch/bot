# Slack + Codex Auth 챗봇

Slack 스레드 챗봇입니다.

- 첫 메시지는 `@bot 질문`으로 시작
- 이후 같은 스레드에서는 멘션 없이 계속 대화
- AI 호출 인증은 `codex auth` 토큰만 사용 (`~/.codex/auth.json`)

## 1) 로컬 CLI로 먼저 테스트

Slack 설치 전에 터미널에서 대화 품질부터 확인할 수 있습니다.

```bash
codex auth login
cp .env.example .env
npm install
npm run chat
```

CLI 명령:

- `/reset`: 문맥 초기화
- `/exit`: 종료

## 2) Slack App 준비

- OAuth Scopes (Bot Token Scopes)
  - `app_mentions:read`
  - `chat:write`
  - `reactions:write`
  - `channels:history`
  - `im:history`
- Event Subscriptions
  - `app_mention`
  - `message.channels`
  - `message.im`
- Socket Mode
  - App-Level Token 발급 (`connections:write`)

## 3) 환경변수 설정

```bash
cp .env.example .env
```

`.env` 값:

- `SLACK_BOT_TOKEN`: `xoxb-...`
- `SLACK_APP_TOKEN`: `xapp-...`
- (선택) `CODEX_MODEL` 기본값: `gpt-5`
- (선택) `CODEX_AUTH_FILE` 기본값: `~/.codex/auth.json`
- (선택) `BOT_CONFIG_FILE` 기본값: `./config/bot.config.json`
- (선택) `MAX_THREAD_HISTORY` 기본값: `20`

## 4) 시스템 프롬프트 설정 파일

`config/bot.config.json`의 `systemPrompt`를 수정하면 반영됩니다.

```json
{
  "systemPrompt": "Your custom system prompt here"
}
```

## 5) Slack 봇 실행

```bash
npm run start
```

## 파일 구조

- `src/index.js`: Slack 이벤트 처리
- `src/ai.js`: Codex auth 기반 AI 호출
- `src/cli.js`: 로컬 테스트 CLI
- `config/bot.config.json`: 시스템 프롬프트 설정
