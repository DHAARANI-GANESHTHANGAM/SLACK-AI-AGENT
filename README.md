# Slack AI Agent

An AI-powered Slack bot built with Node.js, LangChain, and MongoDB to support automated member analysis and deliver insights directly through Slack.

## Overview

Slack AI Agent is a backend application that connects Slack with AI-powered analysis. It is designed to analyze member information, generate insights and recommendations, and store analysis results for future reference.

The application uses Slack Bolt for Slack integration, LangChain for working with language models, Express for HTTP endpoints, and MongoDB for storing analysis data.

## Key Features

- **AI-Powered Analysis:** Uses a language-model integration to support member analysis.
- **Member Insights:** Stores fit scores, insights, and recommendations for analyzed members.
- **Research Data Storage:** Saves research data alongside analysis results.
- **Duplicate Analysis Prevention:** Checks for recent analyses using a Slack member ID or a normalized member name.
- **MongoDB Indexing:** Creates indexes to support efficient member lookups and time-based queries.
- **Slack Delivery Tracking:** Records whether an analysis has been sent to Slack and when it was delivered.
- **Slack Socket Mode:** Configures the Slack Bolt application to use Socket Mode, avoiding the need for a publicly accessible event URL.
- **Modular Backend:** Separates database operations from the main application entry point.

## Tech Stack

| Technology | Purpose |
|---|---|
| JavaScript / Node.js | Backend application |
| Slack Bolt | Slack app integration and event handling |
| Slack Web API | Direct Slack API interactions |
| LangChain | Language-model integration |
| OpenAI-compatible chat models | AI model interface |
| Express.js | HTTP server and testing endpoints |
| MongoDB | Persistent storage for member analyses |
| dotenv | Environment variable configuration |

## Architecture

```text
Slack Workspace
      |
      v
Slack Bolt (Socket Mode)
      |
      v
Node.js Application
      |
      +------------------+
      |                  |
      v                  v
LangChain / AI       MongoDB
      |                  |
      v                  v
Insights and         Member Analyses
Recommendations     + Indexes
      |
      v
Slack Delivery
```

*This diagram represents the intended high-level architecture based on the available source code. The complete processing flow depends on the application's event handlers and AI implementation.*

## Database Design

The application stores analysis records in a MongoDB collection named `member_analyses`.

Each analysis document can contain:

- Member ID, name, email, title, and timezone
- Member fit score
- Insights and recommendations
- Associated research data
- Analysis and creation timestamps
- Slack delivery status and delivery timestamp

### Duplicate Prevention

The application checks for an existing analysis within a configurable time window. The default is 720 hours (30 days).

- Uses the Slack member ID when available.
- Falls back to a lowercased member name when no member ID is provided.
- Uses MongoDB indexes to improve lookup performance.
- Allows analysis to proceed if the duplicate-check query fails, rather than blocking the entire workflow.

### Database Indexes

The application creates indexes on:

- Member ID and analysis timestamp
- Lowercased member name and analysis timestamp
- Analysis timestamp

## Getting Started

### Prerequisites

- Node.js and npm
- A MongoDB database
- A Slack workspace and Slack app
- The required Slack tokens and signing secret
- An API key for the configured language-model provider

### 1. Clone the repository

```bash
git clone https://github.com/DHAARANI-GANESHTHANGAM/SLACK-AI-AGENT.git
cd SLACK-AI-AGENT
```

### 2. Install dependencies

```bash
npm install
npm install mongodb
```

The MongoDB driver is required by `db.js`. It should also be listed in `package.json`.

### 3. Configure environment variables

Create a `.env` file in the project root:

```env
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APP_TOKEN=

MONGODB_URI=
MONGODB_DB=slack_ai_agent

OPENAI_API_KEY=
```

Fill in the values using your own credentials. The OpenAI API key is relevant if the application uses the default OpenAI API configuration; the final requirements depend on the model configuration in the completed application.

**Security:** Never commit your `.env` file, API keys, or Slack tokens to GitHub.

### 4. Start the application

For development:

```bash
npm run dev
```

For normal startup:

```bash
npm start
```

The available commands are defined in `package.json`. The application must finish its initialization and register its handlers before the Slack workflow can operate.

## Project Structure

```text
SLACK-AI-AGENT/
├── index.js          # Main application and Slack integration
├── db.js             # MongoDB connection and analysis operations
├── package.json      # Dependencies and npm scripts
├── package-lock.json # Locked dependency versions
├── .env              # Local configuration (not committed)
└── .gitignore        # Excluded files and secrets
```

## Future Improvements

- Add automated tests for database operations and Slack event handling.
- Improve monitoring, error reporting, and structured logging.
- Add retries and recovery for failed AI analysis or Slack delivery.
- Track analysis latency, duplicate prevention, and delivery success rates.
- Add integration tests for the complete analysis workflow.
- Document supported Slack commands and provide example interactions.

## Author

**Dhaarani Ganesh Thangam**

GitHub: [DHAARANI-GANESHTHANGAM](https://github.com/DHAARANI-GANESHTHANGAM)

---

This project explores the integration of AI, Slack APIs, backend services, and persistent data storage to build a useful automation workflow.
