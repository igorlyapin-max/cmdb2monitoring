# Security Audit Report — cmdb2monitoring

**Date:** 2026-05-31  
**Scope:** cmdbwebhooks2kafka, cmdbkafka2zabbix, zabbixrequests2api, zabbixbindings2cmdbuild, monitoring-ui-api  
**Methodology:** Static source code review of `src/`, `deploy/dockerfiles/`, and `appsettings*.json`

---

## Executive Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 3 | Remote code execution, hardcoded credentials, no TLS in containers |
| **High** | 6 | Host-header injection, path traversal, weak defaults, credential query-string leak, missing CSRF, command injection |
| **Medium** | 5 | Root containers, debug payload logging, SASL env var propagation, session timeout, missing security headers |
| **Low** | 3 | Regex DoS, unhandled rejection leak, static file serving inconsistencies |

---

## 1. Authentication & Authorization

### CRITICAL — T4 Template Remote Code Execution
- **File:** `src/cmdbkafka2zabbix/Conversion/T4TemplateRenderer.cs`
- **Issue:** `RenderAsync` compiles and executes T4 templates at runtime via `Mono.TextTemplating`. Conversion rules are loaded from a configurable git repository or disk path. A compromised rules source or malicious admin can inject arbitrary C# into templates, which `TemplateGenerator` compiles and executes with the full privileges of the service process.
- **Impact:** Full remote code execution on the `cmdbkafka2zabbix` host.
- **Recommendation:**
  1. **Eliminate runtime T4 compilation** — pre-compile templates at build time and load only safe template data at runtime.
  2. If T4 must remain, sandbox the compilation in a separate process with strict AppDomain/Assembly isolation and a whitelist of allowed types.
  3. Digitally sign conversion rule bundles and verify signatures before loading.

### HIGH — No CSRF Protection on State-Changing API Endpoints
- **File:** `src/monitoring-ui-api/server.mjs`
- **Issue:** All authenticated POST/PUT/DELETE endpoints (e.g., `/api/users/reset-password`, `/api/services/*/reload-rules`, `/api/auth/change-password`) rely solely on the session cookie. No CSRF token, `SameSite=Strict`, or custom header validation is enforced.
- **Impact:** Cross-site request forgery attacks can force admin actions if an authenticated user visits a malicious site.
- **Recommendation:**
  1. Add a synchronizer token pattern: generate a cryptographically random CSRF token per session, require it in a custom header (`X-CSRF-Token`) for all mutating requests.
  2. Change session cookie from `SameSite=Lax` to `SameSite=Strict` (`buildSessionCookie`, line ~7402).
  3. Reject mutating requests that do not include the expected custom header.

### HIGH — Weak Default Local Passwords
- **File:** `src/monitoring-ui-api/server.mjs` (default user seeding)
- **Issue:** Default local accounts (`viewer`/`editor`/`admin`) ship with identical weak passwords matching their usernames. Attackers who gain any UI access can trivially escalate privileges.
- **Impact:** Immediate authentication bypass and privilege escalation in fresh deployments.
- **Recommendation:**
  1. Do not ship default password hashes in source code. Generate a random bootstrap password on first start and log it once, or require an admin setup wizard.
  2. Force password change on first login for any pre-seeded accounts.

### HIGH — AllowedHosts Wildcard in .NET Services
- **Files:** `src/*/appsettings.json` (all .NET services)
- **Issue:** `"AllowedHosts": "*"` disables host header validation, opening services to host-header injection, cache poisoning, and password-reset poisoning.
- **Impact:** Medium-High depending on proxy topology; can lead to SSRF-like request routing and poisoning.
- **Recommendation:**
  1. Set `AllowedHosts` explicitly to the deployed hostnames (e.g., `cmdbwebhooks2kafka.internal`, `monitoring-ui-api.internal`).
  2. In container/Kubernetes environments, inject the correct value via environment variable `ASPNETCORE_ALLOWEDHOSTS`.

### MEDIUM — Session Timeout Excessively Long
- **File:** `src/monitoring-ui-api/server.mjs`
- **Issue:** Default session timeout is 480 minutes (8 hours) with sliding expiration (`lastSeenAt` refresh on every request). Idle sessions remain valid for extended periods.
- **Impact:** Increased window for session hijacking and replay.
- **Recommendation:**
  1. Reduce default session timeout to 30–60 minutes.
  2. Implement absolute session lifetime (e.g., 8 hours max regardless of activity) in addition to sliding timeout.
  3. Add endpoint for users to view and revoke active sessions.

