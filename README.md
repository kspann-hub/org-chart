# Org Chart

A company org chart. Everyone signs in with their Google Workspace account and
sees it; a short list of admins can edit it. Data comes from Supabase — the
roster from `mart.employees` (built by the Ajera pipeline), the chart's shape
from a table this app owns.

Static site, no server. Hosting is GitHub Pages, database is Supabase. Both
free at this size.

---

## The one design decision worth understanding

**Nothing here ever writes to `mart.employees`.**

That table is pipeline output. The next refresh from Ajera would overwrite
anything you put there, silently, and you'd find out weeks later when someone
noticed the chart had reverted.

So the app owns a separate table, `public.org_positions`. One row per *seat*
(box) on the chart. A seat points at a person via `employee_key`
(= `ajera_employee_key`), and holds the things Ajera doesn't know about:

| Column | What it's for |
| --- | --- |
| `parent_id` | Who this seat reports to. This is the chart. |
| `employee_key` | Which Ajera person sits here. `null` = a vacant seat. |
| `name_override` | Display name. `null` = use the Ajera legal name. |
| `title_override` | Display title. `null` = use the Ajera title. |
| `sort_order` | Left-to-right order among siblings. |

`parent_id` is seeded from Ajera's `supervisor_employee_key` and then owned by
the chart. That split is the point: the initial tree comes free, but an admin
can restructure it without needing Ajera changed first, and re-running the
seed won't undo their work — it only fills in seats that have no parent yet.

The overrides matter more than they look:

- Ajera says `Samuel Murphy`; the chart should say `Sam Murphy`.
- Ajera stores **one** title per person, but people hold **several seats**.
  Logan Smith is one Ajera record with one title, and five boxes on the chart
  with five different titles. Without per-seat overrides those five boxes
  collapse into five identical ones and the chart stops meaning anything.

Ajera stays the source of truth for *who exists*. The chart owns *how it's
drawn*. Neither overwrites the other.

---

## Setup

### 1. Database

In the Supabase dashboard → **SQL Editor** → New query:

1. Run [`supabase/01_schema.sql`](supabase/01_schema.sql). The admin list is
   near the top — currently `kspann`, `arclabs` and `fsalinas`. Keyed by
   email, so you can grant admin to someone who has never logged in, and
   change it later with a one-line `insert` / `delete`, no redeploy.
2. Run **STEP 1** of [`supabase/02_seed_positions.sql`](supabase/02_seed_positions.sql)
   and read the output. Six health checks on the Ajera data, ending with the
   tree as Ajera sees it, indented. Fix anything surprising before continuing —
   it's much easier now than after the chart exists.
3. Run **STEP 2** and **STEP 3**. Because `mart.employees` has
   `supervisor_employee_key`, the entire reporting tree builds itself; you
   aren't dragging 76 boxes into place. STEP 4 prints the result to compare.

There is no connection string to configure for any of this. The SQL Editor is
already connected to your database as `postgres`, which is why it can see
`mart` and create things in `public`. The `.env` file in step 3 below is only
for the *browser app*, which connects over HTTPS as an anonymous user.

**Two views, on purpose.** `app.employee_roster` defines who counts as a
person; `public.employee_directory` is that plus the login gate. The gate
calls `auth.jwt()`, which is null in the SQL Editor — so a seed script reading
the gated view would return zero rows and silently insert nothing. Anything
you run by hand should read `app.employee_roster`. The `app` schema isn't
exposed over the API, so it can't leak.

**Rows that aren't people.** Ajera's employee table carries records that exist
for accounting reasons — `ajera_employee_key` 206 is *Stambaugh Ness*, a
consulting firm. Active, no supervisor, so it would sit at the top of your
chart as a box. It's listed in `public.org_excluded_employees`. Numeric-name
junk (key 23 is called `8493`) is filtered by pattern and needs no entry. The
last query in STEP 6 finds new candidates: active, no title, no supervisor.

### 2. Auth — Sign in with Google

