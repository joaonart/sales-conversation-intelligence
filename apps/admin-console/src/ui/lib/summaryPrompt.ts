/** Suggested text for the general evaluation. Plain instructions: the platform puts its own fixed rules in front of it. */
export const DEFAULT_SUMMARY_PROMPT = [
  "Faça a avaliação geral desta conversa de vendas para a equipe de qualidade.",
  "- Comece com um resumo curto (2 a 3 frases) do que aconteceu e do resultado.",
  "- Pontos positivos: o que o vendedor fez bem, apoiado nos critérios que pontuaram e nas mensagens.",
  "- Pontos negativos: o que prejudicou o resultado ou ficou abaixo do esperado.",
  "- Oportunidades: o que poderia ter sido feito para vender mais ou melhor (por exemplo, upsell, cross-sell, tratamento de objeção, próximo passo), mesmo que o critério não pese na nota.",
  "Seja específico e objetivo, cite as mensagens que sustentam cada ponto e não repita a nota.",
].join("\n");
