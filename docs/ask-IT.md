# Weekly Coach bot: what we need from IT and others

Each item says what to create or approve, why, and the least privilege needed. All Azure resources go in **South Africa North**. Background: `docs/design.md`.

**Start these requests now.** Approvals can take weeks, so ask now even for items needed only in later phases; asking early costs nothing. Which phase needs which approval:

| Phase | What it adds | Approvals needed | Sections |
|---|---|---|---|
| 1–2 | The coach and its tests in the terminal; then it remembers the week | None. Only the team lead uses it, with fictional data and their own chats. The Jev tests run on fictional chats only. | none |
| 3 | Plans logged in Notion | Notion workspace owner | 5 |
| 4 | Scheduler, nudges and Teams cards, tested on a laptop in Microsoft's Agents Playground (a local Teams simulator) | None new | none |
| 5 | Hosted pilot with the team | IT (Azure, Teams admin, and Entra ID only as a fallback), the Anthropic workspace, the data-protection officer, a second deployer | 1–4, 6, 7 |
| 5, optional | Jev as an after-the-fact quality monitor on real chats | Data-protection officer accepts TypeSafe AI as a processor | 6 |
| 6, optional | Calendar: out-of-office days and free time. Perhaps also Jev to recognise commands such as "away" or "skip", but only if the simple keyword match is seen missing them | Entra ID and Exchange administrators, data-protection officer; for the Jev part, the TypeSafe AI approval in section 6 | 6, 8 |

**Owner** is the person who will do the item; **Date asked** is when the team lead asked them. Both start blank. This repository is public, so keep the filled-in copy private (for example in Excel), not here.

**Gate:** nobody except the team lead uses the bot until sections 4, 5 and 6 are done. The staff notice in section 6 names the second deployer, so name them first (section 7). The TypeSafe AI item in section 6 is needed only for the Jev monitor and does not hold up the gate.

## 1. Entra ID administrator

The pilot needs **no Microsoft Graph permissions**. A Teams setup policy installs the app (section 3), and the bot learns who is away from public holidays, any extra company days off in its settings, and the away dates people set themselves (by typing "away" or from the bot's menu). Calendar access is optional and comes later (section 8).

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| **Fallback only: app registration** "Weekly Coach", single-tenant | Needed only if the Azure Bot can't use a managed identity (section 2); we test that in Phase 5. It would be the bot's identity for Azure Bot Service. Least privilege: no API permissions, no delegated permissions or redirect URIs (nobody signs in); a certificate, or a secret of 12 months or less, kept only in Key Vault. Worth a heads-up now, so a fallback isn't a fresh wait. | | | |

**Not requested, by design:** `Mail.Read`, `Chat.Read.All`, `ChatMessage.Send`, `ChannelMessage.Send`, `People.Read`, `Team.ReadBasic.All`. The bot never reads anyone's mail, chats or files, and never posts as a person. For the pilot, also not requested: `TeamsAppInstallation.ReadWriteSelfForUser.All` (the setup policy installs the app instead) and any calendar, presence or mailbox-settings permission (section 8, Phase 6 at the earliest).

## 2. Azure subscription owner

One resource group, with a cost centre and a budget alert (about $40–70 a month).

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| **Azure Bot** resource, single-tenant | Delivers Teams messages to the bot. Identity: the container app's **user-assigned managed identity** (below), so there is no bot secret to expire or rotate. Fallback, if the Teams code library the bot is built on can't use it: the app registration from section 1, with its secret. Messaging endpoint `https://<app-host>/api/messages`; Teams channel only; no OAuth connection. Bot Service is global (noted for data protection). | | | |
| **Container Apps** environment and one app | Runs the bot. Exactly 1 replica; external HTTPS ingress so Teams can reach `/api/messages`. | | | |
| **Azure Database for PostgreSQL Flexible Server** | Holds plans and transcripts. Burstable B1ms, automatic backups on, reachable only from the Container Apps environment, with the managed identity as the bot's only login. Admin access for the team lead and the second deployer only (both named in the staff notice). | | | |
| **Key Vault** | Holds the Anthropic key and the Notion token; also the bot's client secret (fallback only) and the Jev key (only if the Jev monitor goes ahead). | | | |
| **User-assigned managed identity** on the container app | The bot's identity in Azure, used by the Azure Bot too. Only Key Vault Secrets User (this vault), AcrPull (the registry) and its database login. | | | |
| **Container registry** (Basic), or an approved existing one | Holds the bot's container image. | | | |
| **Log Analytics** workspace | 30-day retention; logs hold no message content. | | | |
| **Availability test** on `/healthz` | Alerts the team lead if the bot stops answering. | | | |
| **Deploy access** | Contributor on this resource group only, for the team lead and the second deployer (section 7). | | | |

## 3. Teams administrator

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| **Allow custom app upload** for the team lead | Testing only. Or upload the package yourself. | | | |
| **Publish the app** to the org catalogue | Teams admin center > Teams apps > Manage apps. | | | |
| **App permission policy** | Makes the app available to the team's members only. | | | |
| **App setup policy** | Installs the app (personal scope) for the team's members only. The bot can only message someone first once the app is installed for them; the policy does this without any Graph permission. | | | |
| **Add the bot to the OKR meeting group chat** | groupChat scope; any chat member can add it. | | | |
| **Check the `/away` clash** | Teams has its own `/away` command, which sets your status to Away. Type `/away` in a chat with the bot on desktop, web and phone: does Teams catch it, or does it reach the bot? The bot also understands plain "away" and has a menu button, so this only decides whether `/away` stays as a shortcut. | | | |

Manifest (for review): scopes `personal` and `groupChat`; the bot ID is the managed identity's client ID (or the app registration's ID in the fallback); a command list (plan, away, skip, mine, help) so the commands show in Teams' own menu for the bot; no tabs, message extensions, single sign-on or resource-specific consent.

