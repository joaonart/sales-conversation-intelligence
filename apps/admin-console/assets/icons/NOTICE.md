# Product icons

Official product icons, used unmodified (not recoloured, cropped or redrawn) only to identify the product in the architecture diagram of "Como funciona". The trademarks belong to their owners; their use here does not imply endorsement.

| File | Product | Source |
|---|---|---|
| `bigquery.svg` | BigQuery | Google Cloud core product icons, https://cloud.google.com/icons (`core-products-icons.zip`) |
| `cloud-run.svg` | Cloud Run | Google Cloud core product icons, https://cloud.google.com/icons (`core-products-icons.zip`) |
| `pubsub.svg` | Pub/Sub | Google Cloud legacy icon set, https://cloud.google.com/icons (`google-cloud-legacy-icons.zip`) |
| `apps-script.svg` | Apps Script | Google product logo, https://fonts.gstatic.com/s/i/productlogos/apps_script/v8/192px.svg |

Downloaded 2026-10-30. OpenAI is not included: its brand page refused automated download, so that component uses a generic icon until the logo is supplied from https://openai.com/brand.

`scripts/embed-icons.mjs` embeds these files as data URIs between the `// <icons>` markers in `src/client/app.js` (the console loads no external image).
