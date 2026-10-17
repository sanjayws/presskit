/**
 * Voice profiles (data rows, not prompt magic) and the word cap.
 * ms-en (Malaysian English) is the default. New locales are new entries.
 */

export interface VoiceProfile {
  key: string;
  label: string;
  /** Instruction handed to the model at generation time. */
  instruction: string;
}

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  "ms-en": {
    key: "ms-en",
    label: "Malaysian English",
    instruction:
      "Malaysian English. Clear, professional, locally natural. Avoid Americanisms. Plain sentences, no filler.",
  },
  "en-gb": {
    key: "en-gb",
    label: "British English",
    instruction: "British English spelling and idiom. Measured, professional tone.",
  },
  "en-us": {
    key: "en-us",
    label: "US English",
    instruction: "US English spelling and idiom. Direct, professional tone.",
  },
};

export function voiceInstruction(profileKey: string): string {
  return (VOICE_PROFILES[profileKey] ?? VOICE_PROFILES["ms-en"]!).instruction;
}

// --- Generation gears (data-driven options; instructions composed in code) ---

export interface Option {
  value: string;
  label: string;
  instruction: string;
}

/** "Write as" personas. */
export const PERSONAS: Option[] = [
  { value: "professional", label: "Professional", instruction: "Write as a seasoned professional: clear, credible, no fluff." },
  { value: "ceo", label: "CEO", instruction: "Write as a company CEO: strategic, confident, big-picture, speaks to outcomes and vision." },
  { value: "founder", label: "Founder", instruction: "Founder-style voice: candid, mission-driven and practical. Do not invent first-hand experiences or claim to be the founder." },
  { value: "finance", label: "Finance Lead", instruction: "Write as a finance leader: precise, ROI and cost focused, data-led, risk-aware." },
  { value: "technical", label: "Technical Expert", instruction: "Write as a technical expert: accurate, specific, explains how things actually work." },
  { value: "sales", label: "Sales Head", instruction: "Write as a sales head: benefit-led, persuasive, focused on the customer outcome." },
  { value: "marketer", label: "Marketer", instruction: "Write as a marketer: punchy, brand-aware, benefit-driven, strong hooks." },
  { value: "blogger", label: "Professional Blogger", instruction: "Write as a professional blogger: engaging, scannable, personable, second person." },
  { value: "guest", label: "Guest Writer", instruction: "Write as an invited guest writer: fresh outside perspective, credible, generous with insight." },
  { value: "journalist", label: "Journalist", instruction: "Write as a journalist: factual, balanced, inverted-pyramid, attributes claims." },
  { value: "educator", label: "Educator", instruction: "Write as an educator: clear, step-by-step, teaches the reader a concept." },
  { value: "consultant", label: "Consultant", instruction: "Write as a consultant: advisory, framework-driven, concrete and actionable." },
  { value: "storyteller", label: "Storyteller", instruction: "Write as a storyteller: narrative-led, vivid, human, with a throughline." },
  { value: "artist", label: "Artist", instruction: "Write as an artist: expressive, evocative, unconventional phrasing." },
  { value: "thought", label: "Thought Leader", instruction: "Write as a thought leader: forward-looking, opinionated, insight-rich." },
];

/** Tone of voice. */
export const TONES: Option[] = [
  { value: "professional", label: "Professional", instruction: "Tone: professional and polished." },
  { value: "conversational", label: "Conversational", instruction: "Tone: conversational and approachable." },
  { value: "authoritative", label: "Authoritative", instruction: "Tone: authoritative and definitive." },
  { value: "friendly", label: "Friendly", instruction: "Tone: warm and friendly." },
  { value: "persuasive", label: "Persuasive", instruction: "Tone: persuasive and compelling." },
  { value: "inspirational", label: "Inspirational", instruction: "Tone: inspirational and uplifting." },
  { value: "witty", label: "Witty", instruction: "Tone: witty and lightly humorous, still credible." },
  { value: "formal", label: "Formal", instruction: "Tone: formal and precise." },
  { value: "bold", label: "Bold", instruction: "Tone: bold and direct." },
  { value: "empathetic", label: "Empathetic", instruction: "Tone: empathetic and reassuring." },
];

