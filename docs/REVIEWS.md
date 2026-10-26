# Google Business Profile

Manage every client's Google Business Profile from one place, by hand or with an AI assistant over MCP: read and answer reviews, edit the profile (description, phone, website, opening and holiday hours), publish posts and photos, and catch edits Google or the public made. Each location has rules that decide what an assistant may publish on its own; everything else waits for a person to approve it. The page also shows each profile's performance: calls, website clicks, direction requests, Search and Maps views, and the searches that found it.

## How it fits together

- **Business Profile APIs.** The app reads accounts and locations, and reads and edits the profile, through the Business Information API. Reviews, replies, posts and photos go through the v4 API, and performance through the Business Profile Performance API. Every call uses a Google connection that granted the `business.manage` scope.
- **Locations.** You link the Business Profile locations you manage to a workspace (one per client). The app syncs each location's reviews about every hour (`REVIEWS_SYNC_MINUTES`), with a full re-sync daily, and checks once a day for fields Google changed.
- **Rules.** People on the dashboard always publish directly. Replies, profile edits, posts and photos from an AI assistant go through the location's rules: inside them they publish, otherwise they wait on **Approvals & history**, or are blocked.
- **Audit trail.** Every reply and profile change made through the app is kept on **Approvals & history**: who or which assistant proposed it, who approved it, what it said and what Google did with it.

## Set up

Open **Business Profile → Setup** and follow the checklist.