Everyone signs in with their Google Workspace account. One click, no email
involved. That matters more than convenience: Supabase's built-in email sender
is capped at a couple of messages per hour, and Google Workspace blocks App
Passwords by default, so the magic-link route needs either admin access or a
third-party mail provider. Google OAuth needs neither.

The app still offers *Use an email link instead* as a fallback. It works the
moment you configure SMTP under **Project Settings → Auth → SMTP**, and does
nothing useful until then. Google is the path.

#### Create the Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com) — this is separate
from the Workspace admin console, and you don't need to be a Workspace admin:

1. Create a project (any name).
2. **APIs & Services → OAuth consent screen.** Choose **Internal** if it's
   offered — that restricts sign-in to `criticalarccx.com` accounts at
   Google's end and skips app verification entirely. If only **External** is
   available, that's fine too: this app requests just email and profile, which
   are non-sensitive scopes and need no verification review.
   Fill in app name, support email, developer email.
3. **Credentials → Create Credentials → OAuth client ID → Web application.**
4. Under *Authorized redirect URIs*, add exactly one entry — Supabase's
   callback, not your app's URL:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   The project ref is the subdomain in your Project URL.
5. Copy the **Client ID** and **Client secret**.

#### Wire it into Supabase

**Authentication → Sign In / Providers → Google**: enable it, paste the client
ID and secret, save.

**Authentication → URL Configuration**: set *Site URL*, and add both of these
under *Redirect URLs*. Without them the sign-in completes and then dumps
people somewhere that isn't the app:

```
http://localhost:5173/org-chart/
https://<your-github-username>.github.io/org-chart/
```

#### What stops a personal Gmail account

Three layers, and only the last one actually matters:

- The app passes Google's `hd` hint so the account chooser prefers company
  accounts. A hint, not a restriction.
- If someone signs in with a personal account anyway, the app shows a *Wrong
  account* screen rather than an empty chart.
- RLS returns them nothing regardless, because `public.org_email_allowed()`
  checks the email domain on every read. This is the one doing the work; the
  other two exist so the failure is legible instead of confusing.

If your Workspace admin has restricted third-party app access (Admin console →
Security → API controls), the OAuth client may need allow-listing before
anyone can sign in. You'll know because sign-in fails with an admin-policy
error rather than a consent screen.

### 2b. Groups and photos

Two things to do, in this order:

1. **Storage → New bucket** → name it `headshots` → **Public bucket OFF** →
   Create. Private is the point: photos are served as short-lived signed URLs,
   so they're unreadable to anyone not signed in.
2. Run [`supabase/03_groups_and_photos.sql`](supabase/03_groups_and_photos.sql).
   Read STEP 4a's output before running 4b — it shows which seat each of the
   three leads resolves to.

**Groups are the verticals on the landing page.** A group is defined by one
seat, its root, and membership is *nearest group-root ancestor* — not
"everything underneath". That distinction is the whole design:

```
Justin Harder  (President)      <- group root: Business Operations
├── Accounting Manager               -> Business Operations
├── HR Manager                       -> Business Operations
│   └── Lead Recruiter               -> Business Operations
├── Logan Smith (VP Ops)        <- group root: Project Operations
│   └── Operations Manager           -> Project Operations, NOT Business Ops
└── Brian Agosta (VP Delivery)  <- group root: Project Delivery
```

A plain subtree rule would put all 76 people in Justin's group, since he's the
top of the company. Walking up to the *nearest* root instead leaves his card
holding the business-overhead people specifically, and the three groups tile
the org — every seat in exactly one, and the sizes sum to the headcount.

**Why the seed matches by depth, not just name.** Logan Smith holds five seats
and Justin Harder two. `distinct on (person) ... order by depth` picks each
person's highest seat, which is the VP/President one. Matching on name alone
would be a coin-flip between "VP - Operations" and "Operations Manager -
Aviation".

