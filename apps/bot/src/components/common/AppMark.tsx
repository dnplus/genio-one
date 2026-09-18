import { BloubAvatar } from "../../avatar/bloub-avatar"
import type { BotProfile } from "../../bots-storage"
import type { StateId } from "../../vendor/bloub/bot/states"

/** Status poses that replace the blob with a glyph (e.g. !). Never use as identity. */
export function identityAvatarState(state?: StateId): StateId {
  if (!state || state === "alert" || state === "exclaim") return "idle"
  return state
}

export function AppMark({
  profile,
  small = false,
  animated = true,
  state = "idle",
}: {
  profile?: BotProfile | null
  small?: boolean
  animated?: boolean
  state?: StateId
}) {
  const pose = identityAvatarState(state)
  return (
    <span className={small ? "app-mark app-mark--small" : "app-mark"} data-agent-state={pose}>
      <BloubAvatar
        value={profile?.avatar}
        label={profile?.name ? `${profile.name} 的頭像` : "Genio Bot 頭像"}
        animated={animated}
        state={pose}
      />
    </span>
  )
}
