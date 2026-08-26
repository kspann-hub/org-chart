# How the org chart is put together

Written 2026-08-26, after an egress overrun took the site offline. This is the
"why" document: what the pieces are, what Supabase actually holds, what the
thing costs to run, and which decisions are load-bearing.

The other docs cover different ground and are still current:

| Document | What it's for | |
| --- | --- | --- |
| [README.md](README.md) | Setting it up from scratch, and using it day to day | in the repo |
| `HANDOFF.md` | Where the code stood at handoff; gotchas that cost time | **local only** |
| `local-notes/DeployRunbook.md` | The click-by-click first-time install | **local only** |

The last two are deliberately gitignored: they name real employees and admin
addresses, and this repo is public. If you cloned this and they are missing,
that is why — ask whoever runs the chart for a copy.

---

## The shape of it

Three systems. Only one of them is ours to change.

```
   Ajera  --nightly pipeline-->  mart.employees      (someone else's; read-only to us)
                                       |
                                       | read
                                       v
                                  SUPABASE                      GITHUB PAGES
                                  |- org_positions  <---------  the app
                                  |- org_groups         data    (static HTML + JS,
                                  |- org_admins         + auth   no server of ours)
                                  |- org_position_history
                                  '- headshots bucket
```

**There is no backend of ours.** The app is a static bundle on GitHub Pages —
no server, no API layer, nothing to keep running. The browser talks to Supabase
directly, and Supabase's own row-level security is the only thing standing
between a visitor and the data.

That is deliberate, and it is why the security rules live in SQL rather than in
JavaScript: JavaScript that ships to a browser is a suggestion, not a control.
It is also why the repo can be public — nothing in it is a secret. See *Why
it's safe to publish the source* in the README.

---

## What Supabase actually holds

### Tables the app owns

| Table | Rows | What it is |
| --- | --- | --- |
| `org_positions` | ~76 | One row per **seat** (box) on the chart. The chart *is* this table's `parent_id` column. |
| `org_groups` | 3 | The verticals. Each names a seat as its root. |
| `org_admins` | a handful | Who may edit. Not in the repo — inserted by hand. |
| `org_excluded_employees` | few | Ajera rows that are not people. |
| `org_position_history` | grows | Every edit, with enough of the old row to undo it. |

### What it only reads

`mart.employees` is pipeline output from Ajera. **Nothing here ever writes to
it.** The next refresh would silently overwrite anything we put there, and we
would find out weeks later. The app reads it through two views:

- `app.employee_roster` — who counts as a person. No login gate, and it sits in
  a schema the API cannot reach, so it is usable from the SQL Editor.
- `public.employee_directory` — the same thing plus the login gate. This is what
  the app reads.

The split exists because the gate calls `auth.jwt()`, which is null in the SQL
Editor. A seed script reading the gated view would quietly insert nothing at all.

### Storage

One private bucket, `headshots`. Roughly 78 objects, ~20 KB each, WebP, 256px
square. The database stores only the filename; there is no permanent public
address for any photo.

---

## How privacy is enforced

Four independent layers, none of which is JavaScript:

1. **Google sign-in**, restricted to company addresses.
2. **Row-level security** on every table. `org_positions` grants read to
   authenticated company emails and write only to `org_admins`. `anon` is
   revoked outright.
3. **The bucket is private** (`public = false`, verified 2026-08-26).
4. **Signed URLs** — the app mints a short-lived pass per photo. Storage
   policies require a signed-in company address to read, and admin rights to
   upload, replace, or delete.

Worth stating plainly: **an admin's rights are enforced by Postgres, not by
hiding buttons.** The UI declines to offer edits to non-admins as a courtesy;
the database refuses them as the actual control.

---

## Data usage — the part that has cost real money

This section did not exist before, and its absence is why the site went down.

### What happened

| Date | Event |
| --- | --- |
| 2026-08-05 | Project created. Photos uploaded as camera originals — 78 files averaging 724 KB, largest 4.5 MB. |
| through 08-17 | The chart re-downloaded all of them on every load. Roughly 19 GB of egress in a month. |
| 2026-08-17 | Photos shrunk to 256px WebP, originals deleted. **54.5 MB to 0.8 MB** per full load — a 68x cut. |
| 2026-08-26 | Hit the free plan's 5 GB egress ceiling. Project **restricted: every endpoint returned HTTP 402**, app fully dark. |
| 2026-08-26 | Upgraded to Pro. Four further fixes shipped in commit `147d548`. |

The restriction was legacy damage. The billing cycle that began around Aug 5 had
already absorbed twelve days at the pre-fix rate before the shrink landed.

**The lesson, stated once:** on this stack the binding constraint is *egress* —
bytes leaving Supabase — not database size and not user count. A 76-person chart
will never trouble a 500 MB database or a 50,000-user limit. It can absolutely
serve 19 GB of images.

### What actually generates egress

In descending order of how much they mattered:

**1. Photo bytes, multiplied by how often they are re-fetched.** Both halves
matter. Only the first was obvious.

**2. Signed URLs quietly defeat every cache.** A signed URL carries a token in
the address, and both caches that matter key on the *whole* address:

- The **browser** files a cached image under its full URL. The year-long
  `cacheControl` we set therefore only survives while the URL does. Re-mint the
  token and every face looks like a file the browser has never seen.
