# Weekly Coach bot: what we need from IT and others

Each item says what to create or approve, why, and the least privilege needed. All Azure resources go in **South Africa North**. Background: `docs/design.md`.

**Gate:** nobody except the team lead uses the bot until sections 4, 5 and 6 are done.

## 1. Entra ID administrator

- [ ] **App registration** "Weekly Coach", single-tenant.
  - Why: the bot's identity for Azure Bot Service and Microsoft Graph.
  - Least privilege: no delegated permissions or redirect URIs (nobody signs in); a certificate, or a secret of 12 months or less, kept only in Key Vault.
- [ ] **Graph application permissions, with admin consent:**
  - `TeamsAppInstallation.ReadWriteSelfForUser.All`: installs this app (only this app) for each team member, so the bot can message them first.
  - `Calendars.ReadBasic.All`: reads out-of-office blocks for the week (`getSchedule`); no bodies or attachments.
  - `Presence.Read.All`: checks "out of office now" just before each message.
  - Optional `MailboxSettings.Read`: scheduled auto-reply dates; only if calendars prove unreliable.
  - Recommended: limit mailbox access to team members with Exchange "RBAC for Applications" (check it covers calendars).

## 2. Azure subscription owner

One resource group, with a cost centre and a budget alert (about $40–70 a month).

- [ ] **Azure Bot** resource, single-tenant, using the app registration (or a user-assigned managed identity). Messaging endpoint `https://<app-host>/api/messages`; Teams channel only; no OAuth connection.
  - Why: delivers Teams messages to the bot. Bot Service is global (noted for data protection).
- [ ] **Container Apps** environment and one app: exactly 1 replica; external HTTPS ingress so Teams can reach `/api/messages`.
- [ ] **Azure Database for PostgreSQL Flexible Server**, Burstable B1ms, automatic backups on, reachable only from the Container Apps environment, with the managed identity as the bot's only login.
- [ ] **Key Vault** for the Anthropic key, Notion token and bot credential.
- [ ] **User-assigned managed identity** on the container app, with only Key Vault Secrets User (this vault), AcrPull (the registry) and its database login.
- [ ] **Container registry** (Basic), or an approved existing one.
- [ ] **Log Analytics** workspace, 30-day retention; logs hold no message content.
- [ ] **Availability test** on `/healthz`, alerting the team lead.
- [ ] **Deploy access:** Contributor on this resource group only.

## 3. Teams administrator

- [ ] Allow custom app upload for the team lead (testing only), or upload the package yourself.
- [ ] Publish the app to the org catalog (Teams admin center > Teams apps > Manage apps).
- [ ] **App permission policy:** make the app available to the team's members only.
- [ ] **Installs:**
  - personal scope for each member (done by the bot through Graph, or by a setup policy);
  - groupChat scope in the existing OKR meeting group chat (a chat member adds it).
- Manifest (for review): scopes `personal` and `groupChat`; `webApplicationInfo.id` = the app registration ID; no tabs, message extensions or resource-specific consent.

## 4. Anthropic organisation admin

- [ ] A new **workspace** "weekly-coach" in the company's existing Anthropic organisation.
- [ ] One **API key** for that workspace, owned by the organisation (not a personal account), stored in Key Vault.
- [ ] A **monthly spend limit**: suggest $50 (expected $5–15, plus a few dollars per test run).
- [ ] **Record the data-retention setting** (standard, or zero data retention if the organisation has it) for the staff notice.
- Models: `claude-sonnet-5-5` (chat), `claude-opus-5-5` (test judge only).

## 5. Notion workspace owner

- [ ] An **internal connection** "Weekly Coach" with: read content, update content, insert content, and **read user information including email addresses**. No comment capabilities.
  - Why emails: to match each Teams user to their Notion user.
- [ ] **Share the connection** with only the current quarter's OKR tracker and a new parent page "Weekly Coach", where the bot creates its "Weekly Plans & Check-ins" database. The tracker changes only after a person confirms, and only once tracker writes go live.
- [ ] **Restrict** the "Weekly Coach" page to the team.
- [ ] **Confirm the plan tier.** The rate limit is about 3 requests per second (10 on Business and Enterprise), and a workspace-wide limit is shared with existing automations. The bot stays under 2.

## 6. Data-protection officer

- [ ] **Review the transfers:** chat content to Anthropic (US) as processor, under section 72 of South Africa's Protection of Personal Information Act (POPIA) and Part VI of Kenya's Data Protection Act 2019; Teams traffic through Microsoft's global Bot Service. Decide whether an impact assessment is needed.
- [ ] **Approve the one-page staff notice:** what is logged, who sees what, the 90-day transcript purge, Anthropic (US) as processor, and how to see or delete your data (`/mine`). Draft: `docs/design.md` section 11.
- [ ] **Sign off retention:** transcripts 90 days (automatic purge); plan rows kept as work records; audit events and metrics (no message content) 12 months; backups at the Azure default.

## 7. Secret rotation owner

- [ ] **Name one person and a backup** to rotate the Entra client secret (12 months recommended, 24 maximum), the Anthropic key and the Notion token.
  - The bot's daily ops message warns from 30 days before the secret expires.
  - Rotation: add the new value to Key Vault, restart the app, delete the old value.
