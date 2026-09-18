---
name: shadcn
description: Add, update, or compose shadcn/ui components; resolve component API, registry, and theme questions.
user-invocable: false
allowed-tools: Bash(npx shadcn@latest *), Bash(pnpm dlx shadcn@latest *), Bash(bunx --bun shadcn@latest *)
---

# shadcn/ui

Use the project's installed component source and `components.json` for its base, aliases, styling, and registries. Component APIs can differ between Radix and Base UI or from newer upstream versions.

## Choose the relevant reference

Read only the guidance involved in the current change:

| Task | Reference |
| --- | --- |
| Form structure and validation | [Forms](rules/forms.md) |
| Overlays, grouping, feedback, and composition | [Composition](rules/composition.md) |
| Styling and semantic tokens | [Styling](rules/styling.md) |
| Icons within components | [Icons](rules/icons.md) |
| Radix versus Base UI APIs | [Base differences](rules/base-vs-radix.md) |
| Chat primitives and scroll behavior | [Chat](rules/chat.md) |
| CLI commands, preview, and preset options | [CLI](cli.md) |
| Registry authoring or registry dependencies | [Registry](registry.md) |
| Theme customization and extending components | [Customization](customization.md) |

Keep accessibility contracts such as overlay titles, control labels, and focus behavior. Apply component-specific examples to the installed base and version rather than refactoring unrelated markup to match an example.

## Resolve components and APIs

Reuse installed components and variants first. Inspect the affected implementation and callers for a routine edit. When configuration is unclear, use `shadcn@latest info --json`; run `shadcn@latest docs <component>` and read the returned documentation when adding a primitive or resolving uncertain APIs. Documentation does not imply permission to replace the installed version.

Use the project's package runner for CLI commands: `pnpm dlx`, `bunx --bun`, or `npx`. GenioOne Platform uses `bunx --bun shadcn@latest` from `apps/platform` for these commands.

Follow a specified registry. Otherwise use configured registries, or the standard shadcn registry for standard primitives. A registry choice requires user input only when unresolved licensing, trust, cost, or product requirements materially affect the requested work.

## Additions and upstream changes

Before adding or updating, inspect `view`, `add --dry-run`, or `add --diff` as appropriate. Add missing components only. After an addition, check its imports against the project aliases, component composition, and icon library.

Preserve local edits when merging upstream changes. An overwrite needs authorization covering those edits; do not ask again when the user's existing request already clearly authorizes that exact replacement. Resolve uncertainty about the affected local changes before applying an overwrite.

For a requested preset switch, inspect the current and incoming presets, select the scope that matches the request, and preview the affected files. Keep unrelated components and theme changes outside the task. Consult [CLI](cli.md) for the supported preset operations.

Complete the requested UI behavior and verify the affected interactions and states. Report any unresolved incompatibility rather than silently substituting a custom implementation.
