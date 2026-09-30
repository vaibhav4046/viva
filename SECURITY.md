# Security

## Reporting a vulnerability

Contact: **[PLACEHOLDER: the owner sets a real address before a public launch]**. Until then, open a private
security advisory on the GitHub repository (Security tab, "Report a vulnerability"). Do not post details in a
public issue.

Include the URL or route, the steps to reproduce, and what you could read or change. Expect a first reply within
a few days; this is a one-person hackathon project and there is no on-call.

## In scope

- The deployed app and the code in this repository.
- Anything that lets one browser identity read or change another identity's subjects, answers or exams
  (routes under `src/app/api`, the store in `src/lib/store`).
- Exposure of the AssemblyAI API key or any server secret to the browser. The browser only ever receives a
  short-lived session token minted by `/api/voice-agent/token` or `/api/voice/stream-token`.
- Server-side request forgery through the URL intake (`src/lib/intake/url.ts`).
- Cross-site scripting, and gaps in the Content Security Policy set in `src/proxy.ts`.
- A quotation shown as verified that is not a verbatim substring of the learner's own material.

## Out of scope

- Denial of service by volume, and rate-limit tuning.
- Findings that need a modified browser extension or a compromised device.
- Third-party services (AssemblyAI, Vercel, model providers) themselves; report those to the vendor.
- Missing security headers on non-production preview deployments.

## What is already tested

The identity boundary, SSRF guards, deletion behaviour, token expiry and the oral tool protocol have unit tests in
`tests/` (for example `idor.test.ts`, `security-ssrf.test.ts`, `security-hardening.test.ts`,
`oral-security.test.ts`). `npx vitest run` runs them.