---

## 2. Secret Management

### CRITICAL — Hardcoded Development Bearer Token
- **File:** `src/cmdbwebhooks2kafka/appsettings.Development.json`
- **Issue:** `CmdbWebhook:BearerToken = "dev-cmdb-webhook-token"` is committed to source control.
- **Impact:** If the development configuration is accidentally promoted to production (common in container misconfigurations), the webhook ingress is trivially bypassable.
- **Recommendation:**
  1. Remove the token from `appsettings.Development.json`; generate it dynamically at startup in development mode or require it via environment variable.
  2. Add a pre-commit secret-scanning hook (e.g., `gitleaks`, `trufflehog`).
  3. Document that `ASPNETCORE_ENVIRONMENT=Development` must never be used in production containers.

### HIGH — PAM AAPM Credentials Sent in Query String
- **File:** `src/shared/Secrets/SecretConfigurationResolver.cs`
- **Issue:** When `Secrets:IndeedPamAapm:SendApplicationCredentialsInQuery` is enabled, the AAPM application username and password are appended to the PAM URL as query parameters (`?username=...&password=...`). Query strings are logged by proxies, web servers, and browser history.
- **Impact:** PAM credentials leaked to logs and intermediate infrastructure.
- **Recommendation:**
  1. Deprecate and remove `SendApplicationCredentialsInQuery`; enforce HTTP Basic Auth or client-certificate authentication only.
  2. If temporary backward compatibility is required, emit a critical warning log when the flag is enabled and set a hard deprecation deadline.

### MEDIUM — SASL Credentials Propagated via Global Env Vars
- **Files:** `src/shared/Secrets/SecretConfigurationResolver.cs`, `src/monitoring-ui-api/server.mjs`
- **Issue:** `ApplyCommonSasl` and the JS equivalent propagate `SASLUSERNAME`, `SASLPASSWORD`, and `SASLPASSWORDSECRET` into Kafka and EventBrowser configuration sections globally. These environment variables are visible in `/proc/<pid>/environ` to any process running in the same container/user namespace.
- **Impact:** Credential exposure to container escape or sidecar compromise.
- **Recommendation:**
  1. Prefer file-based secret injection (e.g., Kubernetes secrets mounted as files) over environment variables for SASL credentials.
  2. Use the `secret://` or `aapm://` resolver exclusively and remove plain env-var fallbacks.

---

## 3. Input Validation & Injection

### CRITICAL — T4 Template Injection (Detailed)
- **File:** `src/cmdbkafka2zabbix/Conversion/T4TemplateRenderer.cs`
- **Issue:** `BuildTemplateContent` injects default assembly references and allows arbitrary template code. Templates run in the same process with full filesystem and network access. `renderSimple` in `server.mjs` (lines 7256–7298) also evaluates regex functions from template input, but this is secondary to the C# RCE vector.
- **Impact:** Arbitrary code execution with service account privileges.
- **Recommendation:** (Same as §1 Critical) Replace runtime T4 compilation with a safe template engine (Handlebars, Liquid, or pre-compiled JSON builders). If regex replacement is needed, execute it in a sandboxed WASM or separate process.

### HIGH — Git Command Injection via Configurable Paths
- **File:** `src/cmdbkafka2zabbix/Rules/GitConversionRulesProvider.cs`
- **Issue:** `RunProcessAsync` constructs `ProcessStartInfo` with `FileName = options.Value.GitExecutablePath` and `Arguments = $"-C \"{Path.GetFullPath(repositoryPath)}\" {arguments}"`. The `RepositoryPath` is configurable and not validated for traversal. While `UseShellExecute = false` mitigates direct shell injection, an attacker who can modify configuration (e.g., via compromised UI or env vars) can point `GitExecutablePath` to any binary and `RepositoryPath` to any directory, executing arbitrary commands.
- **Impact:** Arbitrary command execution if configuration is compromised.
- **Recommendation:**
  1. Validate `RepositoryPath` resolves inside a known safe base directory (e.g., `Path.GetFullPath` + prefix check).
  2. Whitelist `GitExecutablePath` to a known-safe path (e.g., `/usr/bin/git`) and reject relative paths or paths outside `/usr/bin`.
  3. Use a .NET git library (e.g., `LibGit2Sharp`) instead of spawning external processes.

