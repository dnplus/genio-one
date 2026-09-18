import { KeyRound } from "lucide-react"

export interface ApprovalRequest {
  id: number
  method: string
  reason: string
  acceptResult: unknown
  declineResult: unknown
}

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: ApprovalRequest
  onDecide: (decision: "accept" | "decline") => void
}) {
  return (
    <div className="approval-bar">
      <KeyRound />
      <span>
        <strong>需要你的確認</strong>
        <small>{approval.reason}</small>
      </span>
      <button type="button" onClick={() => onDecide("decline")}>拒絕</button>
      <button type="button" className="approve" onClick={() => onDecide("accept")}>允許</button>
    </div>
  )
}