- The **CDN** fares worse. Each viewer's token differs, so no two employees ever
  request the same address, and one colleague's photo can never be served to the
  next. *Every first view of every face is billed as uncached origin egress.*

The signed-URL lifetime therefore sets how often "first view" comes round again.
At 24 hours that was daily, forever. It is now **7 days**
(`SIGNED_URL_TTL_SECONDS` in [src/lib/photos.ts](src/lib/photos.ts)) — roughly a
sevenfold cut.

**3. Eager loading on the landing page.** `Avatar` uses `<img loading="lazy">`,
so offscreen faces in the tree view cost nothing. The circle chart draws SVG
`<image>`, which has **no lazy-loading option** and sits entirely inside the
viewBox — so the one view everybody lands on fetched every disc immediately.
Photos are now limited to rings 1-2 (`PHOTO_RINGS` in
[src/lib/circle.ts](src/lib/circle.ts)). Ring 3 draws at 13px, where a face is a
smudge, and gets initials instead.

**4. Cache-key mismatches.** The PNG export must set `crossOrigin` to keep the
canvas untainted. Browsers file CORS and non-CORS responses under *separate*
keys, so for months every export re-downloaded every face the chart had just
fetched. Both places now set it identically.

**5. Realtime fan-out.** One event fires per changed row, and the full reload is
three whole-table selects plus an RPC. "Sync with Ajera" rewrites many seats at
once, so a sync ran that entire load once per seat, in every open tab. Bursts now
collapse into a single reload (`REALTIME_SETTLE_MS` in
[src/App.tsx](src/App.tsx), 400 ms).

### What a load costs now

Rough figures, worth re-measuring rather than trusting:

| | Per full chart load |
| --- | --- |
| Headshots, cold, all rings | ~0.8 MB |
| Headshots, landing page (rings 1-2 only) | less than that |
| JSON — seats, directory, groups, admin check | tens of KB |

Headshots dominate everything else by two orders of magnitude. **If usage ever
spikes again, look at images first and JSON second.** JSON is not where the money
goes.

Annualised, the signed-URL change alone moves headshots from roughly 17 GB/year
to roughly 2.4 GB/year.

### Headroom

Now on **Pro**, whose included egress is far above the free plan's 5 GB (250 GB
at the time of writing — confirm under *Settings, then Billing, then Usage*).
With these fixes in place this is no longer close.

**Do this once:** turn on the usage notification under *Settings, then Billing,
then Cost Control*. The first symptom last time was the entire app going dark,
with no warning beforehand. That should never be how we find out again.

---

## Decisions worth knowing, and what they cost

**Ajera owns *who exists*; the chart owns *how it is drawn*.**
`parent_id` seeds from Ajera's supervisor field and is then ours. The initial
tree comes free, but an admin can restructure without waiting on Ajera, and
re-running the seed will not undo their work — it only fills seats with no parent
yet. Per-seat `title_override` exists because one Ajera record can hold five
seats with five different titles; without it those five boxes collapse into
identical ones and the chart stops meaning anything.

**Photos are resized in the browser, not on the server.**
Supabase can do this server-side with Storage Image Transformations, but that is
a paid feature. The chart never displays more than 112px of any photo (44px
avatar, 2x export), so 256px is already generous. Cost: an admin's browser does a
little work on upload. Benefit: 724 KB becomes ~20 KB.

**Signed URLs live 7 days, not 1.**
Chosen 2026-08-26. The tradeoff is real and small: a URL somebody deliberately
forwards outside the company keeps working for a week rather than a day, and it
exposes *that single headshot* — not the chart, not the directory — from a bucket
that stays private. In exchange, photo bandwidth drops roughly sevenfold. Photos
are permanent on the chart either way; expiry only governs how often the app
re-mints in the background, which nobody sees.

**Security lives in SQL, not in the UI.**
Because the app is static and the browser talks to Supabase directly, anything
enforced in JavaScript is enforced nowhere. Every rule that matters is a policy
or a grant.

**The repo is public.**
GitHub Pages requires it on the free plan. That is safe *because* of the point
above — but it is also why `org_admins` is populated by hand rather than
committed, and why no service-role key exists anywhere in the tree. The headshot
backfill runs in an admin's browser for exactly that reason: there is no
credential a Node script could have used.

---

## When something breaks, check these first

**Whole app dark, everything failing.** Check for a billing restriction before
reading any code: *Settings, then Billing, then Usage*. A restricted project
returns HTTP 402 on **every** endpoint — database, auth, and storage alike —
which does not look like a billing problem from inside the browser.

**"No seats yet. Run 02_seed_positions.sql".** Usually a lie. The app bails out
of loading when a request fails and leaves the chart in its blank starting state,
which renders that message — it cannot distinguish "never set up" from "could not
load". **Read the error banner above it and fix that instead.** Do not run the
seed on a chart that already has seats.

**"JWT issued at future".** A stale login token in the browser, typically minted
during a project migration or restart when a clock was briefly off. Sign out and
back in. If that fails, clear site data for the domain.

**Photos vanish but the chart still works.** Look at `crossOrigin` first. It
depends on Supabase returning a CORS header, and it is the only setting that can
hide every photo at once while leaving everything else intact.
