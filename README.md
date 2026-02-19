# Slack + Discord + Codex Auth 챗봇

한 프로세스에서 여러 Slack/Discord 봇을 동시에 실행합니다.

- Slack: 멘션/스레드/DM 대응
- Discord: 멘션/DM 대응
- AI 호출 인증은 `codex auth` 토큰만 사용 (`~/.codex/auth.json`)

## 1) 로컬 CLI로 먼저 테스트

```bash
codex auth login
npm install
npm run chat
```

CLI 명령:

- `/reset`: 문맥 초기화
- `/exit`: 종료

## 2) 서비스 설정 파일

기본 경로: `config/services.json`

```json
{
  "slack": [
    {
      "name": "main",
      "botToken": "xoxb-your-bot-token",
      "appToken": "xapp-your-app-level-token",
      "model": "gpt-5.3-codex"
    }
  ],
  "discord": [
    {
      "name": "main",
      "botToken": "your-discord-bot-token",
      "model": "gpt-5.3-codex"
    }
  ]
}
```

`config/services.example.json` 예시 파일도 함께 제공합니다.
각 서비스 항목의 `model`은 필수입니다.

## 3) Slack App 준비

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

## 4) Discord Bot 준비

- Bot 계정 생성 후 토큰 발급
- Privileged Gateway Intents:
  - `MESSAGE CONTENT` 활성화
- OAuth2에서 봇을 서버에 초대

## 5) 시스템 프롬프트 설정 파일

`config/bot.config.json`의 `systemPrompt`를 수정하면 반영됩니다.

```json
{
  "systemPrompt": "Your custom system prompt here"
}
```

## 6) 실행

```bash
npm run start
```

## 파일 구조

- `src/index.js`: 멀티 서비스 런처
- `src/connectors/slack.js`: Slack 연결
- `src/connectors/discord.js`: Discord 연결
- `src/ai.js`: Codex auth 기반 AI 호출
- `src/cli.js`: 로컬 테스트 CLI
- `config/services.json`: 서비스 구성
- `config/services.example.json`: 서비스 구성 예시
- `config/bot.config.json`: 시스템 프롬프트 설정
