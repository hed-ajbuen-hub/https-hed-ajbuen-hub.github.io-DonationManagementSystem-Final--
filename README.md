# Donation Management System

## Run locally

Install Node.js, then open a terminal in this folder and run:

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Use this address instead of opening the pages with Live Server; the Express server handles form submissions and database requests.

The app creates a SQLite database named `.donations.sqlite` on first launch and inserts the sample records. New donors, campaigns, beneficiaries, and donations are saved there and remain available after restarting the server.

## Login accounts

| Role | Username | Default password |
| --- | --- | --- |
| Administrator | `admin` | `Admin123!` |
| Regular user | `donation_user` | `GiveWithCare2026!` |

Regular users can view records and create donors or donations. Only administrators can create campaigns or beneficiaries. Passwords are stored as salted hashes and sessions expire after eight hours. Set `USER_USERNAME` and `USER_PASSWORD` to the same values on every server that should share these credentials. On its first startup after this update, a server changes the legacy regular account named `user` to these credentials and revokes its old sessions. Later restarts do not overwrite password resets. The default credentials are intended for this demo; change them before exposing a deployment publicly.

## User password recovery

The **Forgot user password?** link resets only the regular `user` account. Since this local project has no email service, the server generates a strong recovery key on first launch and saves it in the ignored `.user-recovery-key` file. Keep that file private. You can instead provide your own key before starting the server. In PowerShell:

```powershell
$env:USER_RESET_CODE = "your-private-recovery-key-at-least-16-chars"
npm start
```

The recovery form requires the key and a new password of at least 10 characters. A successful reset revokes existing sessions for the regular user. This recovery link cannot reset the administrator password.

## Publish with GitHub Pages

GitHub Pages hosts the static HTML, CSS, and JavaScript only. The Express API and database must run on a separate Node-compatible service.

1. Push this repository to GitHub's `main` branch. The included Pages workflow deploys the website; in repository **Settings > Pages**, choose **GitHub Actions** as the build and deployment source.
2. Deploy `server.js` to a Node-compatible backend and provide a PostgreSQL `DATABASE_URL`, a private `ADMIN_PASSWORD`, a private `USER_PASSWORD`, and `FRONTEND_ORIGINS=https://hed-ajbuen-hub.github.io` in that backend's environment settings.
3. Set `window.DONATION_API_URL` in `api-config.js` to the backend's HTTPS origin, with no trailing slash, then push that change to GitHub.
4. Open the Pages URL after the workflow finishes. The API database is created on first startup; local SQLite records are not copied automatically.

The API enables credentialed CORS only for `FRONTEND_ORIGINS` and uses secure cross-site cookies in production. Some browsers block third-party cookies between `github.io` and the API host; if sign-in sessions are blocked, use a custom domain for the Pages site and API under the same parent domain.