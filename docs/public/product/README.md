# GenioOne product documentation

This directory is the source of truth for the Product documentation rendered in the Management Console.

- `en/` contains the English source.
- `zh-TW/` contains the Traditional Chinese source.
- The UI imports these Markdown files directly; do not duplicate their body text in React components.
- The UI indexes each localized title, description, and Markdown body for document search.
- Use fenced `mermaid` blocks for diagrams. The Management Console renders them with Mermaid while Agents can read the original diagram source.
- The current pages are a draft framework. Replace placeholders only with product behavior confirmed by `CONTEXT.md`, an owning ADR, or shipped Product API behavior.

The document slugs and navigation order are defined in
`platform-web/src/features/product-docs/product-documents.ts`.
