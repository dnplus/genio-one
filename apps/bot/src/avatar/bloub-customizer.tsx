import { BloubAvatar, type BloubAvatarValue } from "./bloub-avatar"
import { EXPRESSIONS } from "../vendor/bloub/bot/expressions"
import { COLORS, SHAPES } from "../vendor/bloub/bot/skins"

const shapeLabels: Record<string, string> = {
  cercle: "圓形",
  galet: "卵石",
  squircle: "方圓",
  capsule: "膠囊",
  triangle: "三角",
  hexagone: "六角",
  nuage: "雲朵",
  goutte: "水滴",
}

const expressionLabels: Record<string, string> = {
  neutre: "自然",
  attentif: "專注",
  surpris: "驚喜",
  excite: "興奮",
  heureux: "開心",
  hilare: "大笑",
  colere: "生氣",
  triste: "難過",
  effraye: "害怕",
  mefiant: "懷疑",
  confus: "困惑",
  curieux: "好奇",
  fier: "自信",
  timide: "害羞",
  blase: "淡定",
  somnolent: "想睡",
}

const colorLabels: Record<string, string> = {
  encre: "墨黑",
  creme: "奶油",
  brun: "棕色",
  rouge: "紅色",
  orange: "橙色",
  ambre: "琥珀",
  vert: "綠色",
  turquoise: "青綠",
  bleu: "藍色",
  violet: "紫色",
  rose: "粉色",
  gris: "灰色",
}

export function BloubCustomizer({ value, onChange }: {
  value: BloubAvatarValue
  onChange(value: BloubAvatarValue): void
}) {
  return (
    <section className="bloub-customizer">
      <div className="avatar-preview"><BloubAvatar value={value} label="目前選擇的 Bot 頭像" state="idle" /></div>
      <div className="customizer-section">
        <h3>形狀</h3>
        <div className="avatar-tile-grid shape-grid">
          {SHAPES.map((shape) => <button type="button" key={shape.id} className={shape.id === value.shape ? "avatar-tile selected" : "avatar-tile"} aria-pressed={shape.id === value.shape} aria-label={shapeLabels[shape.id]} onClick={() => onChange({ ...value, shape: shape.id })}>
            <BloubAvatar value={{ ...value, shape: shape.id }} label={shapeLabels[shape.id]} animated={false} />
            <span>{shapeLabels[shape.id]}</span>
          </button>)}
        </div>
      </div>
      <div className="customizer-section">
        <h3>表情</h3>
        <div className="avatar-tile-grid expression-grid">
          {EXPRESSIONS.map((expression) => <button type="button" key={expression.id} className={expression.id === value.expression ? "avatar-tile selected" : "avatar-tile"} aria-pressed={expression.id === value.expression} aria-label={expressionLabels[expression.id]} onClick={() => onChange({ ...value, expression: expression.id })}>
            <BloubAvatar value={{ ...value, expression: expression.id }} label={expressionLabels[expression.id]} animated={false} />
            <span>{expressionLabels[expression.id]}</span>
          </button>)}
        </div>
      </div>
      <div className="customizer-section color-section">
        <h3>顏色</h3>
        <div className="color-grid">
          {COLORS.map((color) => <button type="button" key={color.id} className={color.id === value.color ? "color-option selected" : "color-option"} aria-pressed={color.id === value.color} aria-label={colorLabels[color.id]} onClick={() => onChange({ ...value, color: color.id })}>
            <span style={{ background: color.hex }} />
          </button>)}
        </div>
      </div>
    </section>
  )
}
