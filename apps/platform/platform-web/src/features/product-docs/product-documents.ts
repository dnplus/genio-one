import coreConceptsEn from "../../../../../../docs/public/product/en/core-concepts.md?raw"
import initialSetupEn from "../../../../../../docs/public/product/en/initial-setup.md?raw"
import operationsEn from "../../../../../../docs/public/product/en/operations.md?raw"
import overviewEn from "../../../../../../docs/public/product/en/overview.md?raw"
import coreConceptsZhTw from "../../../../../../docs/public/product/zh-TW/core-concepts.md?raw"
import initialSetupZhTw from "../../../../../../docs/public/product/zh-TW/initial-setup.md?raw"
import operationsZhTw from "../../../../../../docs/public/product/zh-TW/operations.md?raw"
import overviewZhTw from "../../../../../../docs/public/product/zh-TW/overview.md?raw"

export type ProductDocumentSlug = "overview" | "initial-setup" | "core-concepts" | "operations"

export interface ProductDocument {
  slug: ProductDocumentSlug
  title: string
  description: string
  markdown: Record<"en" | "zh-TW", string>
}

export const productDocuments: ProductDocument[] = [
  {
    slug: "overview",
    title: "Product concept",
    description: "Value, product boundaries, domain model, and architecture",
    markdown: { en: overviewEn, "zh-TW": overviewZhTw },
  },
  {
    slug: "initial-setup",
    title: "Initial setup",
    description: "Bring a Tenant to its first governed request",
    markdown: { en: initialSetupEn, "zh-TW": initialSetupZhTw },
  },
  {
    slug: "core-concepts",
    title: "Core concepts",
    description: "Authorization model and product vocabulary",
    markdown: { en: coreConceptsEn, "zh-TW": coreConceptsZhTw },
  },
  {
    slug: "operations",
    title: "Operations guide",
    description: "Daily review and evidence workflows",
    markdown: { en: operationsEn, "zh-TW": operationsZhTw },
  },
]

export function isProductDocumentSlug(value: string | null): value is ProductDocumentSlug {
  return productDocuments.some((document) => document.slug === value)
}