/** Stored creativity presets used as writing instructions. */
export const TEMPERATURE_PRESETS: Option[] = [
  { value: "0.3", label: "Focused (consistent)", instruction: "" },
  { value: "0.6", label: "Balanced", instruction: "" },
  { value: "0.9", label: "Creative", instruction: "" },
  { value: "1.2", label: "Experimental (dynamic)", instruction: "" },
];

/** Featured-image style / brightness variations. */
export const IMAGE_STYLES: Option[] = [
  { value: "editorial", label: "Bold editorial (recommended)", instruction: "A distinctive editorial concept with confident colour, dramatic scale and intentional composition. Choose illustration, collage or a dimensional scene to suit the story. One memorable focal idea, minimal text, no generic icon grid." },
  { value: "photographic", label: "Premium photographic", instruction: "Art-directed editorial photography: believable materials, purposeful framing, expressive light and texture, one striking subject. Prefer no visible text. Illustrative scenes must not impersonate real customers or documented events." },
  { value: "dimensional", label: "Sculptural / dimensional", instruction: "A tactile sculptural still life or dimensional illustration. Strong material contrast, directional studio light, intentional shadows and one memorable subject-specific metaphor." },
  { value: "diagram", label: "Explanatory diagram", instruction: "A precise explanatory diagram or infographic with useful relationships, purposeful labels and a strong hierarchy. Use an evidence-backed process or comparison when appropriate; no decorative icon rows." },
  { value: "bright", label: "Bright & vivid", instruction: "Bright, vivid, high-saturation, light background." },
  { value: "soft", label: "Soft & muted", instruction: "Soft, muted, low-saturation pastel palette, airy." },
  { value: "bold", label: "Bold high-contrast", instruction: "Bold, high-contrast, saturated accents on a clean background." },
  { value: "minimal", label: "Minimal & clean", instruction: "Minimalist, lots of whitespace, few elements, restrained palette." },
  { value: "dark", label: "Dark & moody", instruction: "Dark mode: deep background, luminous accent colours, high contrast." },
  { value: "gradient", label: "Modern gradient", instruction: "Expressive colour gradients and dimensional depth supporting a clear focal subject; no generic floating UI cards." },
];

/**
 * Preset call-to-action blocks. The selected CTA is inserted into the article
 * body as a distinct blockquote (deterministic, in code — never a prompt). The
 * `action` becomes the link text when a reference link is available to point at.
 */
export interface CtaOption {
  value: string;
  label: string;
  heading: string;
  body: string;
  action: string;
}
export const CTAS: CtaOption[] = [
  { value: "", label: "None", heading: "", body: "", action: "" },
  { value: "demo", label: "Book a demo", heading: "See it in action", body: "Request a demo to explore how this could work for your team.", action: "Book a demo" },
  { value: "contact", label: "Contact us", heading: "Have questions?", body: "Get in touch with our team to talk through how this fits your business.", action: "Contact us" },
  { value: "quote", label: "Get a quote", heading: "Want pricing?", body: "Request a quote and review the pricing and terms for your requirements.", action: "Get a quote" },
  { value: "trial", label: "View trial details", heading: "Explore the trial", body: "Review the trial details, availability and terms before getting started.", action: "View trial details" },
  { value: "consult", label: "Request a consultation", heading: "Not sure where to start?", body: "Request a consultation to discuss your requirements and available options.", action: "Request a consultation" },
  { value: "learn", label: "Learn more", heading: "Go deeper", body: "Explore the details and see how it all comes together.", action: "Learn more" },
  { value: "subscribe", label: "Subscribe", heading: "Stay in the loop", body: "Subscribe to get practical insights like this delivered straight to your inbox.", action: "Subscribe" },
];

/** Resolve a CTA preset by value; null if none/blank. */
export function ctaByValue(value: string): CtaOption | null {
  if (!value) return null;
  return CTAS.find((c) => c.value === value && c.value !== "") ?? null;
}