### HIGH — Path Traversal in .NET State File Stores
- **Files:** `src/*/Processing/FileProcessingStateStore.cs` (all three .NET workers)
- **Issue:** `FilePath` from `ProcessingStateOptions` is used directly in `File.OpenRead` and `File.Create` without path traversal validation. An attacker who can modify configuration (env var or config file injection) can read/write arbitrary files on the host filesystem.
- **Impact:** Arbitrary file read/write on the container/host filesystem.
- **Recommendation:**
  1. Apply the same `isPathInside` validation pattern used in the Node UI: resolve the full path and ensure it is within a configured safe base directory (e.g., `/app/state`).
  2. Reject absolute paths that escape the base directory.

### LOW — JavaScript Regex without Timeout
- **File:** `src/monitoring-ui-api/server.mjs` (`compileRuleRegex`, line 7342)
- **Issue:** `new RegExp(source, flags)` is constructed without any timeout or complexity limits. Maliciously crafted regex from user-controlled conversion rules can cause ReDoS (e.g., catastrophic backtracking).
- **Impact:** Denial of service of the UI API process.
- **Recommendation:**
  1. Use a regex complexity limiter or a safe regex engine (e.g., `RE2` via Node bindings).
  2. If staying with native `RegExp`, add a length limit on patterns and reject nested quantifiers or alternations deeper than a threshold.

---

## 4. Network & Transport Security

### CRITICAL — No TLS/HTTPS in Any Container
- **Files:** `deploy/dockerfiles/*.Dockerfile`
- **Issue:** All containers bind HTTP only:
  - .NET services: `ASPNETCORE_URLS=http://0.0.0.0:8080`
  - UI: `node:22-alpine` on port 5090 with plain HTTP
- **Impact:** All traffic between services, to Kafka, to Zabbix, to CMDBuild, and to the UI is unencrypted and vulnerable to MITM, credential sniffing, and session hijacking on the container network.
- **Recommendation:**
  1. **Immediate:** Add TLS termination at the edge (reverse proxy or ingress controller) with valid certificates.
  2. **Medium-term:** Enable `ASPNETCORE_URLS=https://...` with mounted certificates in .NET containers; use `https` module in Node UI with `key`/`cert`.
  3. Enable mTLS between internal services where feasible (e.g., service mesh or client certificates).

### MEDIUM — Kafka Defaults to Plaintext
- **Files:** `src/*/appsettings.json`
- **Issue:** `"SecurityProtocol": "Plaintext"` is the default. SASL/SSL must be explicitly configured.
- **Impact:** Kafka traffic is unencrypted by default; credentials and CMDB/Zabbix payload data traverse the network in plain text.
- **Recommendation:**
  1. Change production default to `SaslSsl` and require explicit opt-in for `Plaintext`.
  2. Document and enforce certificate verification (`SslCaLocation`, `SslEndpointIdentificationAlgorithm`).

---

## 5. Container & Deployment Security

### MEDIUM — All Containers Run as Root
- **Files:** `deploy/dockerfiles/*.Dockerfile`
- **Issue:** No `USER` directive is present. All services run as `root` (UID 0) inside their containers.
- **Impact:** Container escape vulnerabilities (kernel CVEs, privileged volume mounts) grant immediate host root access.
- **Recommendation:**
  1. Add a non-root user in each Dockerfile:
     ```dockerfile
     RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
     USER appuser
     ```
  2. Ensure the `state/` and log directories are writable by the non-root user (`chown` in the image build).

### MEDIUM — Missing Security Headers in UI
- **File:** `src/monitoring-ui-api/server.mjs`
- **Issue:** The UI server does not set `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` on any response (static or API).
- **Impact:** Increased XSS, clickjacking, and MIME-sniffing attack surface.
- **Recommendation:**
  1. Add a default security headers middleware:
     ```javascript
     response.writeHead(statusCode, {
       'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
       'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
       'X-Frame-Options': 'DENY',
       'X-Content-Type-Options': 'nosniff',
       'Referrer-Policy': 'strict-origin-when-cross-origin'
     });
     ```

---

## 6. File System & Path Traversal

