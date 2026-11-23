# Changelog

All notable changes to `llm-tape` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

### Added
- Core `withTape()` runtime and `tapeFetch` wrapper.
- Automatic interception of `globalThis.fetch` on Node.js 18+.
- Stateful sequential replaying for identical requests.
- Full streaming response recording and replaying for SSE (`text/event-stream`).
- Automatic secret redaction for API keys (OpenAI, Anthropic, Google Gemini, Bearer headers).
- Loose request matching mode (`match: "loose"`) to disregard volatile sampling parameters.
- Replay miss diagnostic error reports showing closest recorded entries and diffs.
- First-class Vitest and Jest test runner hooks (`llm-tape/vitest`, `llm-tape/jest`).
- Zero runtime dependencies.
- CLI utility (`llmtape` / `llm-tape`) with `ls`, `stats`, `prune`, and `redact-check` commands.
- Dual ESM and CommonJS builds with TypeScript type definitions.
- GitHub Actions CI matrix (Node 18, 20, 22) and OIDC trusted publishing workflow.
