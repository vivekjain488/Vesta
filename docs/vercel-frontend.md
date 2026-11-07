# Vercel frontend deployment

The frontend is a Next.js application in the `frontend` workspace. The API, workers, chain RPCs, and persistent state must be hosted separately; deploying the frontend does not start them.

## Vercel project

1. Import the repository and set the project root directory to `frontend`. Select the Next.js framework preset and leave the build and output settings at their detected defaults (`next build` and `.next`). Vercel must include source files outside the root directory because the app depends on workspace packages. In the Root Directory settings enable **Include source files outside of the Root Directory in the Build Step** if it is not already enabled.
2. Use Node.js 22 or newer. The workspace uses pnpm and the repository's `pnpm-lock.yaml`.
3. Add these environment variables for the environment you are deploying:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_PRIVY_APP_ID` | Your public Privy application ID, e.g. `cmw5dcyla00210fkz5zfu8agh`. |
   | `BACKEND_API_URL` | The externally reachable HTTPS origin of the deployed Perpetua API, e.g. `https://api.example.com`. Do not include a path or trailing endpoint. |

4. Deploy. Changes to these variables require a new deployment. If `BACKEND_API_URL` is missing, the site can build, but `/backend/*` requests will not reach an API and sign-in and data will not work. `NEXT_PUBLIC_API_URL` is used for local development only; production uses the same-origin `/backend` rewrite.
5. Add the frontend domain in Privy's application settings if required by the Privy configuration. Configure the API's `APP_ORIGIN` to the exact frontend origin (for example `https://app.example.com`). Different preview deployment domains require matching backend and Privy configuration; one fixed `APP_ORIGIN` does not automatically permit every preview URL.

The API currently keeps sign-in sessions in process memory. Restarts invalidate sessions, and multiple instances need shared session storage or sticky routing. Host the API and worker on services suitable for long-running processes and configure their private credentials there, never as frontend environment variables. The website's local-only deposit and agent execution restrictions remain in place.

## Checks

From the repository root:

```sh
BACKEND_API_URL=https://api.example.com pnpm --filter @perpetua/frontend build
pnpm --filter @perpetua/frontend typecheck
```

The production browser calls `/backend/auth/*`, `/backend/v1/*`, and `/backend/registry/*`. Next.js rewrites them to `BACKEND_API_URL` so session cookies stay on the frontend origin. Check the actual backend's health, wallet sign-in, API response and registry query after deployment; a successful frontend build alone does not verify those external services.
