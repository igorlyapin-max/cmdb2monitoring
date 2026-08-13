---
name: developer-local
description: Local development workflow for the cmdb2monitoring repository. Use when Codex works on repo-local code, configuration files, tests, documentation, architecture artifacts, versioning, commits, or development agreements that are not specifically about live Kafka/Zabbix/CMDBuild service access.
---

# Developer Local

## Scope

Use this skill for repository-local engineering work in `/home/lsk/projects/cmdb2monitoring`.
Use `$environment-dev` instead when the task is about the running Kafka/Zabbix/CMDBuild development environment, live containers, topics, endpoints, credentials, or catalog data.

## Repository Rules

- Inspect `git status --short` before edits and before commits.
- Do not revert user changes or unrelated dirty files.
- Keep service settings in config files, not hardcoded in code.
- Keep Kafka topics externally managed; services must not create topics at startup.
- Keep edits scoped to the requested service, UI area, rule file, or documentation artifact.
- Prefer existing patterns in the repository over new abstractions.

## Project Structure

- `.NET` services:
  - `src/cmdbwebhooks2kafka`
  - `src/cmdbkafka2zabbix`
  - `src/zabbixrequests2api`
- Node.js UI/BFF: `src/monitoring-ui-api`.
- Conversion rules: `rules/cmdbuild-to-zabbix-host-create.json`.
- Technical specification: `TZ_cmdb2monitoring.txt`.
- Project documentation: `PROJECT_DOCUMENTATION.md`.
- Mandatory development agreements: `must.md`.
- Architecture artifacts: `aa/`.

## Change Workflow

1. Read the relevant code and config first with `rg`, `sed`, and existing tests.
2. Update implementation and rules together when behavior changes.
3. Update documentation when behavior, config, architecture, ports, topics, or operator workflow changes.
4. Run focused validation before reporting completion.
5. Commit only when the user explicitly asks. Push only when the user explicitly asks.

## Validation Gates

Run the gates that match the touched files:

- General config and rules: `./scripts/test-configs.sh`.
- Frontend syntax: `node --check src/monitoring-ui-api/public/app.js`.
- Frontend config: `node src/monitoring-ui-api/scripts/validate-config.mjs`.
- .NET service build: `./scripts/dotnet build <path-to-csproj> -v minimal`.
- Config validation project: `./scripts/dotnet build tests/configvalidation/configvalidation.csproj -v minimal`.
- Whitespace check: `git diff --check`.

For changed .NET service code, build the affected `.csproj`. For changed conversion rules, run `./scripts/test-configs.sh` because it validates rule structure and T4 rendering.

## Documentation Discipline

Update these artifacts when the related behavior changes:

- `TZ_cmdb2monitoring.txt`: requirements and accepted behavior.
- `PROJECT_DOCUMENTATION.md`: operator/developer guide.
- `must.md`: durable agreements and development constraints.
- `aa/`: architecture flows, APIs, maps, diagrams.
- `CHANGELOG.md`: unreleased user-visible changes.

When documenting network connections, include port numbers. Do not move live environment details into `developer-local`; put Kafka/Zabbix/CMDBuild runtime facts in `$environment-dev`.

## Git Workflow

- Use concise thematic commits.
- For an explicit complete Git handoff, use `$git-handoff-versioning`: include root `VERSION` in the final scoped commit and push its annotated Git tag. Do not derive this counter from Conventional Commit type.
- Do not create `VERSION` or a Git tag for a local-only commit, status request, or commit-message generation.
- If sandbox blocks `.git` writes, request escalation for `git add`, `git commit`, or `git push` rather than using workarounds.
