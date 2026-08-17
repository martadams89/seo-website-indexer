# Users and workspaces

Workspaces let one installation serve several clients, brands or internal teams without mixing their data. They are the application's tenant boundary.

## The basic model

- A user has one login and can belong to several workspaces.
- A workspace owns its sites, reports, settings, usage and other operational data.
- Each workspace has one owner and may have any number of admins, editors and viewers.
- The workspace selected in the sidebar is the active tenant for every request.
- A super-admin can see and manage every user and workspace in the installation.

An upgrade from an older single-workspace installation is automatic. The first user to sign in claims the existing data in a default workspace.

## Roles

| Role | Normal access |
| --- | --- |
| Owner | Full access to the workspace, including ownership and deletion. |
| Admin | Full operational access plus member, invitation and workspace management. |
| Editor | Full operational access by default, without member or workspace administration. Individual capabilities can be removed. |
| Viewer | Read-only access. API writes are rejected. |

Editors have six separately controlled capabilities:

- Manage sites and submissions
- Manage integrations and API keys
- Manage notifications
- Manage actions, entities and content
- Manage reports and saved views
- Manage governance, budgets, tokens and webhooks

Admins always have all six capabilities. Viewers cannot be granted write capabilities. Owners and super-admins have full access.

AI Visibility has a separate membership switch because running provider queries can incur a cost. Owners and super-admins always have access. Other members must have the switch enabled and are subject to `AI_CITATION_DAILY_LIMIT`.

## Creating users and inviting members

There are two common routes:

### Invite from a workspace

An owner or workspace admin can open **Settings → Workspace**, enter an email address and choose a role and AI Visibility access.

- An existing user accepts the invitation and gains access to that workspace.
- A new user follows the link and sets a password.
- The user lands in the workspace they joined rather than seeing a new-install setup wizard.

SMTP sends the invitation by email. Without SMTP, the interface provides a link that can be copied and sent through another secure channel.

### Create from platform administration

A super-admin can open **Settings → Users** and create an account directly. The account can receive its own workspace or be added to an existing one. A generated password is temporary and must be changed at first sign-in.

Select an existing user to update their name or email, inspect security history, change workspace memberships and permissions, recover the account or impersonate it for support.

## Google accounts

Dashboard identity and Google identity are separate. A person can sign in to the application with a password or SSO and connect a different Google account for Search Console.

A Google credential:

- belongs to the user who completed the Google OAuth flow;
- can be shared with one or more workspaces that user can access;
- can be used by other members of those workspaces;
- can be removed from one workspace without deleting the underlying credential;
- can be deleted everywhere only by its owner or a super-admin.

An editor with **Manage integrations and API keys** can connect their own Google account to the active workspace. This supports both common operating models: a client can provide its own Google account, or the team can use a Google account already shared with the workspace.

## Layered settings

API keys and notifications can be stored at two levels:

1. A workspace override, used only by the active workspace.
2. A platform default, available to workspaces that do not have an override.

Resolution is always workspace override first, then platform default. A super-admin manages platform defaults. Users with the relevant workspace capability manage workspace overrides.

This makes it possible to use:

- a shared provider account for every workspace;
- client-owned keys for every workspace; or
- shared defaults with selected workspace overrides.

The interface labels platform and workspace settings separately. Check the scope banner before changing a key or notification channel.

## Super-admin controls

Super-admins can:

- create, rename, reassign and delete any workspace;
- create, edit, disable and delete users;
- add or remove any user's workspace memberships;
- change workspace roles, editor capabilities and AI Visibility access;
- send a password-reset email or create a reset link;
- generate a temporary password that must be changed at next sign-in;
- clear a user's TOTP setup;
- disable an account across the installation;
- inspect a user's Google credentials and recent audit history; and
- impersonate a user through a visibly marked support session.

Starting and stopping impersonation is audited. Administration performed during the impersonated session retains the acting administrator in its audit context.

## Disabling and deleting access

Disabling a workspace membership removes access only to that workspace. Disabling the user account prevents sign-in to every workspace.

When a user is deleted, workspaces they own are reassigned to the acting super-admin so tenant data is not orphaned. Workspace deletion is separate and removes that tenant's data, so take a backup and verify the selected workspace before confirming it.

## Workspace security policy

A workspace can require MFA before members perform write operations. A TOTP authenticator or passkey satisfies the requirement. Super-admins should still enable MFA on their own accounts even when a workspace policy does not require it.

Access control is enforced on API requests. Hiding an action in the interface is not treated as the security boundary.
