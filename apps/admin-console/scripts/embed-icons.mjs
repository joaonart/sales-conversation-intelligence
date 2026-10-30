// Embeds assets/icons/*.svg as data URIs into src/client/app.js (between the // <icons> markers), so the console loads no external image.
import { readFileSync, writeFileSync } from "node:fs";

const files = { bigquery: "bigquery.svg", cloudrun: "cloud-run.svg", pubsub: "pubsub.svg", appsscript: "apps-script.svg" };
const lines = Object.entries(files).map(([k, f]) => `    ${k}: "data:image/svg+xml;base64,${readFileSync(`assets/icons/${f}`).toString("base64")}"`);
const block = `// <icons>\n  var PRODUCT_ICONS = {\n${lines.join(",\n")}\n  };\n  // </icons>`;
const p = "src/client/app.js";
const src = readFileSync(p, "utf8");
if (!/\/\/ <icons>[^]*\/\/ <\/icons>/.test(src)) throw new Error("markers missing in app.js");
writeFileSync(p, src.replace(/\/\/ <icons>[^]*\/\/ <\/icons>/, block));