To add or change a vertical later, do it in the app rather than in SQL: open
the full chart, click the seat, tick **Start a group here**, name it, pick a
colour. Unticking removes the group and its people fold back into the
enclosing one.

### 3. Point the app at your project

The app needs exactly two values, and they go in a file called `.env` in this
folder. It's gitignored, so it never leaves your machine.

```bash
cp .env.example .env
```

Then fill in both lines from the Supabase dashboard:

| `.env` key | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | **Project Settings → Data API → Project URL**. Looks like `https://abcdefgh.supabase.co`. |
| `VITE_SUPABASE_ANON_KEY` | **Project Settings → API Keys**. Take the one labelled **anon / public** (newer projects call it **publishable**, `sb_publishable_…`). |

**Not** the `service_role` / `secret` key. That one bypasses Row Level
Security entirely, and this bundle is served to every browser in the company.
If it ever lands in `.env`, rotate it on that same page.

```bash
npm install
npm run dev
```

Open the printed URL. You should get the sign-in screen; enter your company
address and follow the emailed link.

### 4. Deploy

```bash
git init -b main
git add .
git commit -m "Org chart"
gh repo create org-chart --public --source=. --push
```

Then, in the new repo on github.com:

- **Settings → Pages → Source**: select **GitHub Actions**.
- **Settings → Secrets and variables → Actions → New repository secret**, twice
  — same two values as `.env`, because `.env` isn't committed and the build
  runner needs them:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

Push to `main` and the workflow in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds and
publishes to `https://<username>.github.io/org-chart/`.

If you name the repo something other than `org-chart`, the workflow picks the
base path up from the repo name automatically — but update `vite.config.ts`'s
fallback so local `npm run dev` matches.

---

## Why it's safe to publish the source

GitHub Pages requires a public repo on the free plan, so the code is world
readable. The data isn't:

- The **anon key** in the bundle is designed to be public. It identifies the
  project, it doesn't authorise anything.
- Every table has **Row Level Security** on. Unauthenticated requests match no
  policy and get zero rows — not an error, just nothing.
- Reads require a logged-in `@criticalarccx.com` address
  (`public.org_email_allowed()`). Someone who signs in with a personal Google
  account gets a valid session and no rows at all — the app shows them a
  *Wrong account* screen rather than an empty chart.
- Writes require membership in `public.org_admins`
  (`public.is_org_admin()`). This is enforced in Postgres, not in the UI.
  Hiding the edit buttons is cosmetic — the database is what actually refuses.
- `mart` is never exposed to the API, and neither is the `app` schema. Only
  `public.employee_directory` is, and it publishes eight columns — name,
  title, employment status, email, employee type, the supervisor flag, and
  the two keys. Whatever else lands in the mart later stays invisible unless
  someone deliberately adds it to `app.employee_roster`.

The one thing to keep doing: **no employee data in the repo.** `local-notes/`
and `*.csv` / `*.xlsx` are gitignored for that reason. Your old
`linktoAjera.sql` had real names and titles in it and now lives in
`local-notes/`.

To sanity check that RLS is really on, open the site in a private window and
watch the network tab before signing in — every query should come back `[]`.

---

## Using it

**The landing page** is the whole firm as one circle — every seat at once, no
scrolling. Nothing sits at the centre except the firm itself: the verticals are
peers, and putting the President in the middle would say the opposite. Each
vertical owns a wedge sized by its headcount, its lead sits on the leadership
ring, and depth inside the vertical becomes distance from the middle
(*Leadership → Account managers → Project managers → Project teams*, renamable
in `RING_NAMES` in [`src/lib/circle.ts`](src/lib/circle.ts)).

- **Hover anyone** to light their line back to their vertical's lead, plus
  their own direct reports. Click to keep it; the panel names their ring and
  counts what's under them.
- **Open a vertical** from the buttons beside the circle, or by clicking its
  coloured band. That's where the tree views live — the circle answers "what
  does this place look like", the tree answers "who reports to whom".
