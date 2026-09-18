export function mail2000DavSettings(configuration: { imap_host: string; caldav_url?: string; carddav_url?: string }) {
  const standard = configuration.imap_host.toLowerCase() === "mail.gss.com.tw"
  return {
    caldav_url: configuration.caldav_url || (standard ? "https://mail.gss.com.tw/cgi-bin/cal/caldav/calendars/{username}/default" : undefined),
    carddav_url: configuration.carddav_url || (standard ? "https://mail.gss.com.tw/cgi-bin/carddav/principals/mPA.000@gss.com.tw" : undefined),
  }
}
