# Reviewed external delivery

Configure **Connections** as a workspace owner/admin, select an exact destination and describe its audience. Create and save a workflow draft, then choose **Review external delivery**. The review shows the actual saved text, destination and audience. A confirmation queues the delivery; changing a draft, revision, connection or video access before sending cancels it. Video visibility never changes to make an external link work.

Credentials use the existing AES-256-GCM server encryption. They never appear in API responses, logs, browser bundles or job payloads. Connections accept manually supplied scoped tokens or a connected OAuth account when the server owner has configured the provider application. The account flow supports authorization and token refresh where the provider supplies refresh credentials; manual tokens still require replacement when expired. Destination discovery and comprehensive live-provider qualification remain incomplete. Saving a connection never delivers content; Atlassian OAuth connections check access to the selected site.

| Connector | Implemented write | Operator credentials / requirements (manual-token path) |
|---|---|---|
| GitHub | New issue, or comment on a selected issue/PR | Fine-grained token for the repository; Issues write, or the applicable PR write permission |
| Slack | Plain-text message in a selected channel; no mention expansion or unfurls | Bot token with `chat:write`; bot admitted to that channel |
| Jira Cloud | Issue with selected project and issue type; description uses ADF | Account email/API token; create-issue permission and required fields satisfied by the project |
| Confluence Cloud | New page in selected space, optional parent | Account email/API token; page-create permission in that space |
| Linear | Issue in selected team | Personal API key with issue-write access |
| Notion | Page under explicitly shared parent page | Internal integration token with insert-content capability; parent shared with integration |
| Microsoft Teams | Text channel message | Delegated Graph access token with `ChannelMessage.Send`; applicable tenant/channel permission |
| Gmail | Mailbox draft to selected recipient; never sends | OAuth access token obtained by the operator with `gmail.compose` |
| Outlook | Mailbox draft to selected recipient; never sends | Delegated Graph access token with `Mail.ReadWrite` |

These adapters passed protocol fixtures, not live-account qualification. Jira projects requiring custom fields need further field-mapping support; JSM request types are not supported by the generic issue adapter. Calendar OAuth, sync and per-occurrence selection exist in the Meetings area; they do not capture a meeting. Salesforce engagement sync, provider recording imports, signed webhooks/scoped service tokens, and the planned compatibility catalogue remain pending. An exported URL is not counted as a native connector.

The durable outbox snapshots draft, revision, destination version, actor and video access. Workers recheck these under database locks immediately before the bounded provider call. Duplicate enqueue uses a workspace-scoped idempotency key. Explicit 429 responses retry within the existing job budget. Lost acknowledgements, malformed success responses, uncertain 5xx responses, or a crash after send begins stop in `uncertain`; they never silently resend. Inspect the provider, then record its item ID or explicitly confirm absence before retrying. A successful mail delivery means **draft created**, not email sent.

**Connections → Recent deliveries across versions** retains recovery controls after another video revision publishes. Only current video editors can see or reconcile those deliveries. A retry still checks the original review snapshot and cancels when it is stale. Already copied external text cannot be retracted by revoking Relay access.

Limits: 100 active connections/workspace, 30 enqueue requests/user/hour, 30,000 draft characters (Slack: 12,000), 15-second provider requests, 1 MiB acknowledgements. Only fixed provider origins and strictly validated destination identifiers are accepted; redirects are rejected. No arbitrary webhook URL is accepted.

Schema 13 is additive and reapplication preserves outbox state. For deployment, stop old workers before migrating/starting the new web and worker images; old workers do not understand delivery jobs. Rollback: stop new workers, retain added tables and drafts, disable/drain new jobs, and deploy the previous application without rerunning its older schema script. Do not drop the new tables or original media. Back up PostgreSQL and retain the encryption key before upgrading.

References: [GitHub issues](https://docs.github.com/en/rest/issues/issues#create-an-issue), [Slack messages](https://docs.slack.dev/reference/methods/chat.postMessage/), [Jira issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Confluence pages](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/), [Linear GraphQL](https://linear.app/developers/graphql), [Notion pages](https://developers.notion.com/reference/post-page), [Teams channel messages](https://learn.microsoft.com/en-us/graph/api/channel-post-messages), [Gmail drafts](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create), [Outlook drafts](https://learn.microsoft.com/en-us/graph/api/user-post-messages).