/**
 * How the CTA button links out. Each action turns the owner-entered target into
 * the right URI scheme (`buildCtaHref`). Purely for the dropdown + href build.
 */
export const CTA_ACTIONS: Option[] = [
  { value: "", label: "No link (text only)", instruction: "" },
  { value: "website", label: "Open a website", instruction: "Enter the full URL, e.g. https://yoursite.com/contact" },
  { value: "email", label: "Send an email", instruction: "Enter the email address, e.g. sales@yoursite.com" },
  { value: "whatsapp", label: "WhatsApp", instruction: "Enter the number in international format, e.g. 60123456789" },
  { value: "call", label: "Call (phone)", instruction: "Enter the phone number, e.g. +60312345678" },
];

/**
 * Editorial bias dial (1..5). Value is the numeric level as a string so it drops
 * straight into the existing <select> helper; the mapping to prose lives in the
 * article writer (biasInstruction). 3 is the neutral-ish default.
 */
export const BIAS_LEVELS: Option[] = [
  { value: "1", label: "1 - Neutral & honest", instruction: "Objective; reports reality including downsides." },
  { value: "2", label: "2 - Mostly neutral", instruction: "Factual, lightly favourable where warranted." },
  { value: "3", label: "3 - Balanced (default)", instruction: "Fair and constructive, positive where warranted." },
  { value: "4", label: "4 - Persuasive", instruction: "Leads with supported benefits; material limitations remain clear." },
  { value: "5", label: "5 - Strongly promotional", instruction: "Champions the source; grounded, never fabricated." },
];

// --- Article types -----------------------------------------------------------
// The kind of piece this campaign produces. Orients BOTH stages: topic research
// (what the SEO sweep looks for and brings back — e.g. a comparison researches
// the competing options and comparative data) and the writer (structure and
// framing). Editorial stance changes emphasis; comparison verdicts and ranking
// remain evidence-led at every stance.

export interface ArticleTypeOption extends Option {
  /** Topic-research guidance injected into the SEO research prompt. */
  research: string;
  /** Writer guidance injected into every article prompt (via the gears block). */
  writing: string;
}

