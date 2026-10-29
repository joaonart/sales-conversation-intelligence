/** Port of sci_core.context.mask_pii. Conformance cases live in fixtures/admin_conformance.json and run on both sides.
 *  Pattern-based: personal names and free-text identifiers are NOT masked. */
const PII: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[CPF]"],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[CNPJ]"],
  [/(?<!\w)(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9?\d{4}[-\s]?\d{4}(?!\w)/g, "[PHONE]"],
];

export function maskPii(text: string): string {
  return PII.reduce((acc, [pattern, token]) => acc.replace(pattern, token), text);
}