## 4. Anthropic organisation admin

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| A new **workspace** "weekly-coach" | In the company's existing Anthropic organisation. | | | |
| One **API key** for that workspace | Owned by the organisation (not a personal account), stored in Key Vault. | | | |
| A **monthly spend limit** | Suggest $50 (expected $5–15 for the chats, plus about $1–2 per test run). | | | |
| **Record the data-retention setting** | Standard, or zero data retention if the organisation has it. Needed for the staff notice. | | | |

Models: `claude-sonnet-5-5` (chat), `claude-opus-5-5` (test judge; if the Jev monitor goes ahead, it also re-checks flagged and sampled replies: about $3–5 a month more, and more in the first two weeks, while it checks every reply).

## 5. Notion workspace owner

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| An **internal connection** "Weekly Coach" | Read content, update content, insert content, and **read user information including email addresses**. No comment capabilities. Why emails: to match each Teams user to their Notion user. | | | |
| **Share the connection** | With only the current quarter's OKR tracker and a new parent page "Weekly Coach", where the bot creates its "Weekly Plans & Check-ins" database. The tracker changes only after a person confirms, and only once tracker writes go live. | | | |
| **Restrict** the "Weekly Coach" page to the team | The whole team can see every row, so the bot writes only rows a person has confirmed, and never blocker text or first steps (those stay in the bot's own database). | | | |
| **Confirm the plan tier** | The rate limit is about 3 requests per second (10 on Business and Enterprise), and a workspace-wide limit is shared with existing automations. The bot stays under 2. | | | |
| **Status column check**, early in Phase 3 | Once the connection exists, the team lead runs `npm run notion:create-db` on a test page to confirm Notion's API can set the Status options, as recent versions should. If it can't, the bot uses a Select column instead; nothing more is needed from you. | | | |

## 6. Data-protection officer

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| **Review the transfers** | Chat content to Anthropic (US) as processor, under section 72 of South Africa's Protection of Personal Information Act (POPIA) and Part VI of Kenya's Data Protection Act 2019; Teams traffic through Microsoft's global Bot Service. Decide whether an impact assessment is needed. | | | |
| **Review special personal information** | Chats may mention customers or suspects, although the coach asks people to describe the work, not the case. An allegation that someone committed an offence is special personal information under POPIA section 26. From Phase 2 the bot masks South African and Kenyan phone numbers, 13-digit South African ID numbers, phone serial numbers (IMEIs) and account or ID numbers written next to a label, before a message reaches Claude or the bot's database. Names and descriptions can still get through. The Save step also records whether such details came up, and the bot's daily ops message to the team lead (a status message with counts only, no chat text) shows how many chats had them. | | | |
| **Approve the one-page staff notice** | What is logged; who sees what (the whole team sees the Weekly Plans rows in Notion); who runs the service: the team lead and a second deployer, who could technically read transcripts and commit not to; the 30-day transcript purge; Anthropic (US) as processor; that Teams keeps its own copy of every chat, which deleting your transcripts in the bot does not remove; how to see or delete your data (`/mine`); and a request to keep customer and suspect details out, with the reason (special personal information, POPIA section 26). Draft: `docs/design.md` section 11. The wording must match how access is actually set up (sections 2 and 7). | | | |
| **Sign off retention** | Transcripts 30 days (automatic purge); plan rows kept as work records; audit events and metrics (no message content) 12 months; database backups at the Azure default of 7 days, so a purged transcript can sit in a backup for up to a week longer. | | | |
| **TypeSafe AI as a processor**, only for the optional Jev monitor | Needed only before Jev sees real chats. See below. | | | |

**About Jev (TypeSafe AI).** Jev is a classifier: it answers yes/no questions about a piece of text, quickly and cheaply, and writes no text of its own.

- **What it is for here.** Now: quick, cheap tests of the coach on fictional chats (Jev's part costs about a tenth of a cent a test run), so prompt changes can be tried fast; Claude Opus stays the judge before a release. Later, if you agree: an after-the-fact quality monitor. Once a reply has been sent, Jev reads it with the chat before it (by default the last four turns) and checks five things: whether the coach did the person's work for them, went into method or steps, asked several things at once, or stated an outcome, recipient or deadline the person never gave; and whether the chat contains customer or suspect details. Flagged replies and a 10% random sample go to Claude Opus for a second look. The team lead sees counts only, in the bot's daily ops message. For the first two weeks Opus checks every reply too, to compare.
- **Limits of the monitor.** Never on the chat's live path, so nobody waits for it. It checks the coach, never the person, and is never a decision about anyone. A check that fails or takes over 2 seconds counts as "unknown".
- **What it does not do.** Jev can't make the coach's first words appear sooner: it writes no text and doesn't stream. Chat already costs only about $5–15 a month. People get a quicker chat because the coach now asks fewer questions, not because of Jev. We ruled out using it to:
  - route messages, such as "away" or "skip" (a keyword match is instant and keeps the data here; to be looked at again in Phase 6 only if the keyword match misses commands, and only with your approval);
  - link each item to a key result (the Save step already returns it);
  - flag sensitive content during the chat (by the time a flag came back, the text would already have reached Claude, and it would send the chat to a second US company; masking is the fix);
  - judge whether a plan is complete (it would always be a turn behind);
  - approve each reply before it is shown (the reply could no longer appear word by word, and every reply would be slower).
- **Facts for the review.** Hosted in the US, on AWS and Modal. No zero data retention by default (only for enterprise customers, on request). TypeSafe AI says it does not train on customer data. A data processing agreement with the EU's standard contractual clauses (standard contract terms for sending personal data abroad). So it would be a second US processor under POPIA section 72 and Part VI of the Kenyan Act. It would see masked text only. Until you agree, Jev sees fictional test chats only: its scripts refuse anything else unless deliberately overridden. If you say no, it stays that way.

## 7. Second deployer and secret rotation

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| **Name a second deployer** (Phase 5) | Someone besides the team lead who can deploy, restart and fix the bot from a one-page runbook. They get the same Azure and database access as the team lead, so the staff notice names them. | | | |
| **A repository in the team's DevOps project** | Holds the bot's code, with an approved pull request (a reviewed change) required before anything goes live. | | | |
| **Name one person and a backup to rotate secrets** | The Anthropic key and the Notion token, and the Jev key if the monitor goes ahead. Rotation: add the new value to Key Vault, restart the app, delete the old value. With the managed identity there is no bot secret. In the fallback, the Entra client secret too (12 months recommended, 24 maximum); the bot's daily ops message warns from 30 days before it expires. | | | |

## 8. Later, optional (Phase 6): calendar access through Microsoft Graph

The pilot needs none of this. Ask only if, after the pilot, public holidays and the away dates people set themselves miss too many absences, or the team wants the coach to know each person's free time ("About 14 free hours this week"). Who: the Entra ID administrator, the Exchange administrator for the scoping, and the data-protection officer. The permissions go to the bot's identity (section 2).

| Request | Detail | Owner | Date asked | Done |
|---|---|---|---|---|
| **Calendar free/busy for the week** (`getSchedule`), scoped to the team (preferred) | Out-of-office days and the person's free time. Exchange "RBAC for Applications" (role-based access for apps): role `Application Calendars.Read`, limited by a management scope or administrative unit to team members. Exchange has no ReadBasic role, so this permission could read event bodies (the bot doesn't). RBAC grants add to Entra grants, so for the scoping to mean anything there must be **no** tenant-wide Entra `Calendars.Read` or `Calendars.ReadBasic.All` consent for this bot. Application access policies are legacy; don't create new ones. | | | |
| Alternative: **tenant-wide `Calendars.ReadBasic.All`** (Entra admin consent) | Sees no event bodies or attachments, but covers every mailbox in the tenant. Choose between this and the scoped option with the data-protection officer. | | | |
| Optional: **`Presence.Read.All`** | Checks "out of office now" just before each message. It can't be limited to the team (the Exchange scoping covers mailboxes only), so ask only if the calendar check proves not enough. | | | |
| Optional: **`MailboxSettings.Read`** | Scheduled auto-reply dates, only if calendars prove unreliable. It can be scoped in the same way (`Application MailboxSettings.Read`). | | | |
