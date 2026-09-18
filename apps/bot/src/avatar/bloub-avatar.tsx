import { useEffect, useId, useRef, useState } from "react"

import { blockAt, defaultCycle } from "../vendor/bloub/bot/cycles"
import { NOTIF_BLUE } from "../vendor/bloub/bot/decor"
import { BotEngine, type BotFrame } from "../vendor/bloub/bot/engine"
import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID, type ExpressionId } from "../vendor/bloub/bot/expressions"
import { DEMI_VIEWBOX, RAYON } from "../vendor/bloub/bot/repere"
import { COLOR_BY_ID, DEFAULT_COLOR, DEFAULT_SHAPE, SHAPE_BY_ID, mixHex, type ColorId, type ShapeId } from "../vendor/bloub/bot/skins"
import type { StateId } from "../vendor/bloub/bot/states"
import { lookTarget } from "../vendor/bloub/ui/gaze"

export interface BloubAvatarValue {
  shape: ShapeId
  color: ColorId
  expression: ExpressionId
}

export const DEFAULT_BLOUB_AVATAR: BloubAvatarValue = { shape: DEFAULT_SHAPE, color: DEFAULT_COLOR, expression: DEFAULT_EXPRESSION }

const shapeIds = new Set(SHAPE_BY_ID.keys())
const colorIds = new Set(COLOR_BY_ID.keys())
const expressionIds = new Set(EXPRESSION_BY_ID.keys())

export function isBloubAvatarValue(value: unknown): value is BloubAvatarValue {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<BloubAvatarValue>
  return typeof candidate.shape === "string" && shapeIds.has(candidate.shape)
    && typeof candidate.color === "string" && colorIds.has(candidate.color)
    && typeof candidate.expression === "string" && expressionIds.has(candidate.expression)
}

function initialFrame(value: BloubAvatarValue) {
  const engine = new BotEngine(
    RAYON,
    "idle",
    SHAPE_BY_ID.get(value.shape)?.radii ?? null,
    EXPRESSION_BY_ID.get(value.expression) ?? null,
  )
  return { engine, frame: engine.sample(0) }
}

