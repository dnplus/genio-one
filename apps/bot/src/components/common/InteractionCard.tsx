import type { ReactNode } from "react"
import { X } from "lucide-react"

export type InteractionCardTone = "ask" | "login" | "setup" | "connect"

export function InteractionCard({
  tone = "ask",
  icon,
  title,
  subtitle,
  children,
  actions,
  onDismiss,
  dismissLabel = "關閉",
  testId,
  extraClassName,
}: {
  tone?: InteractionCardTone
  icon: ReactNode
  title: string
  subtitle?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
  dismissLabel?: string
  testId?: string
  extraClassName?: string
}) {
  return (
    <section
      className={`interaction-card interaction-card--${tone}${extraClassName ? ` ${extraClassName}` : ""}`}
      data-testid={testId}
      data-tone={tone}
      role="region"
      aria-label={title}
    >
      <header className="interaction-card-header">
        <div className="interaction-card-title">
          <span className="interaction-card-icon">{icon}</span>
          <span>
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </span>
        </div>
        {onDismiss ? (
          <button type="button" className="icon-button" aria-label={dismissLabel} onClick={onDismiss}>
            <X size={16} />
          </button>
        ) : null}
      </header>
      {children ? <div className="interaction-card-body">{children}</div> : null}
      {actions ? <div className="interaction-card-actions">{actions}</div> : null}
    </section>
  )
}
