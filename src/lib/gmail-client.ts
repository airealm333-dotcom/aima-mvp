import { JWT, OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

/**
 * Gmail API client for intake polling.
 *
 * Option A (Google Workspace): `GMAIL_SERVICE_ACCOUNT_JSON` + `GMAIL_DELEGATED_USER_EMAIL`
 * with domain-wide delegation for scope `https://www.googleapis.com/auth/gmail.modify`.
 *
 * Option B: OAuth installed app — `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
 * `GMAIL_OAUTH_REFRESH_TOKEN`.
 */
export function getGmailClientOrNull() {
  const saJson = process.env.GMAIL_SERVICE_ACCOUNT_JSON;
  const delegatedUser = process.env.GMAIL_DELEGATED_USER_EMAIL;

  if (saJson && delegatedUser) {
    try {
      const creds = JSON.parse(saJson) as {
        client_email: string;
        private_key: string;
      };
      const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        subject: delegatedUser,
      });
      return google.gmail({ version: "v1", auth: jwt });
    } catch {
      return null;
    }
  }

  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_OAUTH_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new OAuth2Client(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: "v1", auth: oauth2 });
  }

  return null;
}
