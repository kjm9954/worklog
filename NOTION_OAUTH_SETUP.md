# WorkLog Notion OAuth Setup

This is the public-template flow that avoids manual code entry.
It also tries to patch WorkLog embeds inside existing Notion pages that the
user grants access to during OAuth.

## Flow

1. A user clicks `Notion 연결하기`.
2. Notion OAuth runs with the public connection template option.
3. Notion duplicates the template and returns `duplicated_template_id`.
4. `notion-oauth-worker.js` creates a random `w_...` widget instance id.
5. The Worker patches template embed URLs that contain `WORKLOG_INSTANCE_ID`.
   It also searches accessible Notion pages and patches WorkLog embed URLs that
   contain `WORKLOG_INSTANCE_ID` or have no `w` value yet.
6. Widgets load and save data through `/api/state?w=<instance_id>&scope=<scope>`.

The `w` value is still present in the embed URL, but the user does not type or edit it.

## Cloudflare Worker

Deploy `notion-oauth-worker.js` as the Worker code.

Required KV binding:

- `WORKLOG_KV`

Required environment variables:

- `NOTION_CLIENT_ID`
- `NOTION_CLIENT_SECRET`
- `NOTION_REDIRECT_URI`

Optional environment variables:

- `APP_BASE_URL`: public URL where the HTML widgets are hosted.
- `NOTION_AUTH_URL`: defaults to `https://api.notion.com/v1/oauth/authorize`.

Use this redirect URI in the Notion developer portal:

```text
https://<your-worker-domain>/auth/notion/callback
```

## Template Embed URLs

In the public Notion template, set embed URLs with this placeholder:

```text
https://<your-widget-host>/public-worklog.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-weekly.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-calendar.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-routine.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-memo.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-review.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-history.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-distribution.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/notion-retro-check.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/notion-retro-record.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/notion-retro-history.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/notion-retro-detail-history.html?w=WORKLOG_INSTANCE_ID
```

The Worker will replace `WORKLOG_INSTANCE_ID` after OAuth.
The same `WORKLOG_INSTANCE_ID` can be used across all embeds. WorkLog state is saved under `scope=worklog`; retro mistake state is saved under `scope=retro`.

## Existing Notion Pages

For a page that is not created through the template option, the user must grant
the Notion connection access to that page during OAuth. After OAuth, the Worker
searches accessible pages and updates WorkLog embeds like these:

```text
https://<your-widget-host>/public-worklog.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/public-worklog.html
https://<your-widget-host>/notion-retro-check.html?w=WORKLOG_INSTANCE_ID
https://<your-widget-host>/notion-retro-check.html
```

The Worker does not overwrite embeds that already have a real `w_...` instance
id, so an existing user's connected widgets stay connected to their own data.

## Client Script

Public widget HTML files now load:

```html
<script src="instance-sync.js?v=1"></script>
```

`instance-sync.js` keeps the existing `shared.js` sync interface:

- `initCloudSync`
- `cloudScheduleSave`
- `cloudSaveNow`
- `cloudIsEnabled`

If the URL has no `?w=...`, the widget shows a `Notion 연결하기` prompt instead of the old code input popup.
