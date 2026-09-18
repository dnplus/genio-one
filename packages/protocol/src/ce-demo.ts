export const CE_DEMO_ID = "ce-starter"
export const CE_DEMO_VERSION = "1.0.0"
export const CE_DEMO_USE_CASE_ID = "ce-demo"
export const CE_DEMO_RESOURCE_IDS = {
  bot: "genio.demo.bot",
  geminiBot: "genio.demo.gemini-bot",
  context7: "genio.demo.context7",
  archify: "genio.demo.archify",
  gemini: "genio.demo.gemini",
} as const

export const CE_DEMO_PROJECT_BRIEF = `This is a fictional CE demonstration project, the Stellar Freight Claims Portal.
Stellar Freight is a regional logistics company. The first release serves shippers who submit freight claims and claims specialists who review them. It must provide claim intake, shipment lookup, document upload, status tracking, and a specialist review queue.
Constraints: deliver within six weeks and support up to 100 concurrent users; no payments, outbound notifications, or production deployment in v1. The frontend uses Next.js, the backend owns claim validation, and PostgreSQL stores shipment and claim records.
Acceptance criteria: a claim cannot be submitted without a valid shipment reference; duplicate claims for the same shipment and incident are rejected; only authorized claim participants can view claim details; uploaded documents are linked to the claim; specialists can change a claim from submitted to under review or resolved.
Interview excerpts: Maya Chen wants to know whether a claim is eligible before entering every detail; Jordan Lee wants a clear review queue with the evidence attached; Priya Nair wants shippers to see the next action without emailing support.`

export const CE_DEMO_PROMPTS = [
  {
    id: "documents",
    title: "Research managed technical docs",
    model_route: "codex-subscription",
    text: `${CE_DEMO_PROJECT_BRIEF}\n\nUse only the managed GenioOne Discovery MCP to access Context7. First call \`search_resources\` with the keyword \"Context7\" to find the correct Resource, then call \`get_resource\` to verify its connection and visible tools. Use the mounted managed Context7 MCP tools to research Next.js App Router forms and server-side validation. Based on the real tool results, explain three implementation notes and include the documentation sources; do documentation research only. If any step is unavailable, explicitly identify the missing Discovery, Resource, connection, or tool configuration step. Do not use Codex Apps, installed plugins, web search, or another unmanaged source as a substitute for completion.`,
  },
  {
    id: "spec-and-diagram",
    title: "Create the product brief",
    model_route: "codex-subscription",
    text: `@product-management:write-spec\n\n${CE_DEMO_PROJECT_BRIEF}\n\nUse the explicitly selected write-spec skill to create a concise v1 product brief. Include the problem statement, target users, three user stories, in-scope requirements, acceptance criteria, and open questions. Keep any verified Context7 sources from the preceding research in the brief. If the skill content is unavailable, stop and identify the missing installation step. Do not write code or use external search.`,
  },
  {
    id: "interviews",
    title: "Summarize stakeholder interviews",
    model_route: "genio-gateway",
    text: `${CE_DEMO_PROJECT_BRIEF}\n\nUse only the supplied material to summarize the three interviews as a table with \"user need\", \"supporting interview evidence\", and \"testable v1 capability\" columns. Preserve unknowns and finish with one question for the next interview round.`,
  },
] as const

export type CeDemoPromptId = typeof CE_DEMO_PROMPTS[number]["id"]