1. **Connect Google with Business Profile access.** Use **Add Business Profile access** on an existing Google connection (it keeps Search Console, Google Ads and everything else it already has), or sign in a new Google account. Sign in as a user who is an owner or manager of your clients' Business Profiles.
2. **Enable the Business Profile APIs** on the Google Cloud project that owns the OAuth client: My Business Account Management, My Business Business Information, Google My Business and Business Profile Performance. **Switch on for me** does it with a one-off Google sign-in that keeps no Cloud access, or enable them in the Cloud console.
3. **Get the project approved by Google.** Google only serves these APIs to approved projects. An unapproved project has a quota of 0 requests per minute and every call fails. Apply once with the [request form](https://support.google.com/business/contact/api_default) (*Application for Basic API Access*), giving the Cloud project number the Setup page shows. Google asks for a Business Profile that has been verified and active for at least 60 days, with a website listed, and expects the request from an email address that owns or manages that profile. Approval shows as a 300 requests-per-minute quota on the project's Business Profile API quotas. The APIs themselves are free.
4. **Link your clients' locations.** **Find and link locations** lists every location the connected users manage. Linking imports the existing reviews without sending alerts.

Replies and posts only work on verified locations; Google refuses them for unverified profiles.

## A separate Google account or Cloud project

Google approves the Business Profile APIs per Cloud project, and the approval often ends up on a different project from the one you use for Search Console, or with a different Google user. The app handles both:

- **A different Google user.** Under **Setup → Connect Business Profile separately**, pick a **Google Cloud project** you already use and sign in. The app reuses that project's OAuth client, so there's nothing to re-enter; choose the other user on Google's screen.
- **The same Google user, another project.** Choose **Another project (enter its OAuth client)** and enter that project's client ID and secret once (a *Web application* client with the redirect URI the page shows). The client is saved for the workspace, with an optional name, so later sign-ins pick it from the list; **Save project for later** keeps it without signing in. A Google user can be connected once per project, so Search Console keeps using its connection and your locations use this one. Each connection shows its project number on the Setup tab and under **Settings → Google Accounts**.
- **Business Profile only.** Tick **Only ask Google for Business Profile access** (on by default for another project). The consent screen then shows just Business Profile and the email address, so that project doesn't need Search Console or Analytics configured. These connections are never offered to sites for Search Console.
- **Moving locations.** Open a location's settings on **Locations & rules** and pick another connection, or use **Use this connection** in **Find and link locations**. The app checks that the new connection can see the location and read its reviews before it switches; reviews, rules, brief and history stay.

When a project is still waiting for Google, the Setup tab shows the approval steps and quota link for that project's number. If another project is already approved, connect through it and move the locations across.

A sign-in through a project that already has a connection for the same Google user is refused if it would remove that connection's Search Console, Google Ads or Business Profile access (for example a Business-Profile-only sign-in over a full connection). Use **Add Business Profile access** or **Reconnect** on the existing connection instead. Google Ads works the same way; see [Several Google accounts and projects](GOOGLE_ADS.md#several-google-accounts-and-projects).

## Let a client connect their own Google account

Google approves the Business Profile APIs for a **Cloud project** (the OAuth client), not for a Google account. Once your project is approved, any Google user who signs in through it can let the app manage *their* profiles: the calls use the client's own sign-in but count against your project and its approval. Social schedulers such as Mixpost work this way, and it means nobody has to add you as a manager on the profile first.

1. Connect Google through your approved project at least once (for example `you@agency.com` on the project Google approved), or save that project's OAuth client on the **Setup** tab.
2. On **Setup → Connect a client's Business Profile**, pick that project, then choose how:
   - **Send a link.** Optionally enter the client's name and email, and click **Create link** (or **Create and email link** when email is set up). The link works for 3 to 30 days. The client opens it (no account needed here), clicks **Connect with Google**, chooses the Google account they use for their Business Profile and approves **Business Profile access only**. They then tick which of their profiles to share; each one is linked to the workspace straight away and its reviews are imported. You get a notification (event *Google connections*) when they connect and when they share, and the link list shows each link's status, the Google account used and the profiles shared.
   - **Sign in here.** When you're with the client or have their Google login, click **Sign in with the client's Google account**, choose their account on Google's screen and approve Business Profile access. The location picker then opens for that account so you choose which profiles to link.

Either way the connection belongs to the person who created the link or signed in, and is shared with that workspace, like any other connection. Only the browser that did the Google sign-in can list and share the client's profiles, so a forwarded link can't expose them. Until they share a profile, the client can sign in again with a different Google account if they picked the wrong one. Cancel an unused link at any time; the client can remove access from their Google Account (Security → Your connections to third-party apps).

Your project's OAuth consent screen must be set to **External** and **In production**, and Google expects it to be verified for the Business Profile scope. An **Internal** app only lets people in your own Google Workspace organisation sign in, and in **Testing** only listed test users can sign in and their access expires after 7 days. Every client's calls share your project's Business Profile quota (300 requests a minute once approved).

## Profile, posts and photos

- **Profile.** A completeness checklist (verification, description length, categories, phone, website, opening hours, holiday hours for the next 60 days, photos, logo and cover, recent posts, review replies, fresh reviews, Google-suggested edits) with the next step for each gap. Edit the description (up to 750 characters, no links), phone, website, weekly opening hours (up to three periods a day, overnight periods allowed) and special or holiday hours. Name, categories and address stay in Business Profile Manager, because Google may ask you to verify again after changing them.
- **Posts.** Publish updates, events and offers with an optional photo and button (Book, Order online, Buy, Learn more, Sign up, Call now). Google rejects posts that contain a phone number, so the composer warns you and the Call now button uses the profile's number. The list shows Google's state for each post: live, processing or rejected.
- **Scheduled posts.** Set **Publish** to **At a set time** and pick a date and time (in your own time zone, up to a year ahead). Google's API has no scheduling, so this server holds the post and publishes it within a minute of that time; the server must be running then. Scheduled posts are listed under **Posts waiting to go out** on the Posts tab and under **Approvals & history**, each with **Cancel**. A post from an AI assistant that needs approval waits for it first: approving it keeps its time, or publishes it straight away if the time has passed. If Google refuses a scheduled post when it goes out, the workspace gets a *Business Profile changes* notification.
- **Photos.** Add a photo from a public image address (JPG or PNG, at least 250 × 250 pixels) with a category such as exterior, interior, team, at work or product. The grid shows each photo's views.

## Rules for AI assistants

Edit a location on **Locations & rules**.

### Review replies

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

### Profile, posts and photos

| Rule | Default | Choices |
| --- | --- | --- |
| Profile edits (description and hours) | Wait for my approval | *Wait for my approval*, *Publish within the checks*, *Not allowed*. |
| New posts | Wait for my approval | Same choices. |
| New photos | Wait for my approval | Same choices. |
| Alert me when Google changes the profile | On | Sends a *Business Profile changes* notification. |

Some changes always wait for a person, whatever the mode: phone and website changes, hours that would close a day that is open now, removing special hours, offers, new logo, cover or profile photos, and any deletion. Text that still looks like a template also waits. Input Google would refuse (a description over 750 characters, a post with a phone number, an event without dates, a photo that isn't a public `https` address) is rejected with the reason before anything is recorded.

## Google-suggested edits

Google sometimes changes a profile itself, or accepts an edit someone suggested through *Suggest an edit*, and then shows its version instead of yours. Once a day the app asks Google which fields differ and alerts the workspace once per new difference. The **Profile** tab lists the fields and, for the description, phone, website and hours, shows both versions side by side with **Keep my version** (sends yours back to Google) and **Accept Google's version**. Name, category and address differences are settled in Business Profile Manager. The tab also lists your own edits that Google hasn't published yet.

## Reports

Add the **Google reviews and Business Profile** section to a report template (**Reports → New template**) to send clients each location's rating, new reviews, response rate, unanswered reviews and Business Profile calls, website clicks, direction requests and views for the period.

## Alerts

Under **Settings → Notifications**:

- **Google review alerts**: a new review at or below a location's alert threshold arrives, or Google rejects a reply (with the policy reason). Each sync sends at most one message per location and lists up to eight reviews.
- **Business Profile changes**: Google, or someone using *Suggest an edit*, changed a profile. Checked daily, sent once per change.
- **Business Profile approvals**: an AI assistant proposed a reply, profile edit, post or photo that the location's rules hold for a person. The message links straight to it; the page shows the review and the proposed reply (editable) with **Approve** and **Reject**. Proposals made close together arrive as one message.

Send these to email, WhatsApp, Slack and the other channels, and choose which channel or email list gets which event. See [notifications](INTEGRATIONS.md#notifications).

## Working with an AI assistant

Connect an MCP-capable assistant (see [Connect an AI assistant](GOOGLE_ADS.md#connect-an-ai-assistant)) and tick **Manage Google Business Profile** on the sign-in screen, or **Business Profile** on a personal token. Reading only needs the default read permission.

An assistant only sees the tools its connection is allowed to use. If it says it has no tool to reply to reviews or add photos, the connection was approved read-only (the default when the app doesn't ask for anything specific). Open **Business Profile → Setup → Connect an AI assistant**, click **Change access** on the app, tick **Business Profile changes**, save, and start a new chat. There's no need to disconnect it. The connection also tells the assistant what it's missing and where to change it.

**Business Profile → AI routine** asks how often to run, how far back to look and whether replies may publish within the rules or should all be drafts, then builds a prompt to paste into a scheduled task in your assistant.

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
| `business_get_profile` | read | The profile, completeness checklist, Google-suggested edits, AI rules and changes waiting for approval. |
| `business_check_google_updates` | read | Ask Google now which fields it shows differently. |
| `business_list_posts` | read | Posts with Google's state and links, plus posts scheduled for later and any waiting for approval. |
| `business_list_photos` | read | Photos and videos with category, views and the address each was added from. |
| `business_list_changes` | read | Profile edits, posts and photos made or proposed through the app. |
| `reviews_reply` | reviews:write | Publish a reply within the rules, or queue it for approval (`publish: false` always queues). |
| `reviews_delete_reply` | reviews:write | Ask to delete a reply (always needs approval). |
| `reviews_update_brief` | reviews:write | Save notes about how replies should sound. |
| `reviews_link_location` | reviews:write | Link a discovered location. |
| `business_update_profile` | reviews:write | Change the description, phone, website, weekly hours, or add and remove special hours. |
| `business_create_post` | reviews:write | Post an update, event or offer, with an optional photo and button, now or at a set time (`publishAt`, ISO 8601 with a time zone). |
| `business_cancel_scheduled_post` | reviews:write | Cancel a scheduled post, or one waiting for approval, before it goes out. |
| `business_delete_post` | reviews:write | Ask to delete a post (always needs approval). |
| `business_add_photo` | reviews:write | Add one photo or video from a direct link. |
| `business_add_media` | reviews:write | Add up to 25 photos and videos in one go, with a result per item. |
| `business_delete_photo` | reviews:write | Ask to delete a photo (always needs approval). |

Workspace viewers stay read-only whatever their token allows, and editors need the **Manage Google Business Profile** permission to reply, post, edit or approve.

### Photos and videos from other tools

An assistant can copy a team's job photos and videos into the gallery from anywhere it can get a direct link, for example media in a social media scheduler such as Mixpost, a shared drive or a CDN. Google downloads each file from its link, so the link must point at the file itself and be publicly reachable.

- **Before Google sees it,** each link is checked: a web page instead of the file, a missing or private file, the wrong type, or a size outside Google's limits fails with a reason. Photos must be JPG or PNG, 10 KB to 5 MB and at least 250×250 pixels (720×720 or larger looks best). Videos can be up to 30 seconds and 75 MB, at 720p or higher.
- **Videos** are recognised by their extension (`.mp4`, `.mov`…) or `format: "video"`. They can't be the cover, profile or logo.
- **Repeats are skipped.** An address already added through the app, or that Google reports for a photo added with another tool, isn't sent again; neither is an address listed twice in one request. Pass `allowDuplicates: true` to add it anyway.
- **Rules still apply.** The location's photo rule decides whether each item publishes or waits. Waiting items arrive as one notification, and **Approvals & history** has **Approve all** for a batch of photos and videos.
- Google checks every photo and video itself and can still reject or hide one, for example a blurry image, a photo of a screen or one showing personal details.

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Google has not approved this Cloud project* (quota 0) | Apply for Basic API access (step 3), or connect through a project Google already approved and move the locations onto it. Re-check after Google's email arrives. |
| *APIs not enabled* (`SERVICE_DISABLED`) | **Switch on for me**, or enable the four Business Profile APIs in the Cloud console. |
| *No Business Profile access* | **Add Business Profile access** on the connection. |
| *Reconnect required* | The Google sign-in expired or was revoked; reconnect the account. |
| *Not an owner or manager of this profile* | Add the connected Google user under Business Profile → Settings → People and access. |
| *… can't see … in any Business Profile account it manages* | The connection you're moving a location to has no access to it. Add that Google user to the profile, then try again. |
| *… already connected through this Google Cloud project with Search Console access* | Use **Add Business Profile access** on that connection, or connect through a different project. |
| *Google only accepts replies for verified Business Profiles* | Verify the profile in Business Profile Manager. |
| A reply shows *Rejected by Google* | Google's moderation refused it; the reason is shown. Write a new reply; the review counts as unanswered until then. |
| A post shows *Rejected by Google* | Usually a phone number, a link shortener or promotional wording Google doesn't allow. Delete it and post again. |
| *The server couldn't connect to …googleapis.com* | See the network row in the [Google Ads troubleshooting](GOOGLE_ADS.md#troubleshooting): ad-blocking DNS or a firewall often blocks Google business domains. |
