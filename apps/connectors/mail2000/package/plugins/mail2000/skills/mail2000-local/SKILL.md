---
name: mail2000-local
description: Search and read the user's recent Mail2000 mail through the m2k CLI in the runtime workspace. Use for finding mail by keyword, sender, folder or date, listing unread mail, or reading a found message. Not for sending, moving, flagging or deleting mail.
---

# Mail2000 local search

`m2k` keeps a cache of recent mail envelopes (subject, sender, date, flags) in the runtime workspace and searches it locally. It reaches Mail2000 only through the Bot's governed connection; the command never needs or accepts a password or token.

Run it with Node:

```sh
node ~/.genio/plugins/mail2000/bin/m2k.mjs <command>
```

## Workflow

1. Run `status`. If it reports no messages, `stale: true`, or a window shorter than the question needs, run `sync` first. The default window is 14 days; use `--days N` (at most 90) for older mail.
2. Run `search` with the keyword. Matching covers subject and sender, including Chinese; it does not cover the message body.
3. To answer from the content of a message, run `read` with the `folder`, `uid` and `uid_validity` from a search hit.

```sh
node ~/.genio/plugins/mail2000/bin/m2k.mjs sync --days 30
node ~/.genio/plugins/mail2000/bin/m2k.mjs search 國泰 --limit 10
node ~/.genio/plugins/mail2000/bin/m2k.mjs search --from hugh --since 2026-09-01
node ~/.genio/plugins/mail2000/bin/m2k.mjs search --unseen
node ~/.genio/plugins/mail2000/bin/m2k.mjs read Archive 30812 1761997859
```

Every command prints one JSON object. Errors print `{"error": ...}` on stderr and exit non-zero.

## Rules

- Tell the user when results come from a cache marked `stale`, or when `cache.gaps` lists days that had too much mail to cache completely.
- An empty search result only covers the cached window and folders shown in `status`. Say so instead of claiming the mail does not exist.
- For sending, replying, moving, flagging or deleting mail, use the Mail2000 connector tools directly; they require the user's approval. `m2k` cannot perform them.
- `m2k clean` removes the cache. The cache also disappears with the runtime workspace.