### HIGH — Inconsistent Path Traversal Defenses
- **Files:** `src/monitoring-ui-api/server.mjs` vs `src/*/Processing/FileProcessingStateStore.cs`
- **Issue:** The Node UI has `isPathInside(repositoryRoot, fullPath)` checks for queue state paths and static files, but the .NET `FileProcessingStateStore` uses `options.Value.FilePath` directly without validation. Similarly, `resolveServiceFile(path)` in the UI returns `resolve(serviceRoot, path)` without traversal checks for some paths (catalog cache files, PEM files).
- **Impact:** An attacker who can influence config can read/write sensitive files (e.g., `/etc/passwd`, SSH keys, other services' state).
- **Recommendation:**
  1. Unify path traversal validation across all services. Create a shared `SafePathResolver` utility in both C# and JS that:
     - Resolves the absolute path.
     - Verifies the resolved path is within an allow-listed base directory.
     - Rejects `..` sequences and absolute path escapes.
  2. Apply it to all file operations: state files, catalog caches, PEM files, rules repositories, and static file serving.

### LOW — Static File Serving Minor Issue
- **File:** `src/monitoring-ui-api/server.mjs` (`serveStatic`, line 6598)
- **Issue:** `fullPath.startsWith(publicDir)` is used for path traversal prevention. This is generally safe on Linux, but on Windows with case-insensitive or short-name paths, it could be bypassed. Also, `readFile` is used without size limits, though this is a minor DoS concern.
- **Impact:** Very low on Linux; potential path traversal on Windows deployments.
- **Recommendation:**
  1. Use `isPathInside` (already implemented elsewhere in the file) consistently instead of `startsWith`.
  2. Add a max file size limit for static file responses.

---

## 7. Logging & Data Exposure

### MEDIUM — Debug Payload Logging Can Leak Sensitive Data
- **Files:** `src/shared/Logging/ExtendedDebugLoggerExtensions.cs`, `src/*/Processing/*Worker.cs`
- **Issue:** When `ExtendedDebugLoggingOptions.IsEnabled` is true, full Kafka message payloads, Zabbix JSON-RPC request/response bodies, and CMDBuild field values are logged at `Information` level. `RedactSecretJsonFields` only redacts known secret keys (`password`, `token`, `apiToken`, `authorization`, `auth`, `passwd`), but business-sensitive data (PII, hostnames, internal IPs, CMDB class structures) is still emitted.
- **Impact:** Sensitive business data written to centralized logging systems (ELK, Splunk, cloud logging) where retention and access controls may be weaker.
- **Recommendation:**
  1. Treat ExtendedDebug logging as a **diagnostic-only** feature; disable it by default in production.
  2. Add a mandatory allow-list of safe fields rather than a deny-list of secrets.
  3. Add a warning banner in documentation that enabling this feature may violate data-protection policies.

### LOW — Unhandled Rejection Handler May Leak Stack Traces
- **File:** `src/monitoring-ui-api/server.mjs` (line 7877)
- **Issue:** `process.on('unhandledRejection', error => { console.error(error); })` logs the full error object, which may contain sensitive context (request bodies, secrets, internal paths).
- **Impact:** Potential secret or internal path leakage in logs.
- **Recommendation:**
  1. Sanitize the error before logging: log only `error.message` and a sanitized stack trace, or use a structured logger with a redaction filter.
  2. Consider terminating the process on unhandled rejections (Node.js `--unhandled-rejections=strict`) to avoid undefined state.

---

## 8. Session Management

### HIGH — Session Cookie Lax SameSite Insufficient for API
- **File:** `src/monitoring-ui-api/server.mjs` (`buildSessionCookie`, line 7401)
- **Issue:** Session cookie uses `SameSite=Lax`. For a management API that performs state-changing operations via POST, `Lax` allows cross-site POSTs from top-level navigations, enabling CSRF.
- **Impact:** CSRF via top-level navigation (e.g., `<form method="POST" action="https://ui/api/services/.../reload-rules">`).
- **Recommendation:**
  1. Change to `SameSite=Strict`.
  2. Complement with a CSRF token (see §1 HIGH — No CSRF Protection).

### MEDIUM — In-Memory Sessions Lost on Restart
- **File:** `src/monitoring-ui-api/server.mjs`
- **Issue:** Sessions are stored in a runtime `Map()`. Container restart or horizontal scaling drops all sessions, forcing re-authentication and losing session-bound data (e.g., saved OAuth states).
- **Impact:** Poor availability and UX; sessions cannot survive rolling updates.
- **Recommendation:**
  1. Store sessions in Redis or a persistent database with TTL support.
  2. Encrypt session data at rest.

---

## 9. Dependency & Supply Chain

### MEDIUM — T4 Template Engine Trust Boundary
- **File:** `src/cmdbkafka2zabbix/Conversion/T4TemplateRenderer.cs`
- **Issue:** `Mono.TextTemplating` is a powerful code-generation engine. The project treats conversion rules (which include template content) as data, but the engine treats them as code. This is a dangerous trust-boundary violation.
- **Impact:** Any compromise of the rules source (git repo, file share, admin UI upload) becomes immediate RCE.
- **Recommendation:**
  1. Migrate to a **logic-less** template engine (Mustache, Handlebars) that does not permit arbitrary code execution.
  2. If logic is required, use a sandboxed expression evaluator (e.g., Jint for JavaScript expressions in a restricted context, or a custom JSON transformation DSL).

### LOW — Git Dependency for Runtime Rules
- **File:** `src/cmdbkafka2zabbix/Rules/GitConversionRulesProvider.cs`
- **Issue:** The service spawns an external `git` process at runtime. This introduces a supply-chain dependency on the host git binary and its configuration (`.gitconfig`, hooks, credential helpers).
- **Impact:** A compromised git binary or malicious repo hook can execute code.
- **Recommendation:**
  1. Use `LibGit2Sharp` (pure .NET git library) instead of shelling out to `git`.
  2. If shell execution is required, disable git hooks and credential helpers via `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` environment variables.

---

## 10. Configuration & Defaults

### HIGH — Default Configuration Unsafe for Production
- **Files:** `src/*/appsettings.json`
- **Issues:**
  - `AllowedHosts: "*"` (all .NET services)
  - `SecurityProtocol: "Plaintext"` (Kafka)
  - Empty `Username`/`Password` fields (relies on env var fallback, which is invisible in config review)
  - `PullOnStartup: false`, `PullOnReload: false` in default `appsettings.json` but `ReadFromGit: false` with `RepositoryPath: "../.."` in development config
- **Impact:** Production deployments that miss any of these settings run with dangerously permissive defaults.
- **Recommendation:**
  1. Create a strict `appsettings.Production.json` template with safe defaults and require it in production.
  2. Add startup validation guards that fail fast if:
     - `AllowedHosts` is `"*"` in non-development environments.
     - `SecurityProtocol` is `Plaintext` and no override flag is set.
     - `BearerToken` is shorter than 32 characters or matches known weak patterns.
  3. Document a production hardening checklist.

### MEDIUM — Dev Bearer Token in Source Control
- **File:** `src/cmdbwebhooks2kafka/appsettings.Development.json`
- **Issue:** Hardcoded token committed to git.
- **Impact:** Accidental production exposure; secret scanning alerts.
- **Recommendation:** (Same as §2 CRITICAL) Remove from repo, rotate, and add secret scanning.

---

## Remediation Priority Matrix

| Priority | Finding | Effort | Owner |
|----------|---------|--------|-------|
| P0 | Replace runtime T4 compilation with safe templates | High | Architecture |
| P0 | Enable TLS/mTLS in all containers | Medium | DevOps |
| P0 | Remove hardcoded dev bearer token | Low | Security |
| P1 | Add path traversal validation to .NET state stores | Low | Backend |
| P1 | Add CSRF protection + SameSite=Strict to UI | Medium | Frontend/API |
| P1 | Remove/deprecate PAM query-string credential fallback | Low | Backend |
| P1 | Set explicit AllowedHosts | Low | DevOps |
| P1 | Harden GitConversionRulesProvider (path whitelisting) | Low | Backend |
| P2 | Add non-root USER to Dockerfiles | Low | DevOps |
| P2 | Add security headers to UI | Low | Frontend |
| P2 | Reduce session timeout + add absolute lifetime | Low | Frontend/API |
| P2 | Disable ExtendedDebug logging by default in prod | Low | Backend |
| P2 | Replace in-memory sessions with Redis | Medium | Backend |
| P3 | Add regex complexity limits | Low | Backend |
| P3 | Harden unhandled rejection logging | Low | Frontend |

---

*Report compiled by static analysis of source code. No dynamic testing or penetration testing was performed. Recommendations should be validated in a staging environment before production deployment.*
