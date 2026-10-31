# Product icons

Official product icons, used unmodified (not recoloured, cropped or redrawn) only to identify the product in the architecture diagram of "Como funciona". The trademarks belong to their owners; their use here does not imply endorsement.

| File | Product | Source |
|---|---|---|
| `bigquery.svg` | BigQuery | Google Cloud core product icons, https://cloud.google.com/icons (`core-products-icons.zip`) |
| `cloud-run.svg` | Cloud Run | Google Cloud core product icons, https://cloud.google.com/icons (`core-products-icons.zip`) |
| `pubsub.svg` | Pub/Sub | Google Cloud legacy icon set, https://cloud.google.com/icons (`google-cloud-legacy-icons.zip`) |
| `OAI_OpenAI-Blossom_Black.svg` | OpenAI (for light themes) | OpenAI brand assets, https://openai.com/brand, supplied by the project owner |
| `OAI_OpenAI-Blossom_White.svg` | OpenAI (for dark themes) | OpenAI brand assets, https://openai.com/brand, supplied by the project owner |
| `apps-script.svg` | Apps Script | Google product logo, https://fonts.gstatic.com/s/i/productlogos/apps_script/v8/192px.svg |

Downloaded 2026-10-30. The OpenAI mark was added on 2026-10-31 in its two official colours; the console shows the one that contrasts with the theme. Follow OpenAI's brand guidelines for any other use.

`scripts/embed-icons.mjs` embeds these files as data URIs between the `// <icons>` markers in `src/client/app.js` (the console loads no external image).