export function BloubAvatar({ value = DEFAULT_BLOUB_AVATAR, label = "Bot 頭像", animated = true, state, paper = "#ffffff" }: {
  value?: BloubAvatarValue
  label?: string
  animated?: boolean
  state?: StateId
  paper?: string
}) {
  const instanceId = useId().replaceAll(":", "")
  const maskId = `bloub-mask-${instanceId}`
  const engineRef = useRef<BotEngine | null>(null)
  const first = useRef<{ engine: BotEngine; frame: BotFrame } | null>(null)
  if (!first.current) first.current = initialFrame(value)
  if (!engineRef.current) engineRef.current = first.current.engine
  const [frame, setFrame] = useState(first.current.frame)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const ink = COLOR_BY_ID.get(value.color)?.hex ?? COLOR_BY_ID.get(DEFAULT_COLOR)!.hex

  useEffect(() => {
    if (!animated) {
      const engine = new BotEngine(
        RAYON,
        state || "idle",
        SHAPE_BY_ID.get(value.shape)?.radii ?? null,
        EXPRESSION_BY_ID.get(value.expression) ?? null,
      )
      engineRef.current = engine
      setFrame(engine.sample(1.0))
      return
    }
    const engine = engineRef.current!
    const now = performance.now() / 1000
    engine.setShape(SHAPE_BY_ID.get(value.shape)?.radii ?? null, now)
    setFrame(engine.sample(now))
  }, [value.shape, animated])

  useEffect(() => {
    if (!animated) return
    const engine = engineRef.current!
    const now = performance.now() / 1000
    engine.setExpression(EXPRESSION_BY_ID.get(value.expression) ?? null, now)
    setFrame(engine.sample(now))
  }, [value.expression, animated])

  useEffect(() => {
    if (!animated || !state) return
    const engine = engineRef.current!
    const now = performance.now() / 1000
    engine.setState(state, now)
    setFrame(engine.sample(now))
  }, [state, animated])

  useEffect(() => {
    if (!animated) return
    const engine = engineRef.current!
    const blocks = defaultCycle().blocks
    let animationFrame = 0
    let lastBlock = -1
    const tick = () => {
      const time = performance.now() / 1000
      if (!state) {
        const position = blockAt(blocks, time)
        if (position.index !== lastBlock) {
          engine.setState(blocks[position.index]!.state, time - position.elapsed)
          lastBlock = position.index
        }
      }
      setFrame(engine.sample(time))
      animationFrame = requestAnimationFrame(tick)
    }
    animationFrame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationFrame)
  }, [animated, state])

  useEffect(() => {
    if (!animated) return
    const engine = engineRef.current!
    let lastTime = 0
    let cachedBox: DOMRect | null = null
    let boxTime = 0
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return
      const now = performance.now()
      if (now - lastTime < 32) return
      lastTime = now
      if (!cachedBox || now - boxTime > 1000) {
        cachedBox = svgRef.current?.getBoundingClientRect() ?? null
        boxTime = now
      }
      if (!cachedBox?.width || !cachedBox.height) return
      const dx = event.clientX - (cachedBox.left + cachedBox.width / 2)
      const dy = event.clientY - (cachedBox.top + cachedBox.height / 2)
      if (Math.abs(dx) > 600 || Math.abs(dy) > 600) return
      engine.setLook(lookTarget({
        nx: Math.max(-1, Math.min(1, dx / Math.max(1, window.innerWidth / 2))),
        ny: Math.max(-1, Math.min(1, dy / Math.max(1, window.innerHeight / 2))),
        tour: 1,
        pointer: true,
      }), now / 1000)
    }
    const leave = () => {
      cachedBox = null
      engine.setLook(null, performance.now() / 1000)
    }
    window.addEventListener("pointermove", move, { passive: true })
    document.addEventListener("pointerleave", leave)
    return () => {
      window.removeEventListener("pointermove", move)
      document.removeEventListener("pointerleave", leave)
    }
  }, [animated])

  const dot = (item: BotFrame["dots"][number], index: number, group: string) => {
    const fill = item.color ?? (item.depth === undefined ? ink : mixHex(paper, ink, item.depth))
    if (item.d) {
      return <path key={`${group}-${index}`} d={item.d} transform={`translate(${item.x} ${item.y}) rotate(${item.rot ?? 0}) scale(${RAYON})`} fill={fill} opacity={item.opacity} />
    }
    return <circle key={`${group}-${index}`} cx={item.x} cy={item.y} r={item.r} fill={fill} opacity={item.opacity} />
  }

  return (
    <svg ref={svgRef} className="bloub-avatar" viewBox={`${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`} role="img" aria-label={label}>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-DEMI_VIEWBOX} y={-DEMI_VIEWBOX} width={DEMI_VIEWBOX * 2} height={DEMI_VIEWBOX * 2}>
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, index) => <path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />)}
          {frame.notch && <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />}
        </mask>
        {frame.arcs.map((arc) => <linearGradient key={arc.id} id={`${instanceId}-${arc.id}`} gradientUnits="userSpaceOnUse" x1={arc.grad.x1} y1={arc.grad.y1} x2={arc.grad.x2} y2={arc.grad.y2}>
          {arc.grad.stops.map((color, index) => <stop key={index} offset={index / (arc.grad.stops.length - 1)} stopColor={color} />)}
        </linearGradient>)}
      </defs>
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => <path key={`back-${arc.id}`} d={arc.back} stroke={`url(#${instanceId}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}
      </g>
      {frame.dotsBehind && <g>{frame.dots.map((item, index) => dot(item, index, "back"))}</g>}
      <g opacity={frame.bodyAlpha}>
        <path d={frame.bodyPath} fill={paper} />
        <g mask={`url(#${maskId})`}><rect x={-DEMI_VIEWBOX} y={-DEMI_VIEWBOX} width={DEMI_VIEWBOX * 2} height={DEMI_VIEWBOX * 2} fill={ink} /></g>
      </g>
      {!frame.dotsBehind && <g>{frame.dots.map((item, index) => dot(item, index, "front"))}</g>}
      {frame.notif && <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => <path key={`front-${arc.id}`} d={arc.front} stroke={`url(#${instanceId}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}
      </g>
    </svg>
  )
}
