import { isValidElement, type ComponentProps, type ReactNode, useId, useState } from "react"
import { Check, Copy } from "lucide-react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"

import { BloubAvatar } from "./avatar/bloub-avatar"
import { splitMentionSegments, type MentionItem } from "./components/chat/composer-mentions"
import { botCopy } from "./lib/ui-copy"

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children)
  return ""
}

function MessageCodeBlock({ children, node: _node }: ComponentProps<"pre"> & { node?: unknown }) {
  const [copied, setCopied] = useState(false)
  const codeBlock = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children : null
  const code = textFromNode(codeBlock?.props.children ?? children)
  const language = codeBlock?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? ""

  const handleCopy = () => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="message-code-block">
      <div className="code-block-header">
        <span>{language || "code"}</span>
        <button type="button" onClick={handleCopy}>
          {copied ? <Check style={{ width: 12, height: 12 }} /> : <Copy style={{ width: 12, height: 12 }} />}
          <span>{copied ? botCopy("Copied", "已複製") : botCopy("Copy", "複製")}</span>
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}

function MessageBotMention({ item }: { item: MentionItem }) {
  return (
    <span className="composer-mention composer-mention--bot message-mention">
      {item.avatar ? (
        <span className="composer-mention-avatar">
          <BloubAvatar value={item.avatar} label={item.name} animated={false} />
        </span>
      ) : null}
      <span className="composer-mention-name">{item.name}</span>
    </span>
  )
}

type MarkdownNode = {
  type?: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

function botMentionPlugin(mentions: MentionItem[] | undefined, mentionKey: string, mentionLinks: Map<string, MentionItem>) {
  return () => (tree: unknown) => {
    if (!mentions?.length) return
    let nextMention = 0

    const replaceText = (value: string): MarkdownNode[] => {
      if (!value.includes("@")) return [{ type: "text", value }]
      const segments = splitMentionSegments(value, mentions)
      if (!segments.some((segment) => segment.type === "mention" && segment.item.kind === "bot")) {
        return [{ type: "text", value }]
      }
      return segments.map((segment) => {
        if (segment.type !== "mention" || segment.item.kind !== "bot") {
          return { type: "text", value: segment.type === "text" ? segment.value : segment.token }
        }
        const href = `https://genio.invalid/mentions/${encodeURIComponent(mentionKey)}/${nextMention++}`
        mentionLinks.set(href, segment.item)
        return { type: "link", url: href, children: [{ type: "text", value: segment.token }] }
      })
    }

    const visit = (node: MarkdownNode) => {
      if (node.type === "link" || node.type === "linkReference" || node.type === "definition" || !node.children) return
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && typeof child.value === "string") return replaceText(child.value)
        visit(child)
        return [child]
      })
    }

    visit(tree as MarkdownNode)
  }
}

export function FormattedMessage({ text, mentions }: { text: string; mentions?: MentionItem[] }) {
  const mentionKey = useId()
  const mentionLinks = new Map<string, MentionItem>()

  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, botMentionPlugin(mentions, mentionKey, mentionLinks)]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          pre: MessageCodeBlock,
          table: ({ node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) => (
            <div className="message-table-wrap"><table {...props} /></div>
          ),
          a: ({ children, href, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => {
            const mention = mentionLinks.get(href ?? "")
            if (mention) return <MessageBotMention item={mention} />
            if (!href) return <>{children}</>
            return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
