# Groq
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-120b

# MongoDB
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/
MONGODB_DB=slack_ai_agent

# Optional
COMPANY_NAME=Your Company
COMPANY_PRODUCT=What your product does
DEDUPE_WINDOW_HOURS=720
PORT=3000
NODE_ENV=development
```

Invite the bot to the private channel set in `SLACK_PRIVATE_CHANNEL_ID`.

### Run

```bash
npm start      # production
npm run dev    # restarts on file changes
```

## HTTP endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check that reports the LLM provider and model |
| `POST` | `/test/analyze-member` | Development only (`NODE_ENV=development`). Runs the full pipeline on a sample member |

Example test request using the sample in `test.json`:

```bash
curl -X POST http://localhost:3000/test/analyze-member \
  -H "Content-Type: application/json" \
  -d @test.json
```

Add `"force": true` to the body to re-analyze a member that was analyzed recently.

## Tests

```bash
node verify.mjs
```

Checks the parsing of LLM responses (including JSON wrapped in markdown code fences) and other core behavior.

## Project structure

```
index.js      Slack bot, Express server and the analysis pipeline
db.js         MongoDB connection and data access
verify.mjs    Verification script
test.json     Sample member for the test endpoint
```