export const ARTICLE_TYPES: ArticleTypeOption[] = [
  {
    value: "article",
    label: "Standard article",
    instruction: "Informational, evergreen article that fully covers the topic.",
    research: "",
    writing: "",
  },
  {
    value: "comparison",
    label: "Comparison / Best-of",
    instruction: "Compares real options ('Best X in Y', 'X vs Y') and ends with a verdict.",
    research:
      "Article type: COMPARISON. Research comparison queries ('best X in Y', 'X vs Y', 'top X alternatives') to understand reader intent. Identify real competing options and supported criteria (features, pricing, support, fit). Publish a best-of or ranked title only with comparative evidence. When competitor evidence is absent, propose a supported criteria comparison, not invented competitors or a predetermined winner.",
    writing:
      "Article type: comparison piece. Compare the real options side by side on concrete criteria (features, pricing, support, fit) and end with a clear verdict. Use a <table> for the head-to-head where it helps. The editorial stance controls tone and emphasis only. The grounded product may lead the comparison for context, but the verdict must follow the evidence; never declare it the winner in advance. Compare only criteria supported for every contender and clearly identify missing evidence. Never invent competitor facts, prices or ratings.",
  },
  {
    value: "listicle",
    label: "Listicle (Top N)",
    instruction: "A numbered list of distinct items, each briefly explained.",
    research:
      "Article type: LISTICLE. Research list-style queries ('top 10 X', 'N best X', 'N ways to X'). Each angle should be a countable list topic with enough genuinely distinct items to fill it.",
    writing:
      "Article type: listicle. Structure the body as a numbered list of distinct items, each under its own heading with a short, concrete explanation. Order the items by relevance to the reader and evidence, not the editorial stance. Do not label an item best or top-ranked without comparative support.",
  },
  {
    value: "howto",
    label: "How-to guide",
    instruction: "Step-by-step tutorial that teaches the reader one task.",
    research:
      "Article type: HOW-TO GUIDE. Research instructional queries ('how to X', 'X step by step', 'X setup guide'). Angles must be concrete tasks the reader wants to accomplish.",
    writing:
      "Article type: how-to guide. Teach one task step by step: prerequisites first, then numbered steps in order, each actionable and concrete, closing with a short troubleshooting or next-steps section.",
  },
  {
    value: "news",
    label: "News style",
    instruction: "Timely, inverted-pyramid reporting on what is new.",
    research:
      "Article type: NEWS. Research announcements, launches, changes and recent developments. Propose news angles only where the supplied sources establish a dated event. Never invent an announcement or re-label older evidence as current news.",
    writing:
      "Article type: news style. Inverted pyramid: lead with the most newsworthy fact (what happened, who, when), then supporting detail, then background. Short paragraphs, attribute claims to their sources, no editorialising beyond the editorial stance below.",
  },
  {
    value: "blog",
    label: "Blog post",
    instruction: "Personable, conversational post written to the reader.",
    research:
      "Article type: BLOG POST. Research the questions and pain points real people discuss around the idea. Angles should suit a personable, useful post, not a formal report or invented first-hand story.",
    writing:
      "Article type: blog post. Personable and direct: write to the reader ('you'), use short paragraphs and a conversational flow. Use first-hand experiences only when explicitly supplied in the source material. Still grounded and useful, never rambling.",
  },
  {
    value: "opinion",
    label: "Opinion piece",
    instruction: "Takes one clear position and argues it with evidence.",
    research:
      "Article type: OPINION PIECE. Research the debates, controversies and open questions around the idea where a clear position can be taken and defended with grounded evidence.",
    writing:
      "Article type: opinion piece. Take one clear position early, argue it with grounded evidence, acknowledge the strongest counterargument, and close by restating the position. The stance argued follows the editorial stance below.",
  },
  {
    value: "review",
    label: "Review",
    instruction: "Evaluates the subject against criteria and gives a verdict.",
    research:
      "Article type: REVIEW. Research evaluation queries ('X review', 'is X worth it', 'X pros and cons') and the criteria buyers actually judge X on.",
    writing:
      "Article type: review. Assess the subject against concrete criteria with specifics from the sources. Cover supported strengths and material limitations regardless of editorial stance, then end with an evidence-based verdict and who it is for. Do not imply hands-on testing unless it was actually supplied in the evidence.",
  },
];

const ARTICLE_TYPE_MAP = new Map(ARTICLE_TYPES.map((t) => [t.value, t]));

export function isArticleType(v: string): boolean {
  return ARTICLE_TYPE_MAP.has(v);
}

/** Resolve an article type by value; unknown/blank falls back to the standard article. */
export function articleTypeByValue(v: string): ArticleTypeOption {
  return ARTICLE_TYPE_MAP.get(v) ?? ARTICLE_TYPES[0]!;
}

// --- Output-format gate ------------------------------------------------------
// The target platform the article is written and rendered for. Picked at topic
// selection (the gate). Drives BOTH how it is written (social = short, no tables)
// and how the sanitized HTML is finally serialized (html/markdown/plain/word).

export type OutputFormat = "html" | "social" | "linkedin" | "email" | "chat" | "plain" | "markdown" | "word";

export const OUTPUT_FORMATS: Option[] = [
  { value: "html", label: "WordPress / Rich HTML", instruction: "Full HTML: headings, lists, tables, links. Paste into a CMS or HTML editor." },
  { value: "linkedin", label: "LinkedIn post", instruction: "Short paragraphs, selective bold highlighting, one useful takeaway." },
  { value: "email", label: "Email EDM", instruction: "Subject, preview text and a focused email with one call to action." },
  { value: "chat", label: "WhatsApp / Chat EDM", instruction: "A short personal message, WhatsApp emphasis and one clear next step." },
  { value: "social", label: "Facebook / plain social post", instruction: "Short plain-text post with optional hashtags." },
  { value: "plain", label: "Plain text", instruction: "No markup. Headings become plain lines. Paste anywhere." },
  { value: "markdown", label: "Markdown", instruction: "Markdown syntax: # headings, **bold**, lists, tables, [links]()." },
  { value: "word", label: "Word document (.doc)", instruction: "Rich formatting that opens in Microsoft Word with headings and tables intact." },
];

