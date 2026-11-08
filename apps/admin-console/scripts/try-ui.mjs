// Builds the new client into dist-ui/ (app.js, app.css) for the preview, without touching the deployed bundle.
import { mkdirSync, writeFileSync } from "node:fs";
import { buildUi } from "./build-ui.mjs";

const { js, css } = await buildUi({ minify: true });
mkdirSync("dist-ui", { recursive: true });
writeFileSync("dist-ui/app.js", js);
writeFileSync("dist-ui/app.css", css);
console.log(`app.js ${(js.length / 1024).toFixed(0)}K  app.css ${(css.length / 1024).toFixed(0)}K`);
