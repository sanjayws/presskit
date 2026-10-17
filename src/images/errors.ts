/** Only fixed, actionable messages reach the browser; never provider response text. */
export function imageFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/Anthropic/.test(message)) {
    return "The image instructions could not be prepared. Check the Anthropic key and model access, then Retry. Your existing images are saved.";
  }
  if (/401,|invalid_api_key|not configured/.test(message)) {
    return "OpenAI image authentication failed. Ask your administrator to check OPENAI_API_KEY and its project permissions, then Retry.";
  }
  if (/insufficient_quota|billing_hard_limit_reached/.test(message)) {
    return "OpenAI image billing or quota is unavailable. Ask your administrator to check the API project's billing and limits, then Retry.";
  }
  if (/403,|404,|model_not_found/.test(message)) {
    return "This OpenAI project cannot access the configured image model. Ask your administrator to check model access and organization verification, then Retry.";
  }
  if (/moderation|could not be processed/.test(message)) {
    return "OpenAI could not process this visual brief. Review the article and visual direction before generating a new brief.";
  }
  if (/planning|composition|Anthropic/.test(message)) {
    return "An evidence-backed visual brief could not be prepared. Retry, or Generate New to request a fresh brief.";
  }
  return "The visual could not be created. Your article and any previous image are safe. Retry in a moment.";
}