const OUTPUT_FORMAT_VALUES = new Set(OUTPUT_FORMATS.map((o) => o.value));

export function isOutputFormat(v: string): v is OutputFormat {
  return OUTPUT_FORMAT_VALUES.has(v);
}

/** A social post is short by design; cap it hard so the short-article path runs. */
export const SOCIAL_MAX_WORDS = 220;

export interface ChannelProfile {
  maxWords: number;
  maxCharacters?: number;
  imageSize: "1536x1024" | "1024x1024";
  imageDescription: string;
  summary: string;
  writing: string;
}

const ARTICLE_CHANNEL: ChannelProfile = {
  maxWords: 2000, imageSize: "1536x1024",
  imageDescription: "Landscape editorial image, 1536 × 1024 PNG",
  summary: "Your chosen word limit · headings, lists and links · landscape PNG",
  writing: "Write a complete article at the requested length. Use the owner's requested headings and order. Make each section answer a real reader question with source-supported specifics.",
};
export const CHANNEL_PROFILES: Record<OutputFormat, ChannelProfile> = {
  html: ARTICLE_CHANNEL, word: ARTICLE_CHANNEL, markdown: ARTICLE_CHANNEL, plain: ARTICLE_CHANNEL,
  social: {
    maxWords: 220, imageSize: "1024x1024", imageDescription: "Square feed visual, 1024 × 1024 PNG",
    summary: "Up to 220 words · plain text · square PNG",
    writing: "Output target: a Facebook or plain social post. Start with a useful hook and write 1 to 3 tight paragraphs. No headings or tables. Use at most 3 relevant hashtags, only when useful. One next step at most.",
  },
  linkedin: {
    maxWords: 220, maxCharacters: 3000, imageSize: "1024x1024", imageDescription: "Square LinkedIn feed visual, 1024 × 1024 PNG",
    summary: "Up to 220 words / 3,000 characters · short paragraphs and bold highlights · square PNG",
    writing: "Output target: a LinkedIn feed post, not a LinkedIn article. Lead with a specific professional insight, use short paragraphs and one useful takeaway. Use <strong> for at most two short highlights; all other text is plain. No headings, tables, Markdown markers or decorative Unicode lettering. Use visible URLs for links. At most one next step and 0 to 3 relevant hashtags. Stay within 3,000 characters including URLs and hashtags.",
  },
  email: {
    maxWords: 350, imageSize: "1536x1024", imageDescription: "Landscape email illustration, 1536 × 1024 PNG; display up to 600 px wide",
    summary: "Up to 350 words · subject ≤60 characters · preview ≤100 · 600 px email layout",
    writing: "Output target: Email EDM. The title field is the email subject (at most 60 characters); excerpt is the preview/preheader (at most 100 characters), adding context instead of repeating the subject. Write a concise, personal email around one message and one next step. Use short paragraphs, optional short bold headings and simple bullets, no data tables, hashtags, keyword stuffing, invented urgency or unsupported offers. Keep critical information in live text, not only in an image. Metadata is for storage; do not optimise the email for SEO. Never invent recipient names, sender details or unsubscribe links. The sending platform supplies its footer and unsubscribe mechanism.",
  },
  chat: {
    maxWords: 120, maxCharacters: 1000, imageSize: "1024x1024", imageDescription: "Simple square message visual, 1024 × 1024 PNG",
    summary: "Up to 120 words / 1,000 characters · WhatsApp bold / italic · one CTA · square PNG",
    writing: "Output target: one WhatsApp / Chat EDM message, not a blog post or email. Start with the relevant benefit or update, then 2 to 4 short paragraphs or bullets and one clear next step. At most 120 words and 1,000 characters including URLs. Use <strong> and <em> sparingly; the exporter converts these to WhatsApp *bold* and _italic_. No headings, tables, email subject lines, hashtags, decorative Unicode or SEO phrasing. Never invent recipient names, opt-in status or offers. The title is an internal label and the excerpt is an internal summary. If a CTA is configured it is appended separately; do not add a competing CTA.",
  },
};

