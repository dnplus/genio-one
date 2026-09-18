import { isValidElement, type ComponentProps, type ReactNode, useEffect, useMemo, useState } from "react"
import { BookOpenIcon, FileTextIcon, SearchIcon, SearchXIcon, XIcon } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { useTranslation } from "react-i18next"
import remarkGfm from "remark-gfm"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

import {
  isProductDocumentSlug,
  productDocuments,
  type ProductDocumentSlug,
} from "./product-documents"
import { MermaidDiagram } from "./mermaid-diagram"

function MarkdownPre({ children, className, node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const codeBlock = isValidElement<{ children?: ReactNode; className?: string }>(children)
    ? children
    : null

  if (codeBlock?.props.className === "language-mermaid") {
    return <MermaidDiagram chart={String(codeBlock.props.children ?? "").replace(/\n$/, "")} />
  }

  return (
    <pre
      className={cn("my-5 max-w-full overflow-x-auto rounded-lg bg-muted p-4 text-sm", className)}
      {...props}
    >
      {children}
    </pre>
  )
}

function documentFromLocation(): ProductDocumentSlug {
  const requested = new URLSearchParams(window.location.search).get("doc")
  return isProductDocumentSlug(requested) ? requested : "overview"
}

export function ProductDocumentationPage() {
  const { i18n, t } = useTranslation()
  const [activeSlug, setActiveSlug] = useState<ProductDocumentSlug>(documentFromLocation)
  const [searchQuery, setSearchQuery] = useState("")
  const language = i18n.resolvedLanguage === "zh-TW" ? "zh-TW" : "en"
  const activeDocument = useMemo(
    () => productDocuments.find((document) => document.slug === activeSlug) ?? productDocuments[0],
    [activeSlug],
  )
  const visibleDocuments = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase(i18n.resolvedLanguage)
    if (!query) return productDocuments
    return productDocuments.filter((document) =>
      [t(document.title), t(document.description), document.markdown[language]]
        .join("\n")
        .toLocaleLowerCase(i18n.resolvedLanguage)
        .includes(query),
    )
  }, [i18n.resolvedLanguage, language, searchQuery, t])

  useEffect(() => {
    const restoreDocument = () => setActiveSlug(documentFromLocation())
    window.addEventListener("popstate", restoreDocument)
    return () => window.removeEventListener("popstate", restoreDocument)
  }, [])

  function openDocument(slug: ProductDocumentSlug) {
    const url = new URL(window.location.href)
    url.searchParams.set("view", "product-docs")
    url.searchParams.set("doc", slug)
    window.history.pushState({}, "", url)
    setActiveSlug(slug)
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] p-6">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{t("Product documentation")}</h1>
            <p className="mt-1 text-muted-foreground">
              {t("Guides rendered directly from the Markdown source available to people and Agents.")}
            </p>
          </div>
          <Badge variant="secondary">{t("Draft")}</Badge>
        </div>

        <div className="grid min-w-0 gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Card className="min-w-0 self-start" size="sm">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2">
                <BookOpenIcon className="size-4" />
                {t("Documentation")}
              </CardTitle>
              <CardDescription>{t("Choose a guide to open it.")}</CardDescription>
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label={t("Search documentation")}
                  placeholder={t("Search titles and content")}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                {searchQuery ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      aria-label={t("Clear documentation search")}
                      size="icon-xs"
                      onClick={() => setSearchQuery("")}
                    >
                      <XIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            </CardHeader>
            <CardContent>
              {visibleDocuments.length ? (
                <ItemGroup className="gap-1">
                  {visibleDocuments.map((document) => {
                    const selected = document.slug === activeDocument.slug
                    return (
                      <Item
                        key={document.slug}
                        asChild
                        className="cursor-pointer text-left hover:bg-muted"
                        variant={selected ? "muted" : "default"}
                      >
                        <button
                          type="button"
                          aria-current={selected ? "page" : undefined}
                          onClick={() => openDocument(document.slug)}
                        >
                          <ItemMedia variant="icon"><FileTextIcon /></ItemMedia>
                          <ItemContent>
                            <ItemTitle>{t(document.title)}</ItemTitle>
                            <ItemDescription>{t(document.description)}</ItemDescription>
                          </ItemContent>
                        </button>
                      </Item>
                    )
                  })}
                </ItemGroup>
              ) : (
                <Empty className="min-h-40 border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><SearchXIcon /></EmptyMedia>
                    <EmptyTitle>{t("No matching documents")}</EmptyTitle>
                    <EmptyDescription>{t("Try another keyword.")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader className="border-b">
              <CardTitle>{t(activeDocument.title)}</CardTitle>
              <CardDescription>{t(activeDocument.description)}</CardDescription>
            </CardHeader>
            <CardContent className="min-w-0">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ className, ...props }) => <h2 className={cn("mb-4 text-3xl font-semibold tracking-tight", className)} {...props} />,
                  h2: ({ className, ...props }) => <h3 className={cn("mb-3 mt-8 text-2xl font-semibold tracking-tight", className)} {...props} />,
                  h3: ({ className, ...props }) => <h4 className={cn("mb-2 mt-6 text-xl font-semibold", className)} {...props} />,
                  p: ({ className, ...props }) => <p className={cn("my-4 leading-7 text-foreground", className)} {...props} />,
                  ul: ({ className, ...props }) => <ul className={cn("my-4 list-disc space-y-2 pl-6", className)} {...props} />,
                  ol: ({ className, ...props }) => <ol className={cn("my-4 list-decimal space-y-2 pl-6", className)} {...props} />,
                  li: ({ className, ...props }) => <li className={cn("pl-1 leading-7", className)} {...props} />,
                  a: ({ className, ...props }) => <a className={cn("font-medium text-primary underline underline-offset-4", className)} {...props} />,
                  blockquote: ({ children }) => <Alert className="my-5"><AlertDescription>{children}</AlertDescription></Alert>,
                  hr: () => <Separator className="my-8" />,
                  pre: MarkdownPre,
                  code: ({ className, ...props }) => <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)} {...props} />,
                  table: ({ className, ...props }) => <Table className={cn("my-5", className)} {...props} />,
                  thead: (props) => <TableHeader {...props} />,
                  tbody: (props) => <TableBody {...props} />,
                  tr: (props) => <TableRow {...props} />,
                  th: (props) => <TableHead {...props} />,
                  td: (props) => <TableCell className="whitespace-normal" {...props} />,
                }}
              >
                {activeDocument.markdown[language]}
              </ReactMarkdown>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
