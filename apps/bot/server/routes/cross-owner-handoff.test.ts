import { expect, test } from "bun:test"
import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import { RuntimeBroker } from "../runtime-broker"

test("only target owner can approve a cold cross-owner handoff and result returns to caller", async () => {
  const registry = new BotRegistry(":memory:")

  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const owner = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = { ...owner, subject_id: "caller" }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes('/v1/identity/session')) return new Response(JSON.stringify(new Headers(init?.headers).get('authorization') === 'Bearer owner-token' ? owner : caller), { headers: { 'content-type':'application/json' } })
    return new Response('not found',{status:404})
  }) as typeof fetch
  let starts=0
  const app = await createBotApp({ botRegistry:registry, runtimeBroker:broker, createCodexRuntime: (_token, events) => ({
    async send(line) {
      const request=JSON.parse(line)
      if(request.method==='initialize')events.onMessage(JSON.stringify({id:request.id,result:{}}))
      if(request.method==='thread/start')events.onMessage(JSON.stringify({id:request.id,result:{thread:{id:'target-thread'}}}))
      if(request.method==='turn/start') {
        starts++
        events.onMessage(JSON.stringify({id:request.id,result:{turn:{id:'target-turn'}}}))
        events.onMessage(JSON.stringify({method:'turn/completed',params:{threadId:'target-thread',turn:{id:'target-turn',status:'completed',items:[{type:'agentMessage',id:'result',text:'Owner approved result'}]}}}))
      }
    }, async close() {},
  }) })
  try {
    const a=registry.create(caller,{name:'Caller',description:'Origin'})
    const b=registry.create(owner,{name:'Shared',description:'Target'})
    registry.update(b.id,owner,{sharePolicy:{visibility:'ORG',discoverable:true,invocable:true,approval:'ALWAYS_ASK',audienceIds:[]}})
    const created=await app.inject({method:'POST',url:'/api/bot-handoffs',headers:{authorization:'Bearer caller-token'},payload:{fromBotId:a.id,toBotId:b.id,fact:'Read-only cross-owner test'}})
    expect(created.statusCode).toBe(201)
    const id=created.json().invocationId
    expect(registry.getInvocationForService(id)?.state).toBe('PENDING')
    expect(starts).toBe(0)
    const rejected=await app.inject({method:'POST',url:`/api/bot-invocations/${id}/decision`,headers:{authorization:'Bearer caller-token'},payload:{decision:'APPROVE'}})
    expect(rejected.statusCode).toBe(400)
    expect(registry.getInvocationForService(id)?.state).toBe('PENDING')
    const accepted=await app.inject({method:'POST',url:`/api/bot-invocations/${id}/decision`,headers:{authorization:'Bearer owner-token'},payload:{decision:'APPROVE'}})
    expect(accepted.statusCode).toBe(200)
    for(let i=0;i<50&&registry.getInvocationForService(id)?.state!=='COMPLETED';i++)await new Promise(resolve=>setTimeout(resolve,2))
    expect(registry.getInvocationForService(id)?.state).toBe('COMPLETED')
    expect(starts).toBe(1)
    expect(registry.continuations.pending()[0]?.bot_id).toBe(a.id)
    expect(registry.continuations.pending()[0]?.owner_id).toBe(caller.subject_id)
    await app.inject({method:'POST',url:`/api/bot-invocations/${id}/decision`,headers:{authorization:'Bearer owner-token'},payload:{decision:'APPROVE'}})
    expect(starts).toBe(1)
    expect(registry.continuations.pending()).toHaveLength(1)
  } finally { await broker.close(); await app.close();  registry.close(); globalThis.fetch=originalFetch }
})