export function channelProfile(format: string | undefined): ChannelProfile {
  return isOutputFormat(format || "") ? CHANNEL_PROFILES[format as OutputFormat] : ARTICLE_CHANNEL;
}
export function isCampaignChannel(format: string | undefined): boolean {
  return format === "social" || format === "linkedin" || format === "email" || format === "chat";
}

/**
 * Extra writer guidance for a target platform, injected into every prompt. Only
 * the social format changes how the text is WRITTEN (short, no tables/headings);
 * the other formats write the same rich article and differ only at render time.
 */
export function formatWriterGuidance(format: OutputFormat): string {
  return `${CHANNEL_PROFILES[format].writing} Channel rules control presentation when an article-type preset conflicts. Preserve the brief's substantive points and their order within the channel's length. If they cannot all fit, flag the conflict in review instead of silently dropping them.`;
}

/**
 * Build the CTA anchor href from the action + owner-entered target. Returns null
 * when there is no usable link (unknown action, blank/invalid target). Kept here
 * so the URI schemes live next to the CTA presets.
 */
export function buildCtaHref(action: string, target: string): string | null {
  const t = (target || "").trim();
  if (!t) return null;
  switch (action) {
    case "website": {
      const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
      try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
      } catch {
        return null;
      }
    }
    case "email": {
      // Minimal shape check; the sanitizer also re-validates mailto: later.
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? `mailto:${t}` : null;
    }
    case "whatsapp": {
      const digits = t.replace(/[^\d]/g, ""); // wa.me wants digits only, no +
      return digits.length >= 6 ? `https://wa.me/${digits}` : null;
    }
    case "call": {
      const num = t.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, ""); // keep a leading +
      return num.replace(/\D/g, "").length >= 6 ? `tel:${num}` : null;
    }
    default:
      return null;
  }
}

/** Resolve an option's instruction by value; empty string if not found/blank. */
export function optionInstruction(list: Option[], value: string): string {
  if (!value) return "";
  return list.find((o) => o.value === value)?.instruction ?? "";
}

/** Clamp the legacy creativity value into the supported UI range. */
export function clampTemperature(t: number): number {
  if (!Number.isFinite(t)) return 0.6;
  return Math.max(0, Math.min(2, t));
}

/** Count words in an HTML fragment (text content only, SVG excluded). */
export function countWords(html: string): number {
  const noSvg = html.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const text = noSvg
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

/**
 * Enforce the word cap by dropping trailing <p> blocks. Never pads. Preserves
 * headings and, critically, the inline <svg> infographic.
 */
export function trimToWordCap(bodyHtml: string, maxWords: number): string {
  if (countWords(bodyHtml) <= maxWords) return bodyHtml;

  // Split into top-level-ish blocks while keeping delimiters.
  const blockRe = /<(p|ul|ol|blockquote)\b[\s\S]*?<\/\1>/gi;
  const blocks: { text: string; start: number; end: number; droppable: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(bodyHtml)) !== null) {
    const text = m[0];
    blocks.push({
      text,
      start: m.index,
      end: m.index + text.length,
      droppable: !/<svg[\s>]/i.test(text), // never drop the infographic
    });
  }

  let result = bodyHtml;
  // Drop droppable blocks from the end until under cap or none left.
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (countWords(result) <= maxWords) break;
    const b = blocks[i]!;
    if (!b.droppable) continue;
    result = result.slice(0, b.start) + result.slice(b.end);
    // Recompute offsets are stale after slice; rebuild by re-scanning is costly.
    // Since we only ever cut from the tail forward-to-back, earlier offsets stay valid.
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
