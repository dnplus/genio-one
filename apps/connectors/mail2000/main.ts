import { createConnectorHost } from "../host"
import { createMail2000Handler } from "./server"
import { createMail2000Imap } from "./imap"
import { createMail2000Dav } from "./dav"
import { mail2000DavSettings } from "./site"
import { createMail2000Smtp } from "./smtp"

const server = Bun.serve({
  hostname: process.env.CONNECTOR_HOST ?? "127.0.0.1",
  port: Number(process.env.CONNECTOR_PORT ?? 58111),
  fetch: createConnectorHost({
    kind: "mail2000",
    configurationKey: process.env.GENIO_CONNECTOR_CONFIGURATION_KEY ?? "",
    discoveryHandler: createMail2000Handler(),
    configuredHandler(configuration) {
      if (configuration.kind !== "mail2000") throw new Error("CONNECTOR_KIND_MISMATCH")
      const dav = mail2000DavSettings(configuration)
      return createMail2000Handler({
        ...createMail2000Imap({ host: configuration.imap_host, port: configuration.imap_port }),
        sendMail: createMail2000Smtp({ host: configuration.smtp_host, port: configuration.smtp_port }),
        ...(dav.caldav_url ? { caldav: createMail2000Dav({ url: dav.caldav_url, kind: "caldav" }) } : {}),
        ...(dav.carddav_url ? { carddav: createMail2000Dav({ url: dav.carddav_url, kind: "carddav" }) } : {}),
      })
    },
  }),
})
console.info(JSON.stringify({ event: "connector.started", service: "mail2000", port: server.port }))
