# Google reviews

Read and answer every client's Google reviews from one place, by hand or with an AI assistant over MCP. Each location has reply rules that decide what an assistant may publish on its own; everything else waits for a person to approve it. The page also shows each Business Profile's performance: calls, website clicks, direction requests, Search and Maps views, and the searches that found it.

## How it fits together

- **Business Profile APIs.** The app reads accounts and locations through the Business Information API, reviews and replies through the v4 reviews API, and performance through the Business Profile Performance API. Every call uses a Google connection that granted the `business.manage` scope.
- **Locations.** You link the Business Profile locations you manage to a workspace (one per client). The app syncs each location's reviews about every hour (`REVIEWS_SYNC_MINUTES`), with a full re-sync daily.
- **Reply rules.** People replying on the dashboard always publish directly. Replies from an AI assistant go through the location's rules: inside them they publish, otherwise they wait on **Approvals & history**, or are blocked when the location is read-only.
- **Audit trail.** Every reply made through the app — who or which assistant proposed it, who approved it, the text and the outcome — is kept on **Approvals & history**.

## Set up

Open **Reviews → Setup** and follow the checklist.

1. **Connect Google with Business Profile access.** Use **Add Business Profile access** on an existing Google connection (it keeps Search Console, Google Ads and everything else it already has), or connect a Google account with Business Profile ticked. Sign in as a user who is an owner or manager of your clients' Business Profiles.
2. **Enable the Business Profile APIs** on the Google Cloud project that owns the OAuth client: My Business Account Management, My Business Business Information, Google My Business and Business Profile Performance. The app enables them for you if the connection granted Cloud access; otherwise use **Enable automatically** or the Cloud console.
3. **Get the project approved by Google.** Google only serves these APIs to approved projects — an unapproved project has a quota of 0 requests per minute and every call fails. Apply once with the [request form](https://support.google.com/business/contact/api_default) (*Application for Basic API Access*), giving the Cloud project number the Setup page shows. Google asks for a Business Profile that has been verified and active for at least 60 days, with a website listed, and expects the request from an email address that owns or manages that profile. Approval shows as a 300 requests-per-minute quota on the project's Business Profile API quotas. The APIs themselves are free.
4. **Link your clients' locations.** **Find and link locations** lists every location the connected users manage. Linking imports the existing reviews without sending alerts.

Replies only work on verified locations; Google refuses them for unverified profiles.

## Reply rules and brief

Edit a location on **Locations & reply rules**.

| Rule | Default | What it does |
| --- | --- | --- |
| Mode | Auto-publish replies to good reviews | *Auto-publish replies to good reviews*: replies to reviews rated at least the threshold publish; others need approval. *Auto-publish replies inside the rules*: any rating. *Approve every reply*: everything waits. *Read-only for AI assistants*: assistants can't reply. |
| Auto-publish threshold | 4 stars | For the first mode. |
| Longest reply without approval | 1,000 characters | Google's own limit is 4,096 bytes. |
| Allow links | Off | Replies with a URL need approval. |
| Allow phone numbers and emails | On | Turn off to check every reply that shares contact details. |
| Allow replacing a published reply | Off | Replacing an existing reply needs approval. |
| Phrases that always need approval | none | For example "refund" or "compensation". |
| Alert me about new reviews rated | 3 stars or fewer | Sends a notification through the workspace's channels. |

Replies that still look like a template (`[Name]`, `{{first_name}}`) always need approval, and deleting a published reply always does.

The **brief** shapes how replies sound: business name, voice, sign-off, where unhappy customers should go, language and things never to say. Assistants read it with `reviews_get_brief`; they can add notes but can't change the rules.

## Reports

Add the **Google reviews and Business Profile** section to a report template (**Reports → New template**) to send clients each location's rating, new reviews, response rate, unanswered reviews and Business Profile calls, website clicks, direction requests and views for the period.

## Alerts

Turn on **Google review alerts** under **Settings → Notifications**. The app then tells you when a new review at or below a location's alert threshold arrives, or when Google rejects a reply (with the policy reason). Each sync sends at most one message per location and lists up to eight reviews.

## Answering reviews with an AI assistant

Connect an MCP-capable assistant (see [Connect an AI assistant](GOOGLE_ADS.md#connect-an-ai-assistant)) and tick **Reply to Google reviews** on the sign-in screen — or **Review replies** on a personal token. Reading reviews only needs the default read permission.

**Reviews → AI routine** asks how often to run, how far back to look and whether replies may publish within the rules or should all be drafts, then builds a prompt to paste into a scheduled task in your assistant.

| Tool | Permission | What it does |
| --- | --- | --- |
| `reviews_list_locations` | read | Linked locations with rating, unanswered counts, rules and brief. |
| `reviews_discover_locations` | read | Business Profile locations the connected users manage. |
| `reviews_sync` | read | Refresh reviews and reply moderation states now. |
| `reviews_list` | read | Reviews by filter: unreplied, 1–3 stars, reply rejected, awaiting approval or all. |
| `reviews_get` | read | One review with its reply history. |
| `reviews_summary` | read | Rating, distribution, 30-day trend, response rate and time, monthly trend. |
| `reviews_business_performance` | read | Calls, website clicks, directions, Search and Maps views vs the previous period, plus search terms. |
| `reviews_get_brief` | read | Voice, sign-off, contact for issues and reply rules. |
| `reviews_list_replies` | read | Replies made through the app, e.g. published ones as house-style examples. |
| `reviews_reply` | reviews:write | Publish a reply within the rules, or queue it for approval (`publish: false` always queues). |
| `reviews_delete_reply` | reviews:write | Ask to delete a reply (always needs approval). |
| `reviews_update_brief` | reviews:write | Save notes about how replies should sound. |
| `reviews_link_location` | reviews:write | Link a discovered location. |

Workspace viewers stay read-only whatever their token allows, and editors need the **Manage Google reviews** permission to reply or approve.

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Google has not approved this Cloud project* (quota 0) | Apply for Basic API access (step 3). Re-check after Google's email arrives. |
| *APIs not enabled* (`SERVICE_DISABLED`) | **Enable automatically**, or enable the four Business Profile APIs in the Cloud console. |
| *No Business Profile access* | **Add Business Profile access** on the connection. |
| *Reconnect required* | The Google sign-in expired or was revoked; reconnect the account. |
| *Not an owner or manager of this profile* | Add the connected Google user under Business Profile → Settings → People and access. |
| *Google only accepts replies for verified Business Profiles* | Verify the profile in Business Profile Manager. |
| A reply shows *Rejected by Google* | Google's moderation refused it; the reason is shown. Write a new reply — the review counts as unanswered until then. |
| *The server couldn't connect to …googleapis.com* | See the network row in the [Google Ads troubleshooting](GOOGLE_ADS.md#troubleshooting): ad-blocking DNS or a firewall often blocks Google business domains. |
