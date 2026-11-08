// Regenerates src/ui/lib/productIcons.ts from assets/icons/*.svg (the official files, unmodified), as data URIs, so the console loads no external image.
// tests/ui/contract.test.ts fails when the module and the files differ.
import { readFileSync, writeFileSync } from "node:fs";

const files = { bigquery: "bigquery.svg", cloudrun: "cloud-run.svg", pubsub: "pubsub.svg", appsscript: "apps-script.svg", openai: "OAI_OpenAI-Blossom_Black.svg", openaidark: "OAI_OpenAI-Blossom_White.svg" };
const lines = Object.entries(files).map(([k, f]) => `  ${k}: "data:image/svg+xml;base64,${readFileSync(`assets/icons/${f}`).toString("base64")}",`);
writeFileSync(
  "src/ui/lib/productIcons.ts",
  `/** Official product marks (data: URIs, from assets/icons; regenerate with scripts/embed-icons.mjs). OpenAI ships a black and a white one, and the one that contrasts with the theme is shown. */\nexport const PRODUCT_ICONS: Record<string, string> = {\n${lines.join("\n")}\n};\n`,
);
console.log("wrote src/ui/lib/productIcons.ts");