- **Teams** folds the outer rings away. Nobody moves when it does: the wedges
  are pinned by headcount, so folding isn't a re-layout.
- Headshots show on the inner three rings — largest for the leads, smallest for
  project managers — using the same private-bucket signed URLs the boxes use,
  with initials underneath when a seat has no photo or its URL has expired. The
  outer rings are dots; a face wouldn't read at that size.
- A branch deeper than four levels grows a fifth ring rather than being
  flattened into the fourth, and seats belonging to no vertical get their own
  wedge instead of vanishing from a page that claims to show everyone.

**Everyone**

- **Find me** jumps to your own box, which is also outlined and tagged *You*.
  This works by matching your login address against Ajera's `employee_email`,
  so it quietly does nothing for anyone whose Ajera email doesn't match the
  address they sign in with.
- Search by name, title or email. It also searches the Ajera legal name, so
  looking up "Samuel" still finds the box that displays "Sam". Enter jumps to
  the first match.
- Scroll to zoom, drag the background to pan, **Fit** to see the whole thing.
- The `−` / `+N` bubble on a box collapses or expands that branch.
- **Top-down / Left-to-right** switches orientation, remembered per browser.
  Left-to-right is the default because a 76-person top-down tree is roughly
  18,000px wide — depth becomes width (four or five columns whatever the
  headcount) and headcount becomes height, which scrolls naturally.
- **↓ PNG** downloads the current view as an image, including whatever is
  collapsed and whichever orientation you're in. It's drawn from the layout
  data onto a canvas at 2× rather than screenshotting the page, so it stays
  sharp when scaled into a deck. A headshot that fails CORS is skipped and
  that card falls back to initials rather than failing the export.
- **Print** produces a clean copy with the UI chrome stripped out.

**Admins** (an `Admin` chip appears in the header)

- **Drag a box onto another** to change who it reports to. Dropping on empty
  canvas moves it to the top level. Boxes you can't legally drop on — the
  dragged seat's own reports — dim out.
- **Click a box** to open the edit panel: swap the person, override the
  displayed name or title, hide the title, delete the seat. The panel also
  shows the person's Ajera email and employee type.
- **Not on the chart** lists active Ajera people with no box, which is your
  new-hire queue. Select the box they should report to first, then hit *Add*.
- Deleting a manager **promotes their reports one level** rather than deleting
  the branch.

---

## Things the database refuses to do

Worth knowing, because these surface as errors rather than as silent damage:

- **Cycles.** A trigger rejects any move that would make a seat report to
  itself through a chain. The UI also greys out those drop targets, so you
  should never hit it.
- **Orphaning a branch.** `parent_id` is `ON DELETE RESTRICT`. Deleting a
  manager without re-parenting their reports first fails outright. The app
  re-parents first; a stray SQL `DELETE` will get an error, which is the point.
- **Non-admin writes.** Refused by RLS with no rows affected.

---

## Recurring maintenance

**STEP 6** of [`supabase/02_seed_positions.sql`](supabase/02_seed_positions.sql)
has four queries worth re-running when something looks off:

- Active people with no seat — new hires. Also in the app's tray. To add a
  batch, re-run STEP 2 and STEP 3: they're idempotent, and STEP 3 only fills
  in seats with no parent, so hand-arranging survives.
- Seats whose person has left, with a count of their direct reports.
- Titles where the chart deliberately disagrees with Ajera.
- Duplicate names in the roster.

None of it is automatic, on purpose. A termination in Ajera shouldn't silently
delete a manager out from under their reports while someone's looking at the
chart — it gets flagged amber with *Not active in Ajera* on the box, and an
admin decides.

---

## Cost

| | |
| --- | --- |
| GitHub Pages | Free (public repo) |
| Supabase free tier | Free — 500 MB database, 50k monthly active users |
| **Total** | **$0** |

A 76-person chart is nowhere near any of those limits. The realistic reason to
ever pay is Supabase pausing a project after a week of zero activity on the
free tier, which un-pauses from the dashboard.
