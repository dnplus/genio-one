import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })

export const DemoProjectPathSchema = Type.Object({ tenant_id: Identifier })

export const InstallDemoProjectSchema = Type.Object({
  organization_id: Identifier,
}, { additionalProperties: false })

const DemoInstallationSchema = Type.Union([
  Type.Literal("NOT_INSTALLED"),
  Type.Literal("SKIPPED"),
  Type.Literal("INSTALLED"),
])

const DemoItemStateSchema = Type.Union([
  Type.Literal("READY"),
  Type.Literal("NEEDS_CONFIGURATION"),
  Type.Literal("DISABLED"),
  Type.Literal("ERROR"),
])

const DemoItemSchema = Type.Object({
  id: Type.Union([
    Type.Literal("archify"),
    Type.Literal("codex"),
    Type.Literal("context7"),
    Type.Literal("product-management"),
    Type.Literal("gemini"),
  ]),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  state: DemoItemStateSchema,
  detail: Type.String({ minLength: 1, maxLength: 4096 }),
  resource_id: Type.Optional(Identifier),
  connection_id: Type.Optional(Identifier),
  action_url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, { additionalProperties: false })

const DemoPromptSchema = Type.Object({
  id: Type.Union([
    Type.Literal("documents"),
    Type.Literal("spec-and-diagram"),
    Type.Literal("interviews"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  text: Type.String({ minLength: 1, maxLength: 8192 }),
  model_route: Type.Union([
    Type.Literal("codex-subscription"),
    Type.Literal("genio-gateway"),
  ]),
}, { additionalProperties: false })

export const DemoProjectResponseSchema = Type.Object({
  demo_id: Type.Literal("ce-starter"),
  version: Type.Literal("1.0.0"),
  installation: DemoInstallationSchema,
  organization_id: Type.Union([Identifier, Type.Null()]),
  items: Type.Array(DemoItemSchema, { minItems: 5, maxItems: 5 }),
  prompts: Type.Array(DemoPromptSchema, { minItems: 3, maxItems: 3 }),
  package_resource_id: Type.Literal("genio.demo.bot"),
  bot_url: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
}, { additionalProperties: false })

export type DemoInstallationState = Static<typeof DemoInstallationSchema>
export type InstallDemoProjectInput = Static<typeof InstallDemoProjectSchema>
export type DemoProjectResponse = Static<typeof DemoProjectResponseSchema>
